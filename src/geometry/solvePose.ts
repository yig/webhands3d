import type { Intrinsics } from '../intrinsics';
import { solveLinear } from './numeric';

/**
 * Rigid pose (R, t) that maps model points into the camera frame: Q = R·P + t.
 * `rotation` is a row-major 3×3 matrix.
 */
export interface Pose {
  rotation: Float64Array;
  translation: Float64Array;
  /** RMS pixel distance between projected model points and image points. */
  reprojectionError: number;
}

export interface SolvePoseOptions {
  /**
   * Also solve for rotation. When false the model is assumed to already be
   * expressed in camera-aligned axes (true for MediaPipe world landmarks, up to
   * prediction error) and only translation is estimated.
   */
  refineRotation?: boolean;
  /** Levenberg–Marquardt iterations after the linear initialisation. */
  iterations?: number;
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * Perspective-n-point for a model whose orientation is (approximately) known.
 *
 * 1. Closed-form translation with R = I: each point gives two equations linear
 *    in t, from x̂·(Pz + tz) = Px + tx and ŷ·(Pz + tz) = Py + ty.
 * 2. Levenberg–Marquardt on pixel reprojection error over t (and optionally a
 *    small rotation update), starting from that solution.
 *
 * @param model  n × 3 model points (metres), flattened.
 * @param image  n × 2 image points (pixels), flattened.
 */
export function solvePose(
  model: ArrayLike<number>,
  image: ArrayLike<number>,
  k: Intrinsics,
  options: SolvePoseOptions = {},
): Pose {
  const { refineRotation = false, iterations = 10 } = options;
  const n = Math.min(model.length / 3, image.length / 2);
  const rotation = Float64Array.from(IDENTITY);
  const translation = linearTranslation(model, image, k, n);

  const dof = refineRotation ? 6 : 3;
  let cost = reprojectionCost(model, image, k, n, rotation, translation);
  let lambda = 1e-3;
  const rotated = new Float64Array(3);

  for (let iter = 0; iter < iterations; iter++) {
    const H = new Float64Array(dof * dof);
    const g = new Float64Array(dof);
    const J = new Float64Array(2 * dof);
    for (let i = 0; i < n; i++) {
      mulMat3Vec(rotation, model, i * 3, rotated);
      const X = rotated[0] + translation[0];
      const Y = rotated[1] + translation[1];
      const Z = rotated[2] + translation[2];
      if (Z <= 1e-6) continue;
      const iz = 1 / Z;
      const ru = k.fx * X * iz + k.cx - image[i * 2];
      const rv = k.fy * Y * iz + k.cy - image[i * 2 + 1];
      // d(u, v)/dQ
      const du0 = k.fx * iz, du2 = -k.fx * X * iz * iz;
      const dv1 = k.fy * iz, dv2 = -k.fy * Y * iz * iz;
      // Translation columns: dQ/dt = I.
      J[0] = du0; J[1] = 0; J[2] = du2;
      J[dof] = 0; J[dof + 1] = dv1; J[dof + 2] = dv2;
      if (refineRotation) {
        // Left perturbation R ← exp([ω]×)·R: dQ/dω = -[a]× with a = R·P.
        const [ax, ay, az] = rotated;
        J[3] = du2 * ay;               // du/dωx = du0·0 + du2·(ay)
        J[4] = du0 * az - du2 * ax;    // du/dωy
        J[5] = -du0 * ay;              // du/dωz
        J[dof + 3] = -dv1 * az + dv2 * ay;
        J[dof + 4] = -dv2 * ax;
        J[dof + 5] = dv1 * ax;
      }
      for (let a = 0; a < dof; a++) {
        g[a] += J[a] * ru + J[dof + a] * rv;
        for (let b = 0; b < dof; b++) H[a * dof + b] += J[a] * J[b] + J[dof + a] * J[dof + b];
      }
    }

    let improved = false;
    while (!improved && lambda < 1e8) {
      const A = Float64Array.from(H);
      for (let a = 0; a < dof; a++) A[a * dof + a] *= 1 + lambda;
      const delta = solveLinear(A, g.map((v) => -v), dof);
      if (!delta) break;
      const tTry = Float64Array.of(
        translation[0] + delta[0],
        translation[1] + delta[1],
        translation[2] + delta[2],
      );
      const rTry = refineRotation
        ? mulMat3(rodrigues(delta[3], delta[4], delta[5]), rotation)
        : rotation;
      const costTry = reprojectionCost(model, image, k, n, rTry, tTry);
      if (costTry < cost) {
        translation.set(tTry);
        rotation.set(rTry);
        const relative = (cost - costTry) / cost;
        cost = costTry;
        lambda = Math.max(lambda / 10, 1e-9);
        improved = true;
        if (relative < 1e-8) iter = iterations;
      } else {
        lambda *= 10;
      }
    }
    if (!improved) break;
  }

  return { rotation, translation, reprojectionError: Math.sqrt(cost / Math.max(n, 1)) };
}

/** Least-squares translation assuming R = I (algebraic error). */
export function linearTranslation(
  model: ArrayLike<number>,
  image: ArrayLike<number>,
  k: Intrinsics,
  n = Math.min(model.length / 3, image.length / 2),
): Float64Array {
  // Rows: [1, 0, -x̂]·t = x̂·Pz - Px and [0, 1, -ŷ]·t = ŷ·Pz - Py.
  const AtA = new Float64Array(9);
  const Atb = new Float64Array(3);
  for (let i = 0; i < n; i++) {
    const xh = (image[i * 2] - k.cx) / k.fx;
    const yh = (image[i * 2 + 1] - k.cy) / k.fy;
    const Px = model[i * 3], Py = model[i * 3 + 1], Pz = model[i * 3 + 2];
    const b1 = xh * Pz - Px;
    const b2 = yh * Pz - Py;
    AtA[0] += 1;
    AtA[2] -= xh;
    AtA[4] += 1;
    AtA[5] -= yh;
    AtA[8] += xh * xh + yh * yh;
    Atb[0] += b1;
    Atb[1] += b2;
    Atb[2] += -xh * b1 - yh * b2;
  }
  AtA[6] = AtA[2];
  AtA[7] = AtA[5];
  return solveLinear(AtA, Atb, 3) ?? Float64Array.of(0, 0, 0.5);
}

/** Project model points through pose and intrinsics into pixels (n × 2). */
export function projectPoints(points: ArrayLike<number>, k: Intrinsics): Float32Array {
  const n = points.length / 3;
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const z = points[i * 3 + 2];
    out[i * 2] = (k.fx * points[i * 3]) / z + k.cx;
    out[i * 2 + 1] = (k.fy * points[i * 3 + 1]) / z + k.cy;
  }
  return out;
}

/** Apply Q = R·(scale·P) + t to n × 3 points. */
export function transformPoints(
  model: ArrayLike<number>,
  pose: Pick<Pose, 'rotation' | 'translation'>,
  scale = 1,
  out = new Float32Array(model.length),
): Float32Array {
  const R = pose.rotation, t = pose.translation;
  for (let i = 0; i < model.length; i += 3) {
    const x = model[i] * scale, y = model[i + 1] * scale, z = model[i + 2] * scale;
    out[i] = R[0] * x + R[1] * y + R[2] * z + t[0];
    out[i + 1] = R[3] * x + R[4] * y + R[5] * z + t[1];
    out[i + 2] = R[6] * x + R[7] * y + R[8] * z + t[2];
  }
  return out;
}

/** Rotation matrix (row-major) for axis-angle vector ω. */
export function rodrigues(wx: number, wy: number, wz: number): Float64Array {
  const theta = Math.hypot(wx, wy, wz);
  if (theta < 1e-12) return Float64Array.from(IDENTITY);
  const x = wx / theta, y = wy / theta, z = wz / theta;
  const c = Math.cos(theta), s = Math.sin(theta), C = 1 - c;
  return Float64Array.of(
    c + x * x * C, x * y * C - z * s, x * z * C + y * s,
    y * x * C + z * s, c + y * y * C, y * z * C - x * s,
    z * x * C - y * s, z * y * C + x * s, c + z * z * C,
  );
}

function reprojectionCost(
  model: ArrayLike<number>,
  image: ArrayLike<number>,
  k: Intrinsics,
  n: number,
  R: Float64Array,
  t: Float64Array,
): number {
  const a = new Float64Array(3);
  let cost = 0;
  for (let i = 0; i < n; i++) {
    mulMat3Vec(R, model, i * 3, a);
    const Z = a[2] + t[2];
    if (Z <= 1e-6) return Infinity;
    const du = (k.fx * (a[0] + t[0])) / Z + k.cx - image[i * 2];
    const dv = (k.fy * (a[1] + t[1])) / Z + k.cy - image[i * 2 + 1];
    cost += du * du + dv * dv;
  }
  return cost;
}

function mulMat3Vec(R: ArrayLike<number>, v: ArrayLike<number>, offset: number, out: Float64Array) {
  const x = v[offset], y = v[offset + 1], z = v[offset + 2];
  out[0] = R[0] * x + R[1] * y + R[2] * z;
  out[1] = R[3] * x + R[4] * y + R[5] * z;
  out[2] = R[6] * x + R[7] * y + R[8] * z;
}

function mulMat3(A: ArrayLike<number>, B: ArrayLike<number>): Float64Array {
  const out = new Float64Array(9);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      out[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  return out;
}
