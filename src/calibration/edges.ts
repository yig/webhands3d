/*
 * Snap roughly clicked rectangle corners to the rectangle's actual edges.
 *
 * Clicks are only good to a pixel or two, which is a large error for a small
 * object like a credit card, and a card's corners are rounded (radius
 * 3.18 mm), so there is no sharp corner to click. Instead, each side's middle
 * section is measured: many short intensity profiles across the edge give
 * sub-pixel edge positions, a straight line is fitted robustly through them,
 * and adjacent lines are intersected into the (virtual, sharp) corners.
 */

/** Greyscale or RGBA image (e.g. canvas ImageData). */
export interface ImageLike {
  width: number;
  height: number;
  /** RGBA (4 per pixel) or single-channel (1 per pixel), row-major. */
  data: ArrayLike<number>;
}

/** A line n·p = c with unit normal n. */
export interface Line {
  nx: number;
  ny: number;
  c: number;
}

export interface EdgeFit {
  /** 4 refined corners (pixels), same order as the input. */
  corners: Float64Array;
  /** The fitted line of each side (side i runs from corner i to corner i + 1). */
  lines: Line[];
  /** Edge points used per side (inliers), for display. */
  points: number[][];
  /** RMS distance of inlier edge points to their line, pixels, per side. */
  rmsPx: number[];
  /** Fraction of profiles per side that found a consistent edge. */
  support: number[];
}

export interface EdgeFitOptions {
  /** Profiles per side. */
  samples?: number;
  /** Part of each side used, as a fraction from its ends (avoids rounded corners). */
  margin?: number;
  /** How far across the edge to search, pixels (default: 8 % of the side, at least 10). */
  searchPx?: number;
}

/**
 * Refine 4 rough corners (pixels, in order around the rectangle) by fitting a
 * line to each side's edge in `image`. Returns null if a side has no clear edge.
 */
export function refineRectangleCorners(image: ImageLike, rough: ArrayLike<number>, options: EdgeFitOptions = {}): EdgeFit | null {
  const { samples = 40, margin = 0.15 } = options;
  const grey = toGrey(image);
  const lines: Line[] = [];
  const points: number[][] = [];
  const rmsPx: number[] = [];
  const support: number[] = [];
  for (let side = 0; side < 4; side++) {
    const ax = rough[side * 2], ay = rough[side * 2 + 1];
    const bx = rough[((side + 1) % 4) * 2], by = rough[((side + 1) % 4) * 2 + 1];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 10) return null;
    const dx = (bx - ax) / len, dy = (by - ay) / len;
    const nx = -dy, ny = dx;
    const search = options.searchPx ?? Math.max(10, 0.08 * len);
    // Edge position along each profile, with its gradient sign.
    const found: { x: number; y: number; sign: number }[] = [];
    for (let k = 0; k < samples; k++) {
      const s = margin + ((1 - 2 * margin) * (k + 0.5)) / samples;
      const px = ax + (bx - ax) * s, py = ay + (by - ay) * s;
      const hit = edgeAlongProfile(grey, image.width, image.height, px, py, nx, ny, search);
      if (hit) found.push({ x: px + nx * hit.offset, y: py + ny * hit.offset, sign: hit.sign });
    }
    // The edge has one polarity (card brighter or darker than the background).
    const positive = found.filter((f) => f.sign > 0), negative = found.filter((f) => f.sign < 0);
    const consistent = positive.length >= negative.length ? positive : negative;
    const fit = fitLineRobust(consistent);
    if (!fit || fit.inliers.length < samples * 0.3) return null;
    lines.push(fit.line);
    points.push(fit.inliers.flatMap((p) => [p.x, p.y]));
    rmsPx.push(fit.rms);
    support.push(fit.inliers.length / samples);
  }
  const corners = new Float64Array(8);
  for (let i = 0; i < 4; i++) {
    // Corner i is where side i − 1 meets side i.
    const p = intersect(lines[(i + 3) % 4], lines[i]);
    if (!p) return null;
    corners[i * 2] = p[0];
    corners[i * 2 + 1] = p[1];
  }
  return { corners, lines, points, rmsPx, support };
}

/** Strongest step along a profile through (px, py) in direction n, sub-pixel. */
function edgeAlongProfile(
  grey: Float32Array,
  w: number,
  h: number,
  px: number,
  py: number,
  nx: number,
  ny: number,
  search: number,
): { offset: number; sign: number } | null {
  const step = 0.5;
  const count = Math.floor((2 * search) / step) + 1;
  const values = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const o = -search + i * step;
    const v = sample(grey, w, h, px + nx * o, py + ny * o);
    if (Number.isNaN(v)) return null;
    values[i] = v;
  }
  // Smoothed derivative (central difference over 1 px).
  let best = -1, bestAbs = 0;
  const grad = new Float32Array(count);
  for (let i = 2; i < count - 2; i++) {
    grad[i] = values[i + 2] - values[i - 2];
    if (Math.abs(grad[i]) > bestAbs) {
      bestAbs = Math.abs(grad[i]);
      best = i;
    }
  }
  // Require a real step: well above the profile's typical variation.
  const range = Math.max(...values) - Math.min(...values);
  if (best < 3 || best > count - 4 || bestAbs < 12 || bestAbs < 0.3 * range) return null;
  // Parabola through the peak for sub-sample precision.
  const g0 = Math.abs(grad[best - 1]), g1 = bestAbs, g2 = Math.abs(grad[best + 1]);
  const denom = g0 - 2 * g1 + g2;
  const shift = denom < 0 ? (0.5 * (g0 - g2)) / denom : 0;
  return { offset: -search + (best + Math.max(-0.5, Math.min(0.5, shift))) * step, sign: Math.sign(grad[best]) };
}

/** Line through points by RANSAC (2 points) then total least squares on the inliers (< 1.5 px). */
function fitLineRobust(pts: { x: number; y: number }[]): { line: Line; inliers: { x: number; y: number }[]; rms: number } | null {
  if (pts.length < 5) return null;
  const lineThrough = (a: { x: number; y: number }, b: { x: number; y: number }): Line | null => {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) return null;
    const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
    return { nx, ny, c: nx * a.x + ny * a.y };
  };
  const dist = (l: Line, p: { x: number; y: number }) => Math.abs(l.nx * p.x + l.ny * p.y - l.c);
  let best: { x: number; y: number }[] = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const l = lineThrough(pts[i], pts[j]);
      if (!l) continue;
      const inliers = pts.filter((p) => dist(l, p) < 1.5);
      if (inliers.length > best.length) best = inliers;
    }
  }
  if (best.length < 5) return null;
  // Total least squares: the line through the centroid along the principal direction.
  let line: Line = { nx: 0, ny: 1, c: 0 };
  for (let pass = 0; pass < 2; pass++) {
    const mx = best.reduce((s, p) => s + p.x, 0) / best.length, my = best.reduce((s, p) => s + p.y, 0) / best.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of best) {
      sxx += (p.x - mx) ** 2;
      sxy += (p.x - mx) * (p.y - my);
      syy += (p.y - my) ** 2;
    }
    // Normal = eigenvector of the smaller eigenvalue of the scatter matrix.
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const nx = -Math.sin(theta), ny = Math.cos(theta);
    line = { nx, ny, c: nx * mx + ny * my };
    const refit = pts.filter((p) => dist(line, p) < 1);
    if (refit.length >= 5) best = refit;
  }
  const rms = Math.sqrt(best.reduce((s, p) => s + dist(line, p) ** 2, 0) / best.length);
  return { line, inliers: best, rms };
}

function intersect(a: Line, b: Line): [number, number] | null {
  const det = a.nx * b.ny - a.ny * b.nx;
  if (Math.abs(det) < 1e-9) return null;
  return [(a.c * b.ny - a.ny * b.c) / det, (a.nx * b.c - a.c * b.nx) / det];
}

function toGrey(image: ImageLike): Float32Array {
  const n = image.width * image.height;
  const out = new Float32Array(n);
  if (image.data.length === n) {
    for (let i = 0; i < n; i++) out[i] = image.data[i];
  } else {
    for (let i = 0; i < n; i++) {
      out[i] = 0.299 * image.data[i * 4] + 0.587 * image.data[i * 4 + 1] + 0.114 * image.data[i * 4 + 2];
    }
  }
  return out;
}

/** Bilinear sample; NaN outside the image. */
function sample(grey: Float32Array, w: number, h: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x > w - 1.001 || y > h - 1.001) return NaN;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const i = y0 * w + x0;
  return (
    grey[i] * (1 - fx) * (1 - fy) + grey[i + 1] * fx * (1 - fy) + grey[i + w] * (1 - fx) * fy + grey[i + w + 1] * fx * fy
  );
}
