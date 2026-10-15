import { cross, essentialFromPose, mul3, smallestEigenvector, svd3, transpose3 } from '../geometry/linalg';
import { median, solveLinear } from '../geometry/numeric';
import { kabsch } from '../geometry/rigid';
import { rodrigues } from '../geometry/solvePose';
import type { Intrinsics } from '../intrinsics';
import { decomposeEssential, ransacEssential, sampsonDistance, triangulateLinear, type RelativePose } from './epipolar';

/*
 * Robust two-view pose for real MediaPipe landmarks: they disagree between
 * views by several pixels (more for occluded joints) and some frames are
 * garbage. Errors are measured in pixels.
 *
 * Focal lengths are *not* estimated here: with two cameras converging on the
 * same hand, the epipolar geometry (and even hand-size constancy) only pins
 * down the ratio of the focal lengths, not their size (measured on simulated
 * and real recordings), so a free fit runs to extreme fields of view.
 */

/** Pixel correspondences (flattened u,v), grouped by hand-frame. */
export interface PixelPairs {
  u0: Float64Array;
  u1: Float64Array;
  /** Hand-frame index per correspondence. */
  groups: Int32Array;
  n: number;
  /** Per hand-frame: MediaPipe world landmarks in each view (21 × 3), if known. */
  world?: { w0: ArrayLike<number>; w1: ArrayLike<number> }[];
  /** Per hand-frame: camera 0's label for the hand. */
  handedness?: ('Left' | 'Right')[];
}

export interface StereoFit extends RelativePose {
  /** Median Sampson distance over all correspondences, pixels. */
  medianPx: number;
  /** Correspondences within the inlier threshold. */
  inliers: number[];
}

export interface RobustOptions {
  /** Inlier threshold, pixels. */
  thresholdPx: number;
  random: () => number;
}

/** Sampson distance in pixels (normalised distance × geometric-mean focal length). */
export function sampsonPx(E: ArrayLike<number>, k0: Intrinsics, k1: Intrinsics, p: PixelPairs, i: number): number {
  return (
    sampsonDistance(
      E,
      (p.u0[i * 2] - k0.cx) / k0.fx, (p.u0[i * 2 + 1] - k0.cy) / k0.fy,
      (p.u1[i * 2] - k1.cx) / k1.fx, (p.u1[i * 2 + 1] - k1.cy) / k1.fy,
    ) * Math.sqrt(k0.fx * k1.fx)
  );
}

function normalized(p: PixelPairs, k0: Intrinsics, k1: Intrinsics) {
  const x0 = new Float64Array(p.n * 2), x1 = new Float64Array(p.n * 2);
  for (let i = 0; i < p.n; i++) {
    x0[i * 2] = (p.u0[i * 2] - k0.cx) / k0.fx;
    x0[i * 2 + 1] = (p.u0[i * 2 + 1] - k0.cy) / k0.fy;
    x1[i * 2] = (p.u1[i * 2] - k1.cx) / k1.fx;
    x1[i * 2 + 1] = (p.u1[i * 2 + 1] - k1.cy) / k1.fy;
  }
  return { x0, x1 };
}

/**
 * Camera rotation from MediaPipe's per-view 3D hands: each frame's hand in
 * view 1 is its hand in view 0 rotated by R (world landmarks are in camera
 * axes). Robust mean of the per-frame Kabsch rotations.
 */
export function rotationFromWorld(world: { w0: ArrayLike<number>; w1: ArrayLike<number> }[]): Float64Array | null {
  if (world.length < 5) return null;
  const rots = world.map(({ w0, w1 }) => kabsch(w0, w1));
  const toSO3 = (M: ArrayLike<number>) => {
    const { U, V } = svd3(M);
    return mul3(U, transpose3(V));
  };
  let R = toSO3(Float64Array.from({ length: 9 }, (_, k) => median(rots.map((r) => r[k]))));
  // Trimmed mean of the rotations closest to it.
  for (let pass = 0; pass < 2; pass++) {
    const angle = (A: ArrayLike<number>) => {
      const D = mul3(A, transpose3(R));
      return Math.acos(Math.min(1, Math.max(-1, (D[0] + D[4] + D[8] - 1) / 2)));
    };
    const scored = rots.map((r) => ({ r, a: angle(r) })).sort((a, b) => a.a - b.a);
    const keep = scored.slice(0, Math.max(5, Math.floor(scored.length * 0.6)));
    R = toSO3(Float64Array.from({ length: 9 }, (_, k) => keep.reduce((s, x) => s + x.r[k], 0) / keep.length));
  }
  return R;
}

/**
 * Translation direction given the rotation. x̂1ᵀ·[t]×·R·x̂0 = 0 means
 * t ⟂ m = (R·x̂0) × x̂1 for every correspondence, so two correspondences give
 * t = m_i × m_j. RANSAC over such pairs (from different hand-frames), scored by
 * Sampson distance, then least squares on the inliers; sign chosen so points
 * lie in front of both cameras.
 */
export function translationGivenRotation(
  R: ArrayLike<number>,
  x0: ArrayLike<number>,
  x1: ArrayLike<number>,
  n: number,
  options: { threshold: number; random: () => number; groups?: ArrayLike<number>; iterations?: number },
): Float64Array {
  const m = Array.from({ length: n }, (_, i) => {
    const a = [x0[i * 2], x0[i * 2 + 1], 1];
    const Ra = [R[0] * a[0] + R[1] * a[1] + R[2], R[3] * a[0] + R[4] * a[1] + R[5], R[6] * a[0] + R[7] * a[1] + R[8]];
    return cross(Ra, [x1[i * 2], x1[i * 2 + 1], 1]);
  });
  const inliersOf = (t: ArrayLike<number>) => {
    const E = essentialFromPose(R, t);
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      if (sampsonDistance(E, x0[i * 2], x0[i * 2 + 1], x1[i * 2], x1[i * 2 + 1]) < options.threshold) out.push(i);
    }
    return out;
  };
  let best: { t: Float64Array; inliers: number[] } | null = null;
  for (let it = 0; it < (options.iterations ?? 300); it++) {
    const i = Math.floor(options.random() * n), j = Math.floor(options.random() * n);
    if (i === j || (options.groups && options.groups[i] === options.groups[j])) continue;
    const c = cross(m[i], m[j]);
    const len = Math.hypot(c[0], c[1], c[2]);
    if (len < 1e-12) continue;
    const t = Float64Array.of(c[0] / len, c[1] / len, c[2] / len);
    const inliers = inliersOf(t);
    if (!best || inliers.length > best.inliers.length) best = { t, inliers };
  }
  let t: Float64Array = best?.t ?? Float64Array.of(1, 0, 0);
  // Least squares on the inliers: smallest eigenvector of Σ m mᵀ.
  for (let pass = 0; pass < 2 && best && best.inliers.length >= 3; pass++) {
    const A = new Float64Array(9);
    for (const i of best.inliers) for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) A[r * 3 + c] += m[i][r] * m[i][c];
    const next = smallestEigenvector(A, 3);
    t = (next[0] * t[0] + next[1] * t[1] + next[2] * t[2] < 0 ? next.map((v) => -v) : next) as Float64Array;
    best = { t, inliers: inliersOf(t) };
  }
  // Cheirality.
  let front = 0;
  const sample = best?.inliers ?? [];
  const step = Math.max(1, Math.floor(sample.length / 300));
  for (let k = 0; k < sample.length; k += step) {
    const i = sample[k];
    const X = triangulateLinear(R, t, x0[i * 2], x0[i * 2 + 1], x1[i * 2], x1[i * 2 + 1]);
    if (!X) continue;
    const z1 = R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + t[2];
    front += X[2] > 0 && z1 > 0 ? 1 : X[2] < 0 && z1 < 0 ? -1 : 0;
  }
  return front >= 0 ? t : t.map((v) => -v);
}

/**
 * Levenberg–Marquardt on pixel Sampson distances over rotation (3) and
 * translation direction (2), trimmed: each round keeps the correspondences
 * within max(3 × median, threshold) of the current fit.
 */
export function refineRobust(
  start: RelativePose,
  p: PixelPairs,
  k0: Intrinsics,
  k1: Intrinsics,
  thresholdPx: number,
  rounds = 3,
): StereoFit {
  let R: Float64Array = Float64Array.from(start.R);
  let t: Float64Array = normalize(start.t);
  const apply = (q: ArrayLike<number>, basis: [Float64Array, Float64Array]) => ({
    R: mul3(rodrigues(q[0], q[1], q[2]), R),
    t: normalize(Float64Array.from(t, (v, k) => v + q[3] * basis[0][k] + q[4] * basis[1][k])),
  });
  const residuals = (s: RelativePose, idx: number[], out: Float64Array) => {
    const E = essentialFromPose(s.R, s.t);
    let ss = 0;
    idx.forEach((i, k) => {
      out[k] = sampsonPx(E, k0, k1, p, i);
      ss += out[k] * out[k];
    });
    return ss;
  };
  const all = Array.from({ length: p.n }, (_, i) => i);
  const allRes = new Float64Array(p.n);
  for (let round = 0; round < rounds; round++) {
    residuals({ R, t }, all, allRes);
    const cutoff = Math.max(3 * median(Array.from(allRes)), thresholdPx);
    const idx = all.filter((i) => allRes[i] < cutoff);
    if (idx.length < 30) break;
    const m = idx.length;
    const r = new Float64Array(m), rTry = new Float64Array(m), J = new Float64Array(m * 5);
    let cost = residuals({ R, t }, idx, r);
    let lambda = 1e-3;
    for (let iter = 0; iter < 15; iter++) {
      const basis = tangentBasis(t);
      for (let j = 0; j < 5; j++) {
        const q = new Float64Array(5);
        q[j] = 1e-6;
        residuals(apply(q, basis), idx, rTry);
        for (let k = 0; k < m; k++) J[k * 5 + j] = (rTry[k] - r[k]) / 1e-6;
      }
      const H = new Float64Array(25), g = new Float64Array(5);
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
        const next = apply(delta, basis);
        const c = residuals(next, idx, rTry);
        if (c < cost) {
          R = next.R;
          t = next.t;
          r.set(rTry);
          const rel = (cost - c) / cost;
          cost = c;
          lambda = Math.max(lambda / 10, 1e-12);
          improved = true;
          if (rel < 1e-9) iter = 1e9;
        } else lambda *= 10;
      }
      if (!improved) break;
    }
  }
  residuals({ R, t }, all, allRes);
  return {
    R,
    t,
    medianPx: median(Array.from(allRes)),
    inliers: all.filter((i) => allRes[i] < thresholdPx),
  };
}

/**
 * Best pose from two kinds of starting points — RANSAC (8-point essential
 * matrix), and the rotation from MediaPipe's 3D hands with the translation
 * direction found by 2-point RANSAC — each refined robustly; the lowest median
 * error wins. RANSAC alone is unreliable at real landmark noise (8 noisy
 * points rarely give a good model); the 3D-hand rotation is noisy per frame
 * (~25°) but its robust mean is a good start.
 */
export function fitStereo(p: PixelPairs, k0: Intrinsics, k1: Intrinsics, options: RobustOptions): StereoFit | null {
  if (p.n < 100) return null;
  const { x0, x1 } = normalized(p, k0, k1);
  const threshold = options.thresholdPx / Math.sqrt(k0.fx * k1.fx);
  const starts: RelativePose[] = [];
  const fit = ransacEssential(x0, x1, { iterations: 500, threshold, random: options.random, groups: p.groups });
  if (fit && fit.inliers.length >= 30) starts.push(decomposeEssential(fit.E, x0, x1, fit.inliers));
  const R = p.world ? rotationFromWorld(p.world) : null;
  if (R) starts.push({ R, t: translationGivenRotation(R, x0, x1, p.n, { threshold, random: options.random, groups: p.groups }) });
  let best: StereoFit | null = null;
  for (const s of starts) {
    const refined = refineRobust(s, p, k0, k1, options.thresholdPx);
    if (!best || refined.medianPx < best.medianPx) best = refined;
  }
  return best;
}

function normalize(v: ArrayLike<number>): Float64Array {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return Float64Array.of(v[0] / n, v[1] / n, v[2] / n);
}

function tangentBasis(t: ArrayLike<number>): [Float64Array, Float64Array] {
  const helper = Math.abs(t[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = normalize(cross(t, helper));
  const e2 = normalize(cross(t, e1));
  return [e1, e2];
}
