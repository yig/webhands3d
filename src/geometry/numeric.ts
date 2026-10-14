/** Solve the dense n × n system A·x = b by Gaussian elimination with partial pivoting. */
export function solveLinear(A: Float64Array, b: ArrayLike<number>, n: number): Float64Array | null {
  const M = Float64Array.from(A);
  const x = Float64Array.from(b);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++)
      if (Math.abs(M[r * n + col]) > Math.abs(M[pivot * n + col])) pivot = r;
    if (Math.abs(M[pivot * n + col]) < 1e-15) return null;
    if (pivot !== col) {
      for (let c = 0; c < n; c++) {
        const tmp = M[col * n + c];
        M[col * n + c] = M[pivot * n + c];
        M[pivot * n + c] = tmp;
      }
      const tmp = x[col];
      x[col] = x[pivot];
      x[pivot] = tmp;
    }
    for (let r = col + 1; r < n; r++) {
      const f = M[r * n + col] / M[col * n + col];
      for (let c = col; c < n; c++) M[r * n + c] -= f * M[col * n + c];
      x[r] -= f * x[col];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r];
    for (let c = r + 1; c < n; c++) s -= M[r * n + c] * x[c];
    x[r] = s / M[r * n + r];
  }
  return x;
}

export function median(values: number[]): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
