/**
 * Rotation R (row-major 3×3) minimising Σ |R·(a_i − ā) − (b_i − b̄)|², by Horn's
 * quaternion method. `a` and `b` are n × 3 point sets, flattened.
 */
export function kabsch(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const n = Math.min(a.length, b.length) / 3;
  const ca = centroid(a, n), cb = centroid(b, n);
  // S[r][c] = Σ (a_r)(b_c)
  const S = new Float64Array(9);
  for (let i = 0; i < n; i++)
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) S[r * 3 + c] += (a[i * 3 + r] - ca[r]) * (b[i * 3 + c] - cb[c]);
  const [xx, xy, xz, yx, yy, yz, zx, zy, zz] = S;
  const N = Float64Array.of(
    xx + yy + zz, yz - zy, zx - xz, xy - yx,
    yz - zy, xx - yy - zz, xy + yx, zx + xz,
    zx - xz, xy + yx, -xx + yy - zz, yz + zy,
    xy - yx, zx + xz, yz + zy, -xx - yy + zz,
  );
  const [w, x, y, z] = largestEigenvector4(N);
  return Float64Array.of(
    w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z,
  );
}

export function centroid(p: ArrayLike<number>, n = p.length / 3): Float64Array {
  const c = new Float64Array(3);
  for (let i = 0; i < n; i++) for (let d = 0; d < 3; d++) c[d] += p[i * 3 + d] / n;
  return c;
}

/** Eigenvector of the largest eigenvalue of a symmetric 4×4 matrix (cyclic Jacobi). */
function largestEigenvector4(A: Float64Array): Float64Array {
  const a = Float64Array.from(A);
  const v = Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  for (let sweep = 0; sweep < 30; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += a[p * 4 + q] ** 2;
    if (off < 1e-24) break;
    for (let p = 0; p < 4; p++) {
      for (let q = p + 1; q < 4; q++) {
        const apq = a[p * 4 + q];
        if (Math.abs(apq) < 1e-30) continue;
        const theta = (a[q * 4 + q] - a[p * 4 + p]) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 4; k++) {
          const akp = a[k * 4 + p], akq = a[k * 4 + q];
          a[k * 4 + p] = c * akp - s * akq;
          a[k * 4 + q] = s * akp + c * akq;
        }
        for (let k = 0; k < 4; k++) {
          const apk = a[p * 4 + k], aqk = a[q * 4 + k];
          a[p * 4 + k] = c * apk - s * aqk;
          a[q * 4 + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 4; k++) {
          const vkp = v[k * 4 + p], vkq = v[k * 4 + q];
          v[k * 4 + p] = c * vkp - s * vkq;
          v[k * 4 + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i < 4; i++) if (a[i * 5] > a[best * 5]) best = i;
  return Float64Array.of(v[best], v[4 + best], v[8 + best], v[12 + best]);
}
