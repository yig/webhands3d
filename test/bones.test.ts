import { describe, expect, it } from 'vitest';
import { calibrateBoneLengths } from '../src/calibration/bones';
import { boneLengths, retarget, translationFromBones } from '../src/geometry/bones';
import { solvePose } from '../src/geometry/solvePose';
import { asHand, HAND, K, rms, rng, simulate, TRUE_LENGTHS } from './sim';


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
