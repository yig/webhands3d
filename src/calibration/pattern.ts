import type { ImageLike } from './edges';
import type { KnownRectangle } from './objects';

/*
 * Screen calibration pattern: four green disks at the corners of a square on
 * a black screen. A screen is perfectly flat and rigid, and its pixels are
 * square, so the disk centres form an exact square whatever the device —
 * the detecting camera needs no information about the displaying screen.
 * (Focal length from a rectangle needs only its shape, not its size.)
 */

/** The pattern's shape for focalFromRectangle / Calibrator.addRectangleView. */
export const PATTERN_SQUARE: KnownRectangle = { id: 'screen-pattern', label: 'Screen pattern', width: 1, height: 1 };

/** Layout as fractions of the square's side (shared by display and detection). */
export const PATTERN_LAYOUT = {
  /** Disk radius relative to the distance between disk centres. */
  diskRadius: 0.09,
  color: '#00ff00',
};

export interface PatternDetectionOptions {
  /** Work on a copy at most this wide, for speed (full resolution refines the centres). */
  maxWidth?: number;
}

/**
 * Find the pattern's 4 disk centres in an RGBA image (pixels, in order around
 * the square), or null. Green pixels → connected blobs → the 4 blobs of
 * similar size that form a convex quadrilateral → centres refined at full
 * resolution as greenness-weighted centroids. (A tilted disk's centroid is not
 * exactly its projected centre, but at these sizes the difference is far below
 * a pixel: correcting it changed simulated focal errors by < 0.05 %.)
 */
export function detectPattern(image: ImageLike, options: PatternDetectionOptions = {}): Float64Array | null {
  const { width: W, height: H, data } = image;
  if (data.length !== W * H * 4) return null;
  const step = Math.max(1, Math.ceil(W / (options.maxWidth ?? 480)));
  const w = Math.floor(W / step), h = Math.floor(H / step);
  const green = (i: number) => {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    return g - Math.max(r, b);
  };
  // Screen green is saturated: strongly green, little red or blue.
  const isGreen = (i: number) => data[i * 4 + 1] > 110 && green(i) > 70;
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) mask[y * w + x] = isGreen(y * step * W + x * step) ? 1 : 0;

  // Connected components (4-neighbourhood).
  const label = new Int32Array(w * h).fill(-1);
  const blobs: { area: number; x0: number; y0: number; x1: number; y1: number; cx: number; cy: number }[] = [];
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || label[start] >= 0) continue;
    const id = blobs.length;
    const blob = { area: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, cx: 0, cy: 0 };
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w, y = (p - x) / w;
      blob.area++;
      blob.cx += x;
      blob.cy += y;
      blob.x0 = Math.min(blob.x0, x);
      blob.x1 = Math.max(blob.x1, x);
      blob.y0 = Math.min(blob.y0, y);
      blob.y1 = Math.max(blob.y1, y);
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q >= 0 && mask[q] && label[q] < 0) {
          label[q] = id;
          stack.push(q);
        }
      }
    }
    blob.cx /= blob.area;
    blob.cy /= blob.area;
    blobs.push(blob);
  }
  // Disks: compact (fill their bounding box like an ellipse does), not tiny.
  const candidates = blobs
    .filter((b) => b.area >= 6 && b.area >= 0.45 * (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1))
    .sort((a, b) => b.area - a.area)
    .slice(0, 8);
  // Best 4 of them: convex, similar areas.
  let best: { score: number; quad: typeof candidates } | null = null;
  const n = candidates.length;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++) {
          const quad = orderAround([candidates[a], candidates[b], candidates[c], candidates[d]]);
          if (!convex(quad.map((q) => [q.cx, q.cy]))) continue;
          const areas = quad.map((q) => q.area);
          const ratio = Math.max(...areas) / Math.min(...areas);
          if (ratio > 4) continue;
          // Disks are far apart relative to their size (centres ~9 radii apart on the screen).
          const radius = Math.sqrt(Math.max(...areas) / Math.PI);
          let minGap = Infinity;
          for (let i = 0; i < 4; i++)
            for (let j = i + 1; j < 4; j++) minGap = Math.min(minGap, Math.hypot(quad[i].cx - quad[j].cx, quad[i].cy - quad[j].cy));
          if (minGap < 4 * radius) continue;
          const score = Math.min(...areas) / ratio;
          if (!best || score > best.score) best = { score, quad };
        }
  if (!best) return null;
  // Refine each centre at full resolution: greenness-weighted centroid within its (padded) box.
  const out = new Float64Array(8);
  best.quad.forEach((blob, k) => {
    const pad = 2;
    const X0 = Math.max(0, (blob.x0 - pad) * step), X1 = Math.min(W - 1, (blob.x1 + pad + 1) * step);
    const Y0 = Math.max(0, (blob.y0 - pad) * step), Y1 = Math.min(H - 1, (blob.y1 + pad + 1) * step);
    let sw = 0, sx = 0, sy = 0;
    for (let y = Y0; y <= Y1; y++)
      for (let x = X0; x <= X1; x++) {
        const i = y * W + x;
        const g = green(i);
        if (data[i * 4 + 1] > 60 && g > 25) {
          sw += g;
          sx += g * x;
          sy += g * y;
        }
      }
    out[k * 2] = sw ? sx / sw : (blob.cx + 0.5) * step;
    out[k * 2 + 1] = sw ? sy / sw : (blob.cy + 0.5) * step;
  });
  return out;
}

function orderAround<T extends { cx: number; cy: number }>(pts: T[]): T[] {
  const mx = pts.reduce((s, p) => s + p.cx, 0) / pts.length, my = pts.reduce((s, p) => s + p.cy, 0) / pts.length;
  return [...pts].sort((a, b) => Math.atan2(a.cy - my, a.cx - mx) - Math.atan2(b.cy - my, b.cx - mx));
}

function convex(p: number[][]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = p[i], [bx, by] = p[(i + 1) % 4], [cx, cy] = p[(i + 2) % 4];
    const z = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(z) < 1e-9) return false;
    if (sign && Math.sign(z) !== sign) return false;
    sign = Math.sign(z);
  }
  return true;
}
