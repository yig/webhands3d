import { describe, expect, it } from 'vitest';
import { calibrateBoneLengths } from '../src/calibration/bones';
import { boneLengths, retarget, translationFromBones } from '../src/geometry/bones';
import { projectPoints, rodrigues, solvePose, transformPoints } from '../src/geometry/solvePose';
import { intrinsicsFromFov } from '../src/intrinsics';
import type { Hand3D } from '../src/types';

// Rough metric right hand, palm facing the camera, centred near the origin.
const HAND = Float64Array.from([
  0, 0.08, 0.01,
  -0.03, 0.06, 0, -0.05, 0.04, -0.005, -0.065, 0.02, -0.01, -0.075, 0.0, -0.015,
  -0.025, 0.0, 0, -0.03, -0.035, -0.005, -0.032, -0.06, -0.01, -0.034, -0.08, -0.015,
  -0.005, -0.002, 0, -0.006, -0.04, -0.005, -0.007, -0.068, -0.01, -0.008, -0.09, -0.015,
  0.015, 0.0, 0, 0.018, -0.035, -0.005, 0.02, -0.06, -0.01, 0.022, -0.08, -0.015,
  0.033, 0.01, 0, 0.04, -0.015, -0.005, 0.045, -0.035, -0.01, 0.05, -0.05, -0.015,
]);
const TRUE_LENGTHS = boneLengths(HAND);
const K = intrinsicsFromFov(1280, 720, 60);

function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
}
function gauss(r: () => number) {
  return (r() + r() + r() + r() + r() + r()) / Math.sqrt(2); // ≈ N(0, 1)
}

/**
 * A frame with the hand at a random pose and depth. MediaPipe's world landmarks
 * are simulated with the error that causes drift: a per-frame size error
 * (±15 %), plus per-joint noise that is worse in z.
 */
function simulate(r: () => number, t?: number[]) {
  const axis = [r(), r(), r() * 0.5];
  const n = Math.hypot(...axis);
  const angle = Math.abs(r()) * 1.2;
  const rotation = rodrigues((axis[0] / n) * angle, (axis[1] / n) * angle, (axis[2] / n) * angle);
  const translation = Float64Array.from(t ?? [r() * 0.15, r() * 0.08, 0.45 + Math.abs(r()) * 0.35]);
  const truth = transformPoints(HAND, { rotation, translation });
  const image = projectPoints(truth, K).map((v) => v + gauss(r) * 1.5);
  const size = 1 + r() * 0.15;
  const world = transformPoints(HAND, { rotation, translation: new Float64Array(3) }).map(
    (v, i) => v * size + gauss(r) * (i % 3 === 2 ? 0.006 : 0.002),
  );
  return { image, world, wristDepth: truth[2], size };
}

function asHand(f: ReturnType<typeof simulate>): Hand3D {
  return {
    handedness: 'Right',
    joints: new Float32Array(63),
    confidence: 1,
    timestamp: 0,
    debug: { landmarks2d: f.image, worldLandmarks: f.world },
  };
}

const rms = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0) / v.length);

describe('bone lengths', () => {
  it('retarget keeps directions and sets lengths', () => {
    const lengths = TRUE_LENGTHS.map((l) => l * 1.3);
    const out = boneLengths(retarget(HAND, lengths));
    for (let b = 0; b < out.length; b++) expect(out[b]).toBeCloseTo(lengths[b], 6);
  });

  it('calibration recovers bone length ratios despite per-frame size errors', () => {
    const r = rng(3);
    const samples = Array.from({ length: 300 }, () => asHand(simulate(r)));
    const total = TRUE_LENGTHS.reduce((s, l) => s + l, 0);
    const L = calibrateBoneLengths(samples, K, total)!;
    const errors = Array.from(L, (l, b) => (l - TRUE_LENGTHS[b]) / TRUE_LENGTHS[b]);
    console.log(`bone length RMS error ${(rms(errors) * 100).toFixed(1)} %`);
    expect(rms(errors)).toBeLessThan(0.06);
  });

  it('bone-based depth does not follow MediaPipe size errors; PnP does', () => {
    const r = rng(11);
    const pnpErr: number[] = [];
    const boneErr: number[] = [];
    for (let i = 0; i < 300; i++) {
      const f = simulate(r);
      // Compare the wrist's depth (the two models have different origins).
      const pnp = solvePose(f.world, f.image, K).translation[2] + f.world[2];
      const model = retarget(f.world, TRUE_LENGTHS);
      const bones = translationFromBones(model, f.image, K)![2] + model[2];
      pnpErr.push(pnp / f.wristDepth - 1);
      boneErr.push(bones / f.wristDepth - 1);
    }
    console.log(`depth RMS error: PnP ${(rms(pnpErr) * 100).toFixed(1)} %, bones ${(rms(boneErr) * 100).toFixed(1)} %`);
    expect(rms(pnpErr)).toBeGreaterThan(0.06);
    expect(rms(boneErr)).toBeLessThan(rms(pnpErr) / 2);
  });
});
