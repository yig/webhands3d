import { describe, expect, it } from 'vitest';
import { MultiViewHandTracker, type ViewSource } from '../src/backends/multiview';
import { mulVec3 } from '../src/geometry/linalg';
import { median } from '../src/geometry/numeric';
import { projectPoints, rodrigues, transformPoints } from '../src/geometry/solvePose';
import { intrinsicsFromFov, type Intrinsics } from '../src/intrinsics';
import type { HandFrameListener, Hand3D } from '../src/types';
import { HAND, rng, TRUE_LENGTHS } from './sim';
import { handAt, rotationError } from './stereoSim';

interface Cam {
  k: Intrinsics;
  R: Float64Array;
  t: number[];
  /** Camera's reported timestamps lag camera 0's clock by this much, ms. */
  offsetMs: number;
  phaseMs: number;
}
function camera(k: Intrinsics, rot: [number, number, number], centre: number[], offsetMs: number, phaseMs: number): Cam {
  const R = rodrigues(...rot);
  const t = [0, 1, 2].map((r) => -(R[r * 3] * centre[0] + R[r * 3 + 1] * centre[1] + R[r * 3 + 2] * centre[2]));
  return { k, R, t, offsetMs, phaseMs };
}
const CAMS: Cam[] = [
  camera(intrinsicsFromFov(1280, 720, 60), [0, 0, 0], [0, 0, 0], 0, 0),
  camera(intrinsicsFromFov(1920, 1080, 70), [0.04, -0.5, 0.02], [0.35, -0.03, 0.05], 60, 13),
  camera(intrinsicsFromFov(1280, 720, 65), [-0.05, 0.45, 0], [-0.3, 0.05, 0.08], -30, 22),
];

class FakeSource implements ViewSource {
  handScale = 1;
  skeletons: ViewSource['skeletons'] = {};
  private listeners = new Set<HandFrameListener>();
  constructor(public intrinsics: Intrinsics, public cameraId: string) {}
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

/** Frame events from every camera, in arrival order. `hidden(view, t)` hides the hand from a camera. */
function events(durationMs: number, hidden: (view: number, t: number) => boolean = () => false, seed = 5) {
  const r = rng(seed);
  const out: { at: number; view: number; hands: Hand3D[]; reported: number }[] = [];
  CAMS.forEach((cam, view) => {
    for (let t = cam.phaseMs; t < durationMs; t += 1000 / 30) {
      const { rotation, joints } = handAt(t);
      const inView = new Float32Array(joints.length);
      for (let i = 0; i < joints.length; i += 3) {
        const p = mulVec3(cam.R, [joints[i], joints[i + 1], joints[i + 2]]);
        inView.set([p[0] + cam.t[0], p[1] + cam.t[1], p[2] + cam.t[2]], i);
      }
      const image = projectPoints(inView, cam.k).map((v) => v + r() * 1.0);
      const size = 1 + r() * 0.1;
      const R = Float64Array.from({ length: 9 }, (_, i) => {
        const [row, col] = [Math.floor(i / 3), i % 3];
        return cam.R[row * 3] * rotation[col] + cam.R[row * 3 + 1] * rotation[3 + col] + cam.R[row * 3 + 2] * rotation[6 + col];
      });
      const world = transformPoints(HAND, { rotation: R, translation: new Float64Array(3) }).map((v) => v * size);
      const reported = t - cam.offsetMs;
      const hands: Hand3D[] = hidden(view, t)
        ? []
        : [{ handedness: 'Right', joints: inView, confidence: 1, timestamp: reported, debug: { landmarks2d: image, worldLandmarks: world } }];
      out.push({ at: t, view, hands, reported });
    }
  });
  return out.sort((a, b) => a.at - b.at);
}

function setup(options: ConstructorParameters<typeof MultiViewHandTracker>[1] = {}) {
  const sources = CAMS.map((c, i) => new FakeSource(c.k, `cam${i}`));
  sources[0].skeletons.Right = { lengths: TRUE_LENGTHS, palm: new Float64Array(15) };
  const tracker = new MultiViewHandTracker(sources, { smoothing: false, ...options });
  return { sources, tracker };
}

const trueCalibration = (i: number) => ({
  R: Array.from(CAMS[i].R), t: CAMS[i].t, timeOffsetMs: CAMS[i].offsetMs, rmsPx: 0, inlierRatio: 1, frames: 0, scaleFrom: 'skeleton' as const,
});

describe('MultiViewHandTracker', () => {
  it('calibrates two extra cameras against camera 0 and measures the skeleton', async () => {
    const { sources, tracker } = setup();
    await tracker.start();
    const r = rng(1);
    const step = tracker.calibrate({ durationMs: 10, random: () => (r() + 1) / 2 });
    for (const e of events(10000)) sources[e.view].emit(e.hands, e.reported);
    const result = await step;
    for (const i of [1, 2]) {
      const cal = result.views[i];
      if (!cal || cal instanceof Error) throw cal;
      expect(rotationError(cal.R, CAMS[i].R)).toBeLessThan((1 * Math.PI) / 180);
      expect(Math.abs(Math.hypot(...cal.t) / Math.hypot(...CAMS[i].t) - 1)).toBeLessThan(0.03);
      expect(Math.abs(cal.timeOffsetMs - CAMS[i].offsetMs)).toBeLessThanOrEqual(6);
    }
    const lengths = result.skeletons.Right!.lengths;
    const err = Array.from(lengths, (l, b) => Math.abs(l / TRUE_LENGTHS[b] - 1));
    expect(median(err)).toBeLessThan(0.03);
    // Every camera got the measured skeleton for its single-view fallback.
    for (const s of sources) expect(s.skeletons.Right!.lengths).toBe(lengths);
  });

  it('triangulates from cameras 1 and 2 when camera 0 loses the hand', async () => {
    const { sources, tracker } = setup({ calibrations: [null, trueCalibration(1), trueCalibration(2)], refineSkeleton: false });
    await tracker.start();
    const out: Hand3D[] = [];
    tracker.onFrame((hands) => out.push(...hands));
    for (const e of events(3000, (view, t) => view === 0 && t > 1500)) sources[e.view].emit(e.hands, e.reported);
    const late = out.filter((h) => h.timestamp > 1600);
    expect(late.length).toBeGreaterThan(30);
    expect(late.every((h) => h.debug?.source === 'stereo' && h.debug.views?.join() === '1,2')).toBe(true);
    const errors = late.flatMap((h) => {
      const truth = handAt(h.timestamp).joints;
      return Array.from({ length: 21 }, (_, j) =>
        Math.hypot(h.joints[j * 3] - truth[j * 3], h.joints[j * 3 + 1] - truth[j * 3 + 1], h.joints[j * 3 + 2] - truth[j * 3 + 2]));
    });
    expect(median(errors)).toBeLessThan(0.005);
  });

  it('keeps refining the skeleton while running', async () => {
    const { sources, tracker } = setup({ calibrations: [null, trueCalibration(1), trueCalibration(2)], refineIntervalMs: 0 });
    sources[1].skeletons = {};
    await tracker.start();
    for (const e of events(4000)) sources[e.view].emit(e.hands, e.reported);
    expect(tracker.status.skeletonSamples.Right).toBeGreaterThan(60);
    const lengths = sources[1].skeletons.Right!.lengths;
    const err = Array.from(lengths, (l, b) => Math.abs(l / TRUE_LENGTHS[b] - 1));
    expect(median(err)).toBeLessThan(0.02);
  });
});
