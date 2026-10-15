/*
 * Replays a debug recording made in the browser (Recorder / the demo's
 * "Download recording" button) through stereo calibration, printing
 * diagnostics. Skipped unless a recording is given:
 *
 *   npm run replay -- recordings/webhands-calibrate-….json
 */
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { MultiViewHandTracker, type ViewSource } from '../src/backends/multiview';
import type { Intrinsics } from '../src/intrinsics';
import { decodeHandedness } from '../src/remote/protocol';
import type { HandFrameListener, Hand3D } from '../src/types';
import { recordedSamples, type Recording, type RecordedView } from '../src/debug/recorder';
import { median } from '../src/geometry/numeric';
import { defaultIntrinsics } from '../src/intrinsics';
import { calibrateStereo, type StereoCalibration, type StereoDiagnostics } from '../src/stereo/calibrate';

const path = process.env.WEBHANDS_RECORDING;
/** WEBHANDS_REPLAY_FOV=default replays with today's default intrinsics instead of the recorded ones. */
const useDefaultFov = process.env.WEBHANDS_REPLAY_FOV === 'default';

const pct = (values: number[], p: number) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.floor(p * (s.length - 1))] : NaN;
};
const deg = (R: ArrayLike<number>) => (Math.acos(Math.min(1, Math.max(-1, (R[0] + R[4] + R[8] - 1) / 2))) * 180) / Math.PI;
const fmt = (c: StereoCalibration | null | undefined) =>
  c
    ? `baseline ${(Math.hypot(...c.t) * 100).toFixed(1)} cm, rotation ${deg(c.R).toFixed(1)}°, offset ${c.timeOffsetMs} ms, ` +
      `epipolar ${c.rmsPx.toFixed(2)} px, inliers ${(c.inlierRatio * 100).toFixed(0)} %, ${c.frames} hand-frames, scale from ${c.scaleFrom}` +
      (c.warning ? `\n                 WARNING ${c.warning}` : '')
    : 'none';

function describeView(v: RecordedView): string[] {
  const intervals = v.frames.slice(1).map((f, i) => f.t - v.frames[i].t);
  const delays = v.frames.map((f) => f.at - f.t);
  const counts = [0, 0, 0];
  const labels = { L: 0, R: 0 };
  for (const f of v.frames) {
    counts[Math.min(2, f.hands.length)]++;
    for (const h of f.hands) labels[h.h]++;
  }
  const k = v.intrinsics;
  return [
    `camera ${v.index} "${v.label}" (${v.cameraId.slice(0, 40)})`,
    `  ${v.frames.length} frames, ${(1000 / (median(intervals) || NaN)).toFixed(1)} fps (interval p90 ${pct(intervals, 0.9).toFixed(0)} ms), ` +
      `arrival delay median ${median(delays).toFixed(0)} / p90 ${pct(delays, 0.9).toFixed(0)} ms`,
    `  frames with 0 / 1 / 2 hands: ${counts.join(' / ')}; labels L ${labels.L}, R ${labels.R}`,
    k
      ? `  intrinsics ${k.width}×${k.height}, fx ${k.fx.toFixed(0)} (FOV ${((360 / Math.PI) * Math.atan(k.width / 2 / k.fx)).toFixed(1)}°)`
      : '  no intrinsics',
    `  hand scale ${v.handScale.toFixed(3)}; skeleton ${Object.keys(v.skeletons).join(', ') || 'none'}`,
  ];
}

describe.skipIf(!path)('replay recording', () => {
  it('re-runs stereo calibration and tracking with diagnostics', async () => {
    const rec = JSON.parse(readFileSync(path!, 'utf8')) as Recording;
    if (useDefaultFov) {
      for (const v of rec.views) if (v.intrinsics) v.intrinsics = defaultIntrinsics(v.intrinsics.width, v.intrinsics.height);
    }
    const out: string[] = [
      `${rec.note || 'recording'} at ${rec.createdAt}, ${(rec.durationMs / 1000).toFixed(1)} s, ${rec.views.length} cameras`,
      `browser: ${rec.userAgent}`,
    ];
    for (const v of rec.views) out.push(...describeView(v));
    if (rec.extra) out.push(`recorded result: ${JSON.stringify(rec.extra).slice(0, 600)}`);

    const v0 = rec.views[0];
    for (const vi of rec.views.slice(1)) {
      out.push('', `pair 0 ↔ ${vi.index}`);
      out.push(`  before:        ${fmt(rec.calibrationsBefore[vi.index])}`);
      out.push(`  browser got:   ${fmt(rec.calibrationsAfter[vi.index])}`);
      if (!v0.intrinsics || !vi.intrinsics) {
        out.push('  missing intrinsics');
        continue;
      }
      let d: StereoDiagnostics | undefined;
      let r = 12345;
      const random = () => ((r = (r * 16807) % 2147483647) - 1) / 2147483646;
      try {
        const cal = calibrateStereo(
          {
            samples0: recordedSamples(v0),
            samples1: recordedSamples(vi),
            k0: v0.intrinsics,
            k1: vi.intrinsics,
            skeletonLengths: { Left: v0.skeletons.Left?.lengths, Right: v0.skeletons.Right?.lengths },
            handScale: v0.handScale,
          },
          { random, onDiagnostics: (x) => (d = x) },
        );
        out.push(`  replay:        ${fmt(cal)}`);
        out.push(`  R = [${cal.R.map((x) => x.toFixed(3)).join(', ')}], t = [${cal.t.map((x) => x.toFixed(3)).join(', ')}] m`);
      } catch (e) {
        out.push(`  replay failed: ${e instanceof Error ? e.message : e}`);
      }
      if (d) {
        out.push(
          `  hand length ${d.handPx.toFixed(0)} px → inlier threshold ${d.thresholdPx.toFixed(1)} px`,
          `  initial pose (offset 0): median ${d.initialPx.toFixed(2)} px; final: median ${d.finalPx.toFixed(2)} px, ` +
            `inliers ${d.finalInliers} of ${d.correspondences}`,
          `  offset search (offset: median px): ${d.coarse.map((c) => `${c.offset}:${c.sampsonPx.toFixed(1)}`).join(' ')}`,
          `  fine (offset: spread / median px): ${d.fine.map((c) => `${c.offset}:${c.spread.toFixed(3)}/${c.sampsonPx.toFixed(2)}`).join(' ')}`,
          `  chosen offset ${d.chosenOffsetMs} ms; hand-frames paired: ${d.singleHandPairs} single-hand, ${d.totalPairs} total`,
          `  scale ratios (true/triangulated bone): n ${d.scaleRatios.count}, q25 ${d.scaleRatios.q25.toFixed(3)}, ` +
            `median ${d.scaleRatios.median.toFixed(3)}, q75 ${d.scaleRatios.q75.toFixed(3)}`,
        );
      }
    }
    out.push('', ...(await replayTracking(rec)));
    console.log(out.join('\n'));
  });
});

class ReplaySource implements ViewSource {
  private listeners = new Set<HandFrameListener>();
  constructor(
    public intrinsics: Intrinsics,
    public cameraId: string,
    public handScale: number,
    public skeletons: ViewSource['skeletons'],
  ) {}
  async start() {}
  stop() {}
  onFrame(l: HandFrameListener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(hands: Hand3D[], t: number) {
    for (const l of this.listeners) l(hands, t);
  }
}

/**
 * Feed the recorded frames, in arrival order, through MultiViewHandTracker with
 * the camera poses the session had, and report where each output hand came from.
 */
async function replayTracking(rec: Recording): Promise<string[]> {
  const calibrations = rec.calibrationsBefore.some(Boolean) ? rec.calibrationsBefore : rec.calibrationsAfter;
  if (!calibrations.some(Boolean)) return ['tracking replay: no camera poses in the recording'];
  const lines = [`tracking replay with the session's camera poses (${rec.calibrationsBefore.some(Boolean) ? 'at start' : 'at end'} of recording):`];
  for (const maxPx of [12, Infinity]) {
    let clock = 0;
    const sources = rec.views.map((v) => new ReplaySource(v.intrinsics!, v.cameraId, v.handScale, v.skeletons));
    const tracker = new MultiViewHandTracker(sources, {
      calibrations,
      smoothing: false,
      refineSkeleton: false,
      maxReprojectionPx: maxPx,
      now: () => clock,
    });
    await tracker.start();
    const output: Hand3D[] = [];
    tracker.onFrame((hands) => output.push(...hands));
    const events = rec.views.flatMap((v, i) => v.frames.map((f) => ({ i, f }))).sort((a, b) => a.f.at - b.f.at);
    for (const { i, f } of events) {
      clock = f.at;
      sources[i].emit(
        f.hands.map((h) => ({
          handedness: decodeHandedness(h.h),
          joints: new Float32Array(63),
          confidence: h.c,
          timestamp: f.t,
          debug: { landmarks2d: Float32Array.from(h.uv), worldLandmarks: Float32Array.from(h.w) },
        })),
        f.t,
      );
    }
    tracker.stop();
    const counts = new Map<string, number>();
    for (const h of output) {
      const key = `${h.handedness} ${h.debug?.source === 'stereo' ? `cameras ${h.debug.views?.join('+')}` : h.debug?.source}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const errs = output.filter((h) => h.debug?.source === 'stereo').map((h) => h.debug!.reprojectionError!);
    lines.push(
      `  max error ${maxPx} px: ${[...counts].map(([k, v]) => `${k}: ${v}`).join(', ') || 'no hands'}` +
        (errs.length ? `; triangulation error median ${median(errs).toFixed(1)} / p90 ${pct(errs, 0.9).toFixed(1)} px` : ''),
    );
  }
  // Label agreement where each camera sees exactly one hand at about the same time.
  for (const v of rec.views.slice(1)) {
    const cal = calibrations[v.index];
    if (!cal) {
      lines.push(`  camera ${v.index}: no pose (not calibrated) — its hands are ignored`);
      continue;
    }
    let both = 0, agree = 0;
    for (const f of rec.views[0].frames) {
      if (f.hands.length !== 1) continue;
      let best: (typeof v.frames)[number] | undefined;
      for (const g of v.frames) if (!best || Math.abs(g.t + cal.timeOffsetMs - f.t) < Math.abs(best.t + cal.timeOffsetMs - f.t)) best = g;
      if (!best || Math.abs(best.t + cal.timeOffsetMs - f.t) > 40 || best.hands.length !== 1) continue;
      both++;
      if (best.hands[0].h === f.hands[0].h) agree++;
    }
    lines.push(`  camera 0 ↔ ${v.index}: ${both} instants with one hand in both; labels agree in ${agree}`);
  }
  return lines;
}
