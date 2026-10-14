import { boneLengths } from '../src/geometry/bones';
import { projectPoints, rodrigues, transformPoints } from '../src/geometry/solvePose';
import { intrinsicsFromFov } from '../src/intrinsics';
import type { Hand3D } from '../src/types';

// Rough metric right hand, palm facing the camera, centred near the origin.
export const HAND = Float64Array.from([
  0, 0.08, 0.01,
  -0.03, 0.06, 0, -0.05, 0.04, -0.005, -0.065, 0.02, -0.01, -0.075, 0.0, -0.015,
  -0.025, 0.0, 0, -0.03, -0.035, -0.005, -0.032, -0.06, -0.01, -0.034, -0.08, -0.015,
  -0.005, -0.002, 0, -0.006, -0.04, -0.005, -0.007, -0.068, -0.01, -0.008, -0.09, -0.015,
  0.015, 0.0, 0, 0.018, -0.035, -0.005, 0.02, -0.06, -0.01, 0.022, -0.08, -0.015,
  0.033, 0.01, 0, 0.04, -0.015, -0.005, 0.045, -0.035, -0.01, 0.05, -0.05, -0.015,
]);
export const TRUE_LENGTHS = boneLengths(HAND);
export const K = intrinsicsFromFov(1280, 720, 60);

export function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
}
function gauss(r: () => number) {
  return (r() + r() + r() + r() + r() + r()) / Math.sqrt(2); // ≈ N(0, 1)
}

/**
 * A frame with the hand at a random pose and depth. MediaPipe's world landmarks
 * are simulated with the error that causes drift: a per-frame size error
 * (±15 %), plus per-joint noise that is worse in z. `zScale` < 1 flattens
 * MediaPipe's relative depth (under-reported tilt).
 */
export function simulate(r: () => number, t?: number[], zScale = 1) {
  const axis = [r(), r(), r() * 0.5];
  const n = Math.hypot(...axis);
  const angle = Math.abs(r()) * 1.2;
  const rotation = rodrigues((axis[0] / n) * angle, (axis[1] / n) * angle, (axis[2] / n) * angle);
  const translation = Float64Array.from(t ?? [r() * 0.15, r() * 0.08, 0.45 + Math.abs(r()) * 0.35]);
  const truth = transformPoints(HAND, { rotation, translation });
  const image = projectPoints(truth, K).map((v) => v + gauss(r) * 1.5);
  const size = 1 + r() * 0.15;
  const world = transformPoints(HAND, { rotation, translation: new Float64Array(3) }).map(
    (v, i) => (v * size + gauss(r) * (i % 3 === 2 ? 0.006 : 0.002)) * (i % 3 === 2 ? zScale : 1),
  );
  return { image, world, truth, wristDepth: truth[2], size };
}

export function asHand(f: ReturnType<typeof simulate>): Hand3D {
  return {
    handedness: 'Right',
    joints: new Float32Array(63),
    confidence: 1,
    timestamp: 0,
    debug: { landmarks2d: f.image, worldLandmarks: f.world },
  };
}

export const rms = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0) / v.length);
