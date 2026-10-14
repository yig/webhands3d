/**
 * Eigen-decomposition of a symmetric n × n matrix (row-major) by cyclic Jacobi.
 * Returns eigenvalues in ascending order and eigenvectors as the matching
 * columns of `vectors` (row-major n × n).
 */
export function symmetricEigen(A: ArrayLike<number>, n: number): { values: Float64Array; vectors: Float64Array } {
  const a = Float64Array.from(A);
  const v = new Float64Array(n * n);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q] ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q];
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (a[q * n + q] - a[p * n + p]) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p], akq = a[k * n + q];
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k], aqk = a[q * n + k];
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p], vkq = v[k * n + q];
          v[k * n + p] = c * vkp - s * vkq;
          v[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[i * n + i] - a[j * n + j]);
  const values = Float64Array.from(order, (i) => a[i * n + i]);
  const vectors = new Float64Array(n * n);
  order.forEach((src, dst) => {
    for (let k = 0; k < n; k++) vectors[k * n + dst] = v[k * n + src];
  });
  return { values, vectors };
}

/** Eigenvector (length n) of the smallest eigenvalue of a symmetric matrix. */
export function smallestEigenvector(A: ArrayLike<number>, n: number): Float64Array {
  const { vectors } = symmetricEigen(A, n);
  return Float64Array.from({ length: n }, (_, k) => vectors[k * n]);
}

/**
 * SVD of a 3 × 3 matrix: M = U · diag(s) · Vᵀ, singular values descending,
 * U and V proper rotations (det +1; the sign is absorbed into s[2]).
 */
export function svd3(M: ArrayLike<number>): { U: Float64Array; s: Float64Array; V: Float64Array } {
  const MtM = mul3(transpose3(M), M);
  const { values, vectors } = symmetricEigen(MtM, 3);
  // Descending order.
  const V = Float64Array.of(
    vectors[2], vectors[1], vectors[0],
    vectors[5], vectors[4], vectors[3],
    vectors[8], vectors[7], vectors[6],
  );
  if (det3(V) < 0) for (let r = 0; r < 3; r++) V[r * 3 + 2] *= -1;
  const s = Float64Array.of(Math.sqrt(Math.max(values[2], 0)), Math.sqrt(Math.max(values[1], 0)), Math.sqrt(Math.max(values[0], 0)));
  const MV = mul3(M, V);
  const U = new Float64Array(9);
  for (let c = 0; c < 2; c++) {
    const n = Math.hypot(MV[c], MV[3 + c], MV[6 + c]) || 1;
    for (let r = 0; r < 3; r++) U[r * 3 + c] = MV[r * 3 + c] / n;
  }
  // Third column: right-handed completion; sign of the third singular value from M·v3.
  const u3 = cross([U[0], U[3], U[6]], [U[1], U[4], U[7]]);
  for (let r = 0; r < 3; r++) U[r * 3 + 2] = u3[r];
  s[2] = MV[2] * u3[0] + MV[5] * u3[1] + MV[8] * u3[2];
  return { U, s, V };
}

export function mul3(A: ArrayLike<number>, B: ArrayLike<number>): Float64Array {
  const out = new Float64Array(9);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) out[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  return out;
}

export function transpose3(A: ArrayLike<number>): Float64Array {
  return Float64Array.of(A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]);
}

export function det3(A: ArrayLike<number>): number {
  return (
    A[0] * (A[4] * A[8] - A[5] * A[7]) - A[1] * (A[3] * A[8] - A[5] * A[6]) + A[2] * (A[3] * A[7] - A[4] * A[6])
  );
}

export function mulVec3(A: ArrayLike<number>, v: ArrayLike<number>): Float64Array {
  return Float64Array.of(
    A[0] * v[0] + A[1] * v[1] + A[2] * v[2],
    A[3] * v[0] + A[4] * v[1] + A[5] * v[2],
    A[6] * v[0] + A[7] * v[1] + A[8] * v[2],
  );
}

export function cross(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  return Float64Array.of(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
}

/** [t]× · R, the essential matrix for X1 = R·X0 + t. */
export function essentialFromPose(R: ArrayLike<number>, t: ArrayLike<number>): Float64Array {
  const tx = Float64Array.of(0, -t[2], t[1], t[2], 0, -t[0], -t[1], t[0], 0);
  return mul3(tx, R);
}
