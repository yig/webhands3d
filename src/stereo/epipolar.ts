import {
  cross,
  essentialFromPose,
  mul3,
  smallestEigenvector,
  svd3,
  transpose3,
} from '../geometry/linalg';
import { solveLinear } from '../geometry/numeric';
import { rodrigues } from '../geometry/solvePose';

/*
 * Two-view geometry in normalised image coordinates (x̂ = (u − cx)/fx, ŷ = (v − cy)/fy).
 * Convention: camera 1 coordinates X1 = R·X0 + t; essential matrix E = [t]×·R;
 * epipolar constraint x̂1ᵀ·E·x̂0 = 0.
 * Correspondences are flattened arrays: x0[i*2], x0[i*2+1] ↔ x1[i*2], x1[i*2+1].
 */

export interface RelativePose {
  /** Row-major 3 × 3. */
  R: Float64Array;
  /** Unit length until a metric scale is applied. */
  t: Float64Array;
}

/** Linear 8-point essential matrix from the given correspondences, projected to a valid essential matrix. */
export function eightPoint(x0: ArrayLike<number>, x1: ArrayLike<number>, indices: ArrayLike<number>): Float64Array {
  const AtA = new Float64Array(81);
  const row = new Float64Array(9);
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    const a = x0[i * 2], b = x0[i * 2 + 1], c = x1[i * 2], d = x1[i * 2 + 1];
    row.set([c * a, c * b, c, d * a, d * b, d, a, b, 1]);
    for (let r = 0; r < 9; r++) for (let s = 0; s < 9; s++) AtA[r * 9 + s] += row[r] * row[s];
  }
  return projectToEssential(smallestEigenvector(AtA, 9));
}

/** Nearest essential matrix: singular values (1, 1, 0). */
export function projectToEssential(E: ArrayLike<number>): Float64Array {
  const { U, V } = svd3(E);
  const D = Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 0);
  return mul3(mul3(U, D), transpose3(V));
}

/** Sampson distance of one correspondence (normalised units; ≈ reprojection distance). */
export function sampsonDistance(E: ArrayLike<number>, a: number, b: number, c: number, d: number): number {
  const e0 = E[0] * a + E[1] * b + E[2], e1 = E[3] * a + E[4] * b + E[5], e2 = E[6] * a + E[7] * b + E[8];
  const f0 = E[0] * c + E[3] * d + E[6], f1 = E[1] * c + E[4] * d + E[7];
  const num = c * e0 + d * e1 + e2;
  const den = e0 * e0 + e1 * e1 + f0 * f0 + f1 * f1;
  return den > 0 ? Math.abs(num) / Math.sqrt(den) : Infinity;
}

export interface RansacOptions {
  iterations?: number;
  /** Inlier threshold, normalised units (pixels / focal length). */
  threshold?: number;
  /** Deterministic random source in [0, 1). */
  random?: () => number;
  /**
   * Group id per correspondence (e.g. frame index). Samples are drawn from
   * distinct groups so a minimal sample isn't 8 points of one rigid hand pose.
   */
  groups?: ArrayLike<number>;
}

/** Robust essential matrix: RANSAC over 8-point samples, then a refit on the inliers. */
export function ransacEssential(
  x0: ArrayLike<number>,
  x1: ArrayLike<number>,
  options: RansacOptions = {},
): { E: Float64Array; inliers: number[] } | null {
  const n = Math.min(x0.length, x1.length) / 2;
  if (n < 8) return null;
  const { iterations = 300, threshold = 0.004, random = Math.random, groups } = options;
  let best: { E: Float64Array; inliers: number[] } | null = null;
  const sample = new Int32Array(8);
  for (let it = 0; it < iterations; it++) {
    const usedGroups = new Set<number>();
    let filled = 0;
    for (let tries = 0; filled < 8 && tries < 100; tries++) {
      const i = Math.floor(random() * n);
      const g = groups ? groups[i] : i;
      if (usedGroups.has(g)) continue;
      usedGroups.add(g);
      sample[filled++] = i;
    }
    if (filled < 8) continue;
    const E = eightPoint(x0, x1, sample);
    const inliers: number[] = [];
    for (let i = 0; i < n; i++) {
      if (sampsonDistance(E, x0[i * 2], x0[i * 2 + 1], x1[i * 2], x1[i * 2 + 1]) < threshold) inliers.push(i);
    }
    if (!best || inliers.length > best.inliers.length) best = { E, inliers };
  }
  if (!best || best.inliers.length < 8) return null;
  const E = eightPoint(x0, x1, best.inliers);
  const inliers: number[] = [];
  for (let i = 0; i < n; i++) {
    if (sampsonDistance(E, x0[i * 2], x0[i * 2 + 1], x1[i * 2], x1[i * 2 + 1]) < threshold) inliers.push(i);
  }
  return { E, inliers };
}

/**
 * The (R, t) among the four decompositions of E that puts the most points in
 * front of both cameras.
 */
export function decomposeEssential(
  E: ArrayLike<number>,
  x0: ArrayLike<number>,
  x1: ArrayLike<number>,
  indices: ArrayLike<number>,
): RelativePose {
  const { U, V } = svd3(E);
  const W = Float64Array.of(0, -1, 0, 1, 0, 0, 0, 0, 1);
  const Vt = transpose3(V);
  const Rs = [mul3(mul3(U, W), Vt), mul3(mul3(U, transpose3(W)), Vt)];
  const u3 = Float64Array.of(U[2], U[5], U[8]);
  let best: RelativePose = { R: Rs[0], t: u3 };
  let bestCount = -1;
  const step = Math.max(1, Math.floor(indices.length / 200));
  for (const R of Rs) {
    for (const sign of [1, -1]) {
      const t = u3.map((v) => v * sign);
      let count = 0;
      for (let k = 0; k < indices.length; k += step) {
        const i = indices[k];
        const X = triangulateLinear(R, t, x0[i * 2], x0[i * 2 + 1], x1[i * 2], x1[i * 2 + 1]);
        if (!X) continue;
        const z1 = R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + t[2];
        if (X[2] > 0 && z1 > 0) count++;
      }
      if (count > bestCount) {
        bestCount = count;
        best = { R, t };
      }
    }
  }
  return best;
}

/**
 * Levenberg–Marquardt on the Sampson distances over rotation (3) and translation
 * direction (2). Returns the refined pose and the RMS Sampson distance.
 */
export function refineRelativePose(
  pose: RelativePose,
  x0: ArrayLike<number>,
  x1: ArrayLike<number>,
  indices: ArrayLike<number>,
  iterations = 20,
): RelativePose & { rms: number } {
  let R: Float64Array = Float64Array.from(pose.R);
  let t: Float64Array = normalize(pose.t);
  const m = indices.length;
  const residuals = (Rc: ArrayLike<number>, tc: ArrayLike<number>, out: Float64Array) => {
    const E = essentialFromPose(Rc, tc);
    let ss = 0;
    for (let k = 0; k < m; k++) {
      const i = indices[k];
      const a = x0[i * 2], b = x0[i * 2 + 1], c = x1[i * 2], d = x1[i * 2 + 1];
      const e0 = E[0] * a + E[1] * b + E[2], e1 = E[3] * a + E[4] * b + E[5], e2 = E[6] * a + E[7] * b + E[8];
      const f0 = E[0] * c + E[3] * d + E[6], f1 = E[1] * c + E[4] * d + E[7];
      const den = Math.sqrt(e0 * e0 + e1 * e1 + f0 * f0 + f1 * f1) || 1;
      out[k] = (c * e0 + d * e1 + e2) / den;
      ss += out[k] * out[k];
    }
    return ss;
  };
  const r = new Float64Array(m);
  const rTry = new Float64Array(m);
  const J = new Float64Array(m * 5);
  let cost = residuals(R, t, r);
  let lambda = 1e-3;
  const apply = (p: ArrayLike<number>, basis: [Float64Array, Float64Array]) => ({
    R: mul3(rodrigues(p[0], p[1], p[2]), R),
    t: normalize(Float64Array.from(t, (v, k) => v + p[3] * basis[0][k] + p[4] * basis[1][k])),
  });
  for (let iter = 0; iter < iterations; iter++) {
    const basis = tangentBasis(t);
    const h = 1e-6;
    for (let j = 0; j < 5; j++) {
      const p = new Float64Array(5);
      p[j] = h;
      const moved = apply(p, basis);
      residuals(moved.R, moved.t, rTry);
      for (let k = 0; k < m; k++) J[k * 5 + j] = (rTry[k] - r[k]) / h;
    }
    const H = new Float64Array(25);
    const g = new Float64Array(5);
    for (let k = 0; k < m; k++) {
      for (let a = 0; a < 5; a++) {
        g[a] += J[k * 5 + a] * r[k];
        for (let b = 0; b < 5; b++) H[a * 5 + b] += J[k * 5 + a] * J[k * 5 + b];
      }
    }
    let improved = false;
    while (!improved && lambda < 1e10) {
      const A = Float64Array.from(H);
      for (let a = 0; a < 5; a++) A[a * 5 + a] *= 1 + lambda;
      const delta = solveLinear(A, g.map((v) => -v), 5);
      if (!delta) break;
      const moved = apply(delta, basis);
      const c = residuals(moved.R, moved.t, rTry);
      if (c < cost) {
        R = moved.R;
        t = moved.t;
        r.set(rTry);
        const rel = (cost - c) / cost;
        cost = c;
        lambda = Math.max(lambda / 10, 1e-12);
        improved = true;
        if (rel < 1e-10) iter = iterations;
      } else {
        lambda *= 10;
      }
    }
    if (!improved) break;
  }
  return { R, t, rms: Math.sqrt(cost / Math.max(m, 1)) };
}

/** Linear (DLT) triangulation of one correspondence; point in camera-0 coordinates. */
export function triangulateLinear(
  R: ArrayLike<number>,
  t: ArrayLike<number>,
  a: number,
  b: number,
  c: number,
  d: number,
): Float64Array | null {
  // Rows of A·X = 0 for P0 = [I | 0], P1 = [R | t].
  const rows = [
    [-1, 0, a, 0],
    [0, -1, b, 0],
    [c * R[6] - R[0], c * R[7] - R[1], c * R[8] - R[2], c * t[2] - t[0]],
    [d * R[6] - R[3], d * R[7] - R[4], d * R[8] - R[5], d * t[2] - t[1]],
  ];
  const AtA = new Float64Array(16);
  for (const row of rows) for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) AtA[i * 4 + j] += row[i] * row[j];
  const X = smallestEigenvector(AtA, 4);
  if (Math.abs(X[3]) < 1e-12) return null;
  return Float64Array.of(X[0] / X[3], X[1] / X[3], X[2] / X[3]);
}

/**
 * Triangulate one correspondence and refine it by Gauss–Newton on the
 * reprojection error in both views, weighted by each view's focal length so
 * the error is in pixels. Returns the point (camera 0) and its RMS pixel error.
 */
export function triangulate(
  R: ArrayLike<number>,
  t: ArrayLike<number>,
  a: number,
  b: number,
  c: number,
  d: number,
  f0 = 1,
  f1 = 1,
): { X: Float64Array; error: number } | null {
  const X = triangulateLinear(R, t, a, b, c, d);
  if (!X) return null;
  const residual = (P: ArrayLike<number>, out?: Float64Array) => {
    const y0 = P[0] / P[2], y1 = P[1] / P[2];
    const Q0 = R[0] * P[0] + R[1] * P[1] + R[2] * P[2] + t[0];
    const Q1 = R[3] * P[0] + R[4] * P[1] + R[5] * P[2] + t[1];
    const Q2 = R[6] * P[0] + R[7] * P[1] + R[8] * P[2] + t[2];
    const r = [f0 * (y0 - a), f0 * (y1 - b), f1 * (Q0 / Q2 - c), f1 * (Q1 / Q2 - d)];
    out?.set(r);
    return r.reduce((s, v) => s + v * v, 0);
  };
  const r = new Float64Array(4);
  const rh = new Float64Array(4);
  for (let iter = 0; iter < 5; iter++) {
    if (X[2] <= 0) break;
    const cost = residual(X, r);
    const J = new Float64Array(12);
    for (let j = 0; j < 3; j++) {
      const Xh = Float64Array.from(X);
      const h = 1e-7 * Math.max(1, Math.abs(X[2]));
      Xh[j] += h;
      residual(Xh, rh);
      for (let k = 0; k < 4; k++) J[k * 3 + j] = (rh[k] - r[k]) / h;
    }
    const H = new Float64Array(9);
    const g = new Float64Array(3);
    for (let k = 0; k < 4; k++)
      for (let i = 0; i < 3; i++) {
        g[i] -= J[k * 3 + i] * r[k];
        for (let j = 0; j < 3; j++) H[i * 3 + j] += J[k * 3 + i] * J[k * 3 + j];
      }
    for (let i = 0; i < 3; i++) H[i * 4] *= 1 + 1e-9;
    const delta = solveLinear(H, g, 3);
    if (!delta) break;
    const next = Float64Array.from(X, (v, i) => v + delta[i]);
    if (residual(next) >= cost) break;
    X.set(next);
  }
  return { X, error: Math.sqrt(residual(X) / 2) };
}

function normalize(v: ArrayLike<number>): Float64Array {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return Float64Array.of(v[0] / n, v[1] / n, v[2] / n);
}

/** Two unit vectors orthogonal to t and each other. */
function tangentBasis(t: ArrayLike<number>): [Float64Array, Float64Array] {
  const helper = Math.abs(t[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = normalize(cross(t, helper));
  const e2 = normalize(cross(t, e1));
  return [e1, e2];
}
