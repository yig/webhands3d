import { describe, expect, it } from 'vitest';
import { det3, mul3, svd3, transpose3 } from '../src/geometry/linalg';
import { rodrigues } from '../src/geometry/solvePose';
import {
  decomposeEssential,
  ransacEssential,
  refineRelativePose,
  triangulate,
} from '../src/stereo/epipolar';
import { rng } from './sim';

describe('svd3', () => {
  it('reconstructs the matrix with rotation factors', () => {
    const M = [2, -1, 0.5, 0.3, 4, 1, -2, 0.7, 3];
    const { U, s, V } = svd3(M);
    const back = mul3(mul3(U, Float64Array.of(s[0], 0, 0, 0, s[1], 0, 0, 0, s[2])), transpose3(V));
    for (let i = 0; i < 9; i++) expect(back[i]).toBeCloseTo(M[i], 9);
    expect(det3(U)).toBeCloseTo(1, 9);
    expect(det3(V)).toBeCloseTo(1, 9);
    expect(s[0]).toBeGreaterThanOrEqual(s[1]);
  });
});

/** Laptop camera at the origin; second camera 30 cm to the right, turned toward the hand area. */
const R = rodrigues(0.05, -0.45, 0.03);
const C1 = [0.3, -0.05, 0.05]; // second camera centre in camera-0 coordinates
const T = Float64Array.from([0, 1, 2], (r) => -(R[r * 3] * C1[0] + R[r * 3 + 1] * C1[1] + R[r * 3 + 2] * C1[2]));
const F = 1000;

function scene(n: number, noisePx: number, outliers = 0, seed = 1) {
  const r = rng(seed);
  const x0 = new Float64Array(n * 2), x1 = new Float64Array(n * 2), points: number[][] = [];
  for (let i = 0; i < n; i++) {
    const X = [r() * 0.2 + 0.1, r() * 0.15, 0.5 + Math.abs(r()) * 0.3];
    const Y = [0, 1, 2].map((k) => R[k * 3] * X[0] + R[k * 3 + 1] * X[1] + R[k * 3 + 2] * X[2] + T[k]);
    x0[i * 2] = X[0] / X[2] + (r() * noisePx) / F;
    x0[i * 2 + 1] = X[1] / X[2] + (r() * noisePx) / F;
    x1[i * 2] = Y[0] / Y[2] + (r() * noisePx) / F;
    x1[i * 2 + 1] = Y[1] / Y[2] + (r() * noisePx) / F;
    if (i < outliers) x1[i * 2] += 0.05 + Math.abs(r()) * 0.1;
    points.push(X);
  }
  return { x0, x1, points };
}

const angleBetween = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  const D = mul3(a, transpose3(b));
  return Math.acos(Math.min(1, Math.max(-1, (D[0] + D[4] + D[8] - 1) / 2)));
};

describe('relative pose', () => {
  it('recovers R and the direction of t despite noise and 20 % outliers', () => {
    const { x0, x1 } = scene(400, 1.5, 80);
    const r = rng(9);
    const ransac = ransacEssential(x0, x1, { threshold: 3 / F, random: () => (r() + 1) / 2 })!;
    expect(ransac.inliers.length).toBeGreaterThan(300);
    const pose = decomposeEssential(ransac.E, x0, x1, ransac.inliers);
    const refined = refineRelativePose(pose, x0, x1, ransac.inliers);
    expect(angleBetween(refined.R, R)).toBeLessThan(0.01);
    const tn = Math.hypot(...T);
    const dot = (refined.t[0] * T[0] + refined.t[1] * T[1] + refined.t[2] * T[2]) / tn;
    expect(dot).toBeGreaterThan(0.995);
    expect(refined.rms * F).toBeLessThan(1.5);
  });

  it('triangulates points with the true pose', () => {
    const { x0, x1, points } = scene(50, 0);
    for (let i = 0; i < 50; i++) {
      const res = triangulate(R, T, x0[i * 2], x0[i * 2 + 1], x1[i * 2], x1[i * 2 + 1], F, F)!;
      for (let k = 0; k < 3; k++) expect(res.X[k]).toBeCloseTo(points[i][k], 6);
      expect(res.error).toBeLessThan(1e-6);
    }
  });
});
