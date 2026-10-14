import { describe, expect, it } from 'vitest';
import { StereoHandTracker, type StereoSource } from '../src/backends/stereo';
import { median } from '../src/geometry/numeric';
import type { Intrinsics } from '../src/intrinsics';
import type { HandFrameListener, Hand3D } from '../src/types';
import { BASELINE, handAt, K0, K1, R01, simulateStereo, T01 } from './stereoSim';

class FakeSource implements StereoSource {
  handScale = 1;
  skeletons = {};
  private listeners = new Set<HandFrameListener>();
  constructor(
    public intrinsics: Intrinsics,
    public cameraId: string,
  ) {}
  async start() {}
  stop() {}
  onFrame(l: HandFrameListener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(hands: Hand3D[]) {
    for (const l of this.listeners) l(hands, hands[0]?.timestamp ?? 0);
  }
}

const OFFSET = 60;
const calibration = { R: Array.from(R01), t: T01, timeOffsetMs: OFFSET, rmsPx: 1, inlierRatio: 1, frames: 0, scaleFrom: 'skeleton' as const };

/** Feed both views' frames in the order they would arrive (camera 1 delivered by its true capture time). */
function run(tracker: StereoHandTracker, s0: FakeSource, s1: FakeSource, durationMs: number, drop1 = false) {
  const { samples0, samples1 } = simulateStereo({ durationMs, offsetMs: OFFSET, noisePx: 1 });
  const events = [
    ...samples0.map((h) => ({ at: h.timestamp, view: 0, h })),
    ...(drop1 ? [] : samples1.map((h) => ({ at: h.timestamp + OFFSET, view: 1, h }))),
  ].sort((a, b) => a.at - b.at);
  const out: Hand3D[] = [];
  tracker.onFrame((hands) => out.push(...hands));
  for (const e of events) (e.view ? s1 : s0).emit([e.h]);
  return out;
}

describe('StereoHandTracker', () => {
  it('triangulates joints to millimetres when both cameras see the hand', async () => {
    const s0 = new FakeSource(K0, 'a'), s1 = new FakeSource(K1, 'b');
    const tracker = new StereoHandTracker([s0, s1], { calibration, smoothing: false });
    await tracker.start();
    const out = run(tracker, s0, s1, 3000);
    const stereo = out.filter((h) => h.debug?.source === 'stereo');
    expect(stereo.length).toBeGreaterThan(80);
    const errors: number[] = [];
    for (const h of stereo) {
      const truth = handAt(h.timestamp).joints;
      for (let j = 0; j < 21; j++)
        errors.push(Math.hypot(h.joints[j * 3] - truth[j * 3], h.joints[j * 3 + 1] - truth[j * 3 + 1], h.joints[j * 3 + 2] - truth[j * 3 + 2]));
    }
    console.log(`stereo joint error: median ${(median(errors) * 1000).toFixed(1)} mm (baseline ${(BASELINE * 100).toFixed(0)} cm)`);
    expect(median(errors)).toBeLessThan(0.005);
  });

  it('falls back to camera 0 alone when camera 1 sends nothing', async () => {
    const s0 = new FakeSource(K0, 'a'), s1 = new FakeSource(K1, 'b');
    const tracker = new StereoHandTracker([s0, s1], { calibration, smoothing: false });
    await tracker.start();
    const out = run(tracker, s0, s1, 1000, true);
    expect(out.length).toBeGreaterThan(25);
    expect(out.every((h) => h.debug?.source === 'view0')).toBe(true);
  });

  it('passes camera 0 through before calibration', async () => {
    const s0 = new FakeSource(K0, 'a'), s1 = new FakeSource(K1, 'b');
    const tracker = new StereoHandTracker([s0, s1], { smoothing: false });
    await tracker.start();
    expect(tracker.status.calibrated).toBe(false);
    const out = run(tracker, s0, s1, 500);
    expect(out.length).toBeGreaterThan(10);
    expect(out.every((h) => h.debug?.source === 'view0')).toBe(true);
  });
});
