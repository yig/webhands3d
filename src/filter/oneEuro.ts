/**
 * One Euro filter (Casiez et al., CHI 2012) over a fixed-length vector:
 * low-pass smoothing whose cutoff rises with speed, so slow motion is steady
 * and fast motion has little lag.
 */
export interface OneEuroOptions {
  /** Cutoff frequency (Hz) at zero speed. Lower = smoother when still. */
  minCutoff?: number;
  /** How quickly the cutoff rises with speed. Higher = less lag when moving. */
  beta?: number;
  /** Cutoff frequency (Hz) for the derivative estimate. */
  dCutoff?: number;
}

export class OneEuroFilter {
  private readonly minCutoff: number;
  private readonly beta: number;
  private readonly dCutoff: number;
  private x: Float64Array | null = null;
  private dx: Float64Array | null = null;
  private lastTime = 0;

  constructor(options: OneEuroOptions = {}) {
    this.minCutoff = options.minCutoff ?? 1.0;
    this.beta = options.beta ?? 1.0;
    this.dCutoff = options.dCutoff ?? 1.0;
  }

  reset(): void {
    this.x = null;
    this.dx = null;
  }

  /** Filter `value` (modified in place and returned) observed at `timeMs`. */
  filter<T extends Float32Array | Float64Array>(value: T, timeMs: number): T {
    if (!this.x || !this.dx || this.x.length !== value.length || timeMs <= this.lastTime) {
      this.x = Float64Array.from(value);
      this.dx = new Float64Array(value.length);
      this.lastTime = timeMs;
      return value;
    }
    const dt = (timeMs - this.lastTime) / 1000;
    this.lastTime = timeMs;
    const aD = alpha(this.dCutoff, dt);
    for (let i = 0; i < value.length; i++) {
      const d = (value[i] - this.x[i]) / dt;
      this.dx[i] += aD * (d - this.dx[i]);
      const a = alpha(this.minCutoff + this.beta * Math.abs(this.dx[i]), dt);
      this.x[i] += a * (value[i] - this.x[i]);
      value[i] = this.x[i];
    }
    return value;
  }
}

function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}
