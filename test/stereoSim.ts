import { mul3, mulVec3, transpose3 } from '../src/geometry/linalg';
import { projectPoints, rodrigues, transformPoints } from '../src/geometry/solvePose';
import { intrinsicsFromFov, type Intrinsics } from '../src/intrinsics';
import type { Hand3D } from '../src/types';
import { HAND, rng } from './sim';

/** Laptop camera (camera 0) and an iPhone-like camera 1, 35 cm to the right, turned inward. */
export const K0 = intrinsicsFromFov(1280, 720, 60);
export const K1 = intrinsicsFromFov(1920, 1080, 70);
export const R01 = rodrigues(0.04, -0.5, 0.02);
export const C1 = [0.35, -0.03, 0.05];
export const T01 = Array.from({ length: 3 }, (_, r) => -(R01[r * 3] * C1[0] + R01[r * 3 + 1] * C1[1] + R01[r * 3 + 2] * C1[2]));
export const BASELINE = Math.hypot(...C1);

/** Hand pose (camera 0 frame) along a smooth path at time t (ms). */
export function handAt(tMs: number) {
  const s = tMs / 1000;
  const translation = Float64Array.of(
    0.12 * Math.sin(0.9 * s) + 0.08,
    0.08 * Math.sin(1.3 * s + 1),
    0.6 + 0.18 * Math.sin(0.7 * s + 2),
  );
  const rotation = rodrigues(0.5 * Math.sin(1.1 * s), 0.6 * Math.sin(0.8 * s + 0.5), 0.3 * Math.sin(0.6 * s));
  return { rotation, translation, joints: transformPoints(HAND, { rotation, translation }) };
}

export interface StereoSimOptions {
  durationMs?: number;
  /** Camera 1's reported timestamps are this much earlier than camera 0's clock. */
  offsetMs?: number;
  noisePx?: number;
  seed?: number;
  /** Camera 1's frame rate. */
  fps1?: number;
  /** The cameras' true intrinsics (default K0, K1); calibration may be given other (assumed) ones. */
  k0?: Intrinsics;
  k1?: Intrinsics;
  /** Error of MediaPipe's world-landmark orientation per frame, radians (default 0). */
  worldRotationNoise?: number;
  /** Fraction of frames where one camera's landmarks are garbage (MediaPipe failure). */
  outlierFrames?: number;
}

/** Simulated onFrame samples from both views, as MonocularHandTracker would report them. */
export function simulateStereo(options: StereoSimOptions = {}) {
  const { durationMs = 10000, offsetMs = 60, noisePx = 1.5, seed = 7, fps1 = 30 } = options;
  const { k0 = K0, k1 = K1, worldRotationNoise = 0, outlierFrames = 0 } = options;
  const r = rng(seed);
  const gauss = () => (r() + r() + r() + r() + r() + r()) / Math.sqrt(2);
  const samples0: Hand3D[] = [];
  const samples1: Hand3D[] = [];
  const make = (t: number, view: 0 | 1, reported: number): Hand3D => {
    const { rotation, joints } = handAt(t);
    const k = view === 0 ? k0 : k1;
    const inView = view === 0 ? joints : toCamera1(joints);
    const garbage = Math.abs(r()) < outlierFrames;
    const image = projectPoints(inView, k).map((v, i) =>
      garbage ? (i % 2 ? k.height : k.width) * (0.5 + 0.4 * r()) : v + gauss() * noisePx,
    );
    // MediaPipe-like world landmarks in this view's axes, with a per-frame size and orientation error.
    const wobble = rodrigues(gauss() * worldRotationNoise, gauss() * worldRotationNoise, gauss() * worldRotationNoise);
    const R = mul3(wobble, view === 0 ? rotation : mul3(R01, rotation));
    const size = 1 + r() * 0.1;
    const world = transformPoints(HAND, { rotation: R, translation: new Float64Array(3) }).map((v) => v * size + r() * 0.002);
    return {
      handedness: 'Right',
      joints: inView,
      confidence: 1,
      timestamp: reported,
      debug: { landmarks2d: image, worldLandmarks: world },
    };
  };
  for (let t = 0; t < durationMs; t += 1000 / 30) samples0.push(make(t, 0, t));
  for (let t = 13; t < durationMs; t += 1000 / fps1) samples1.push(make(t, 1, t - offsetMs));
  return { samples0, samples1 };
}

export function toCamera1(points: ArrayLike<number>): Float32Array {
  const out = new Float32Array(points.length);
  for (let i = 0; i < points.length; i += 3) {
    const p = mulVec3(R01, [points[i], points[i + 1], points[i + 2]]);
    out[i] = p[0] + T01[0];
    out[i + 1] = p[1] + T01[1];
    out[i + 2] = p[2] + T01[2];
  }
  return out;
}

export function rotationError(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const D = mul3(a, transpose3(b));
  return Math.acos(Math.min(1, Math.max(-1, (D[0] + D[4] + D[8] - 1) / 2)));
}

export type { Intrinsics };
