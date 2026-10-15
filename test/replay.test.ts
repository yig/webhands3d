/*
 * Replays a debug recording made in the browser (Recorder / the demo's
 * "Download recording" button) through stereo calibration, printing
 * diagnostics. Skipped unless a recording is given:
 *
 *   npm run replay -- recordings/webhands-calibrate-….json
 */
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { recordedSamples, type Recording, type RecordedView } from '../src/debug/recorder';
import { median } from '../src/geometry/numeric';
import { calibrateStereo, type StereoCalibration, type StereoDiagnostics } from '../src/stereo/calibrate';

const path = process.env.WEBHANDS_RECORDING;

const pct = (values: number[], p: number) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.floor(p * (s.length - 1))] : NaN;
};
const deg = (R: ArrayLike<number>) => (Math.acos(Math.min(1, Math.max(-1, (R[0] + R[4] + R[8] - 1) / 2))) * 180) / Math.PI;
const fmt = (c: StereoCalibration | null | undefined) =>
  c
    ? `baseline ${(Math.hypot(...c.t) * 100).toFixed(1)} cm, rotation ${deg(c.R).toFixed(1)}°, offset ${c.timeOffsetMs} ms, ` +
      `epipolar ${c.rmsPx.toFixed(2)} px, inliers ${(c.inlierRatio * 100).toFixed(0)} %, ${c.frames} hand-frames, scale from ${c.scaleFrom}`
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
  it('re-runs stereo calibration with diagnostics', () => {
    const rec = JSON.parse(readFileSync(path!, 'utf8')) as Recording;
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
        const best = [...d.coarse].sort((a, b) => a.sampsonPx - b.sampsonPx).slice(0, 5);
        out.push(
          `  coarse offsets (best 5, median Sampson px): ${best.map((c) => `${c.offset}:${c.sampsonPx.toFixed(2)}`).join('  ')}`,
          `  coarse curve: ${d.coarse.map((c) => `${c.offset}:${c.sampsonPx.toFixed(1)}`).join(' ')}`,
          `  fine (offset: spread / Sampson px): ${d.fine.map((c) => `${c.offset}:${c.spread.toFixed(3)}/${c.sampsonPx.toFixed(2)}`).join(' ')}`,
          `  chosen offset ${d.chosenOffsetMs} ms; hand-frames paired: ${d.singleHandPairs} single-hand, ${d.totalPairs} total; ` +
            `inliers ${d.ransacInliers} (RANSAC) → ${d.finalInliers} of ${d.correspondences}`,
          `  scale ratios (true/triangulated bone): n ${d.scaleRatios.count}, q25 ${d.scaleRatios.q25.toFixed(3)}, ` +
            `median ${d.scaleRatios.median.toFixed(3)}, q75 ${d.scaleRatios.q75.toFixed(3)}`,
        );
      }
    }
    console.log(out.join('\n'));
  });
});
