import { median, solveLinear } from '../geometry/numeric';
import type { Hand3D } from '../types';

/** Everyday objects with standardised sizes, for calibration without a ruler. */
export interface KnownLength {
  id: string;
  label: string;
  /** Metres. */
  length: number;
}

export interface KnownRectangle {
  id: string;
  label: string;
  /** Metres; width ≥ height. */
  width: number;
  height: number;
}

/** Lengths to hold end-to-end between thumb tip and index fingertip. */
export const KNOWN_LENGTHS: KnownLength[] = [
  { id: 'card-long', label: 'Credit/ID card, long edge (85.6 mm)', length: 0.0856 },
  { id: 'card-short', label: 'Credit/ID card, short edge (54.0 mm)', length: 0.05398 },
  { id: 'aa-battery', label: 'AA battery, end to end (50.5 mm)', length: 0.0505 },
  { id: 'aaa-battery', label: 'AAA battery, end to end (44.5 mm)', length: 0.0445 },
];

/** Flat rectangles whose four corners can be clicked in a frozen frame. */
export const KNOWN_RECTANGLES: KnownRectangle[] = [
  { id: 'card', label: 'Credit/ID card (85.6 × 54.0 mm)', width: 0.0856, height: 0.05398 },
  { id: 'a4', label: 'A4 paper (297 × 210 mm)', width: 0.297, height: 0.21 },
  { id: 'letter', label: 'US Letter paper (279.4 × 215.9 mm)', width: 0.2794, height: 0.2159 },
  { id: 'usd', label: 'US banknote (156.0 × 66.3 mm)', width: 0.156, height: 0.0663 },
  { id: 'eur5', label: '€5 banknote (120 × 62 mm)', width: 0.12, height: 0.062 },
];

const THUMB_TIP = 4;
const INDEX_TIP = 8;

/**
 * Hand scale from gripping an object of known length end-to-end between the
 * thumb tip and index fingertip.
 */
export function handScaleFromGrip(knownLength: number, samples: Hand3D[]): number {
  const spans = samples
    .map((h) => h.debug?.worldLandmarks)
    .filter((w): w is Float32Array => !!w)
    .map((w) => {
      const a = THUMB_TIP * 3, b = INDEX_TIP * 3;
      return Math.hypot(w[b] - w[a], w[b + 1] - w[a + 1], w[b + 2] - w[a + 2]);
    });
  return knownLength / median(spans);
}

/**
 * Homography H (row-major 3×3, H[8] = 1) mapping 4 source points to 4
 * destination points, by direct linear transform.
 */
export function homography4(src: ArrayLike<number>, dst: ArrayLike<number>): Float64Array | null {
  const A = new Float64Array(64);
  const b = new Float64Array(8);
  for (let i = 0; i < 4; i++) {
    const x = src[i * 2], y = src[i * 2 + 1];
    const u = dst[i * 2], v = dst[i * 2 + 1];
    A.set([x, y, 1, 0, 0, 0, -u * x, -u * y], i * 16);
    A.set([0, 0, 0, x, y, 1, -v * x, -v * y], i * 16 + 8);
    b[i * 2] = u;
    b[i * 2 + 1] = v;
  }
  const h = solveLinear(A, b, 8);
  return h ? Float64Array.of(...h, 1) : null;
}

/**
 * Focal length (pixels) from the image of a rectangle of known size, assuming
 * square pixels and a known principal point (cx, cy).
 *
 * With H the homography from the rectangle's metric plane to the image, after
 * shifting the principal point to the origin, K⁻¹·H = [r1 r2 t] up to scale, so
 *   r1·r2 = 0       →  (h11·h12 + h21·h22)/f² + h31·h32 = 0
 *   |r1| = |r2|     →  (h11² + h21² − h12² − h22²)/f² + h31² − h32² = 0
 * Both are linear in 1/f²; solved together by least squares. Needs the
 * rectangle tilted away from the image plane (≳ 20°), else h31, h32 ≈ 0.
 *
 * Corners may start anywhere and go either way around: both assignments of the
 * first edge (long or short) are tried and the more self-consistent one kept.
 * When the rectangle is tilted about one of its own edges (the natural way to
 * hold a sheet: top tipped away), one constraint vanishes and *both*
 * assignments fit exactly; then the one closer to `priorFocal` (e.g. the
 * camera's current focal length) wins. Without a prior, a wrong choice there
 * gave focal lengths off by up to 2.5×.
 *
 * @param corners  4 image points (pixels), in order around the rectangle.
 * @returns focal length in pixels, or null if the view is degenerate.
 */
export function focalFromRectangle(
  corners: ArrayLike<number>,
  rect: Pick<KnownRectangle, 'width' | 'height'>,
  cx: number,
  cy: number,
  priorFocal?: number,
): number | null {
  const a = focalCandidate(corners, rect.width, rect.height, cx, cy);
  const b = focalCandidate(corners, rect.height, rect.width, cx, cy);
  if (!a || !b) return (a ?? b)?.focal ?? null;
  const ambiguous = Math.max(a.residual, b.residual) < 10 * Math.min(a.residual, b.residual) + 1e-6;
  if (ambiguous && priorFocal) {
    const distance = (f: number) => Math.abs(Math.log(f / priorFocal));
    return distance(a.focal) <= distance(b.focal) ? a.focal : b.focal;
  }
  return a.residual <= b.residual ? a.focal : b.focal;
}

function focalCandidate(
  corners: ArrayLike<number>,
  width: number,
  height: number,
  cx: number,
  cy: number,
): { focal: number; residual: number } | null {
  const src = [0, 0, width, 0, width, height, 0, height];
  const dst = Array.from({ length: 8 }, (_, i) => corners[i] - (i % 2 ? cy : cx));
  const H = homography4(src, dst);
  if (!H) return null;
  const [h11, h12, , h21, h22, , h31, h32] = H;
  // Reject near-frontal views: relative depth change across the rectangle
  // (|h31, h32| · diagonal) too small to constrain f.
  if (Math.hypot(h31, h32) * Math.hypot(width, height) < 0.05) return null;
  const a1 = h11 * h12 + h21 * h22, b1 = h31 * h32;
  const a2 = h11 * h11 + h21 * h21 - h12 * h12 - h22 * h22, b2 = h31 * h31 - h32 * h32;
  const denom = a1 * a1 + a2 * a2;
  if (denom === 0) return null;
  const invF2 = -(a1 * b1 + a2 * b2) / denom;
  if (!(invF2 > 0)) return null;
  const residual = ((a1 * invF2 + b1) ** 2 + (a2 * invF2 + b2) ** 2) / (b1 * b1 + b2 * b2);
  return { focal: 1 / Math.sqrt(invF2), residual };
}
