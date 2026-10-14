import { describe, expect, it } from 'vitest';
import { calibrateHandSkeleton } from '../src/calibration/bones';
import { retarget } from '../src/geometry/bones';
import { kabsch } from '../src/geometry/rigid';
import { PALM_JOINTS, placeSkeleton } from '../src/geometry/skeleton';
import { rodrigues, solvePose, transformPoints } from '../src/geometry/solvePose';
import { asHand, HAND, K, rms, rng, simulate, TRUE_LENGTHS } from './sim';

const PALM = Float64Array.from(PALM_JOINTS.flatMap((j) => [HAND[j * 3], HAND[j * 3 + 1], HAND[j * 3 + 2]]));
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;

describe('kabsch', () => {
  it('recovers a rotation between point sets', () => {
    const R = rodrigues(0.3, -0.7, 0.4);
    const moved = transformPoints(HAND, { rotation: R, translation: Float64Array.of(1, 2, 3) });
    const found = kabsch(HAND, moved);
    for (let i = 0; i < 9; i++) expect(found[i]).toBeCloseTo(R[i], 6);
  });
});

describe('placeSkeleton', () => {
  // The reported failure: tilted (foreshortened) hands pushed back in depth,
  // because MediaPipe under-reports tilt. Simulated by flattening its z.
  for (const zScale of [1, 0.5]) {
    it(`places the wrist without depth bias when MediaPipe z is scaled by ${zScale}`, () => {
      const r = rng(11);
      const skeleton: number[] = [];
      const pnp: number[] = [];
      for (let i = 0; i < 300; i++) {
        const f = simulate(r, undefined, zScale);
        skeleton.push(placeSkeleton(f.world, f.image, K, TRUE_LENGTHS, PALM).joints[2] / f.wristDepth - 1);
        const model = retarget(f.world, TRUE_LENGTHS);
        pnp.push((solvePose(model, f.image, K).translation[2] + model[2]) / f.wristDepth - 1);
      }
      expect(rms(skeleton)).toBeLessThan(0.03);
      expect(Math.abs(mean(skeleton))).toBeLessThan(0.01);
      expect(rms(skeleton)).toBeLessThan(rms(pnp));
    });
  }

  // At 45–80 cm with 1.5 px noise, ~1.7 % depth error alone is ~10 mm, so this
  // mostly measures overall placement. PnP on MediaPipe's flattened 3D: ~70 mm.
  it('reconstructs all joints to within ~2 cm when MediaPipe flattens depth', () => {
    const r = rng(5);
    const skeleton: number[] = [];
    const pnp: number[] = [];
    const err = (J: ArrayLike<number>, T: ArrayLike<number>, j: number) =>
      Math.hypot(J[j * 3] - T[j * 3], J[j * 3 + 1] - T[j * 3 + 1], J[j * 3 + 2] - T[j * 3 + 2]);
    for (let i = 0; i < 200; i++) {
      const f = simulate(r, undefined, 0.5);
      const { joints } = placeSkeleton(f.world, f.image, K, TRUE_LENGTHS, PALM);
      const model = retarget(f.world, TRUE_LENGTHS);
      const viaPnp = transformPoints(model, solvePose(model, f.image, K));
      for (let j = 0; j < 21; j++) {
        skeleton.push(err(joints, f.truth, j));
        pnp.push(err(viaPnp, f.truth, j));
      }
    }
    expect(rms(skeleton)).toBeLessThan(0.02);
    expect(rms(skeleton)).toBeLessThan(rms(pnp) / 3);
  });
});

describe('calibrateHandSkeleton', () => {
  it('recovers bone lengths even when MediaPipe flattens depth', () => {
    const r = rng(3);
    const samples = Array.from({ length: 300 }, () => asHand(simulate(r, undefined, 0.5)));
    const total = TRUE_LENGTHS.reduce((s, l) => s + l, 0);
    const { lengths } = calibrateHandSkeleton(samples, K, total)!;
    const errors = Array.from(lengths, (l, b) => (l - TRUE_LENGTHS[b]) / TRUE_LENGTHS[b]);
    expect(rms(errors)).toBeLessThan(0.06);
  });
});
