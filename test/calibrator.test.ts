import { describe, expect, it } from 'vitest';
import { CalibrationError, Calibrator, type CalibratableTracker } from '../src/calibration/calibrator';
import { KNOWN_RECTANGLES } from '../src/calibration/objects';
import { projectPoints, rodrigues, transformPoints } from '../src/geometry/solvePose';
import type { HandFrameListener, Hand3D } from '../src/types';
import { asHand, K, rng, simulate, TRUE_LENGTHS } from './sim';

class FakeTracker implements CalibratableTracker {
  intrinsics = { ...K };
  handScale = 1;
  skeletons: CalibratableTracker['skeletons'] = {};
  cameraId = 'test-camera';
  private listeners = new Set<HandFrameListener>();
  onFrame(listener: HandFrameListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(hands: Hand3D[]) {
    for (const l of this.listeners) l(hands);
  }
}

/** Start a collecting step, feed it frames, and await it. */
async function feed<T>(tracker: FakeTracker, step: Promise<T>, frames: Hand3D[][]): Promise<T> {
  for (const hands of frames) tracker.emit(hands);
  return step;
}

const r = rng(42);
const handFrames = (n: number, side: 'Left' | 'Right' = 'Right') =>
  Array.from({ length: n }, () => [{ ...asHand(simulate(r)), handedness: side }]);

describe('Calibrator', () => {
  it('reports every step missing at first', () => {
    const status = new Calibrator(new FakeTracker()).status;
    expect(status.missing).toEqual(['handSize', 'focal', 'skeleton']);
  });

  it('rejects before the tracker has started', async () => {
    const tracker = new FakeTracker();
    tracker.intrinsics = null as never;
    await expect(new Calibrator(tracker).handSizeFromLength(0.19)).rejects.toMatchObject({ code: 'not-started' });
  });

  it('requires hand size before the skeleton step', async () => {
    const cal = new Calibrator(new FakeTracker());
    await expect(cal.skeleton({ durationMs: 10 })).rejects.toMatchObject({ code: 'needs-hand-size' });
  });

  it('rejects with no-hand when nothing is seen', async () => {
    const cal = new Calibrator(new FakeTracker());
    await expect(cal.handSizeFromLength(0.19, { durationMs: 10 })).rejects.toMatchObject({ code: 'no-hand' });
  });

  it('applies hand size, notifies listeners, and rescales an existing skeleton', async () => {
    const tracker = new FakeTracker();
    tracker.skeletons.Right = { lengths: [...TRUE_LENGTHS], palm: new Array(15).fill(0.01) };
    const cal = new Calibrator(tracker);
    const seen: number[] = [];
    cal.onChange((s) => seen.push(s.handSize.scale));
    const scale = await feed(tracker, cal.handSizeFromObject('card-long', { durationMs: 10 }), handFrames(20));
    expect(tracker.handScale).toBe(scale);
    expect(seen).toEqual([scale]);
    expect(tracker.skeletons.Right!.lengths[0]).toBeCloseTo(TRUE_LENGTHS[0] * scale, 9);
    expect(cal.status.missing).not.toContain('handSize');
  });

  it('runs the skeleton step end to end on simulated frames', async () => {
    const tracker = new FakeTracker();
    const cal = new Calibrator(tracker);
    await feed(tracker, cal.handSizeFromLength(0.19, { durationMs: 10 }), handFrames(20));
    let progressCalls = 0;
    const result = await feed(
      tracker,
      cal.skeleton({ durationMs: 10, onProgress: () => progressCalls++ }),
      handFrames(200, 'Right'),
    );
    expect(result.Right?.lengths).toHaveLength(20);
    expect(tracker.skeletons.Right).toBeDefined();
    expect(cal.status.skeleton).toEqual({ Left: false, Right: true });
    expect(progressCalls).toBe(200);
  });

  it('takes the median focal length over rectangle views and rejects frontal ones', () => {
    const tracker = new FakeTracker();
    const cal = new Calibrator(tracker);
    const a4 = KNOWN_RECTANGLES.find((o) => o.id === 'a4')!;
    const view = (w: [number, number, number]) => {
      const c = [-a4.width / 2, -a4.height / 2, 0, a4.width / 2, -a4.height / 2, 0, a4.width / 2, a4.height / 2, 0, -a4.width / 2, a4.height / 2, 0];
      return projectPoints(transformPoints(c, { rotation: rodrigues(...w), translation: Float64Array.of(0, 0, 0.6) }), K);
    };
    expect(() => cal.addRectangleView(view([0, 0, 0.1]), 'a4')).toThrow(CalibrationError);
    cal.addRectangleView(view([0.7, 0, 0]), 'a4');
    cal.addRectangleView(view([0, 0.6, 0.2]), a4);
    expect(tracker.intrinsics.fx).toBeCloseTo(K.fx, 0);
    expect(cal.status.focal.views).toHaveLength(2);
    expect(() => cal.addRectangleView(view([0.7, 0, 0]), 'napkin')).toThrow(/Unknown object/);
  });

  it('can be cancelled with an AbortSignal', async () => {
    const tracker = new FakeTracker();
    const cal = new Calibrator(tracker);
    const controller = new AbortController();
    const step = cal.handSizeFromLength(0.19, { durationMs: 1000, signal: controller.signal });
    controller.abort();
    await expect(step).rejects.toMatchObject({ code: 'aborted' });
  });

  it('reset returns the tracker to defaults', async () => {
    const tracker = new FakeTracker();
    const cal = new Calibrator(tracker);
    await feed(tracker, cal.handSizeFromLength(0.19, { durationMs: 10 }), handFrames(20));
    cal.setFieldOfView(80);
    cal.reset();
    expect(tracker.handScale).toBe(1);
    expect(cal.status.missing).toEqual(['handSize', 'focal', 'skeleton']);
    expect(cal.status.focal.hfovDegrees).toBeCloseTo(60, 6);
  });
});
