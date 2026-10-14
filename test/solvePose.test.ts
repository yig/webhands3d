import { describe, expect, it } from 'vitest';
import { intrinsicsFromFov } from '../src/intrinsics';
import { projectPoints, rodrigues, solvePose, transformPoints } from '../src/geometry/solvePose';

// A rough metric hand (metres), centred near the origin, fingers pointing up (-y).
const HAND = Float64Array.from([
  0, 0.08, 0.01,
  -0.03, 0.06, 0, -0.05, 0.04, -0.005, -0.065, 0.02, -0.01, -0.075, 0.0, -0.015,
  -0.025, 0.0, 0, -0.03, -0.035, -0.005, -0.032, -0.06, -0.01, -0.034, -0.08, -0.015,
  -0.005, -0.002, 0, -0.006, -0.04, -0.005, -0.007, -0.068, -0.01, -0.008, -0.09, -0.015,
  0.015, 0.0, 0, 0.018, -0.035, -0.005, 0.02, -0.06, -0.01, 0.022, -0.08, -0.015,
  0.033, 0.01, 0, 0.04, -0.015, -0.005, 0.045, -0.035, -0.01, 0.05, -0.05, -0.015,
]);

const K = intrinsicsFromFov(1280, 720, 60);

function render(rotation: Float64Array, translation: number[], noisePx = 0, seed = 1) {
  const pts = transformPoints(HAND, { rotation, translation: Float64Array.from(translation) });
  const uv = projectPoints(pts, K);
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < uv.length; i++) uv[i] += noisePx * rand();
  return uv;
}

describe('solvePose', () => {
  it('recovers translation exactly when the model is camera-aligned', () => {
    const t = [0.12, -0.05, 0.6];
    const pose = solvePose(HAND, render(rodrigues(0, 0, 0), t), K);
    for (let i = 0; i < 3; i++) expect(pose.translation[i]).toBeCloseTo(t[i], 6);
    expect(pose.reprojectionError).toBeLessThan(1e-3); // float32 rendering
  });

  it('recovers translation within a few percent under pixel noise', () => {
    const t = [-0.1, 0.08, 0.9];
    const pose = solvePose(HAND, render(rodrigues(0, 0, 0), t, 2), K);
    expect(Math.abs(pose.translation[2] - t[2]) / t[2]).toBeLessThan(0.05);
    expect(Math.abs(pose.translation[0] - t[0])).toBeLessThan(0.01);
  });

  it('recovers a small rotation when refineRotation is on', () => {
    const R = rodrigues(0.15, -0.2, 0.1);
    const t = [0.05, 0.02, 0.5];
    const uv = render(R, t);
    const fixed = solvePose(HAND, uv, K);
    const refined = solvePose(HAND, uv, K, { refineRotation: true, iterations: 30 });
    expect(refined.reprojectionError).toBeLessThan(1e-3);
    expect(refined.reprojectionError).toBeLessThan(fixed.reprojectionError);
    for (let i = 0; i < 3; i++) expect(refined.translation[i]).toBeCloseTo(t[i], 4);
    for (let i = 0; i < 9; i++) expect(refined.rotation[i]).toBeCloseTo(R[i], 4);
  });

  it('scales depth with model scale (depth is only as good as hand size)', () => {
    const t = [0, 0, 0.5];
    const uv = render(rodrigues(0, 0, 0), t);
    const bigger = solvePose(HAND.map((v) => v * 1.2), uv, K);
    expect(bigger.translation[2]).toBeCloseTo(0.6, 4);
  });
});
