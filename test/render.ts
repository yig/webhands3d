import { homography4 } from '../src/calibration/objects';
import { projectPoints, rodrigues, transformPoints } from '../src/geometry/solvePose';
import type { Intrinsics } from '../src/intrinsics';
import { rng } from './sim';

export interface RenderOptions {
  /** Object size, metres, and corner radius. */
  width: number;
  height: number;
  radius?: number;
  /** Pose: axis-angle tilt and translation (camera frame). */
  rotation: [number, number, number];
  translation: [number, number, number];
  k: Intrinsics;
  /** Grey levels of the object and the background, 0–255. */
  object?: number;
  background?: number;
  noise?: number;
  /** Supersampling per axis (anti-aliasing). */
  supersample?: number;
  seed?: number;
}

/**
 * Render a flat rounded rectangle (e.g. a credit card) seen by a pinhole
 * camera, as a single-channel image. Returns the image and the projected
 * sharp corners (the rectangle without rounding), in order around it.
 */
export function renderRectangle(o: RenderOptions) {
  const { width: W, height: H, radius = 0, k, object = 220, background = 60, noise = 3, supersample = 3, seed = 1 } = o;
  const R = rodrigues(...o.rotation);
  const t = Float64Array.from(o.translation);
  const plane = [-W / 2, -H / 2, 0, W / 2, -H / 2, 0, W / 2, H / 2, 0, -W / 2, H / 2, 0];
  const corners = projectPoints(transformPoints(plane, { rotation: R, translation: t }), k);
  // Image → plane homography (inverse of plane → image).
  const Hinv = homography4(Array.from(corners), [-W / 2, -H / 2, W / 2, -H / 2, W / 2, H / 2, -W / 2, H / 2])!;
  const inside = (x: number, y: number) => {
    const w = Hinv[6] * x + Hinv[7] * y + Hinv[8];
    const px = (Hinv[0] * x + Hinv[1] * y + Hinv[2]) / w, py = (Hinv[3] * x + Hinv[4] * y + Hinv[5]) / w;
    const qx = Math.abs(px) - (W / 2 - radius), qy = Math.abs(py) - (H / 2 - radius);
    if (qx > radius || qy > radius) return false;
    if (qx > 0 && qy > 0) return qx * qx + qy * qy <= radius * radius;
    return true;
  };
  const data = new Float32Array(k.width * k.height);
  const r = rng(seed);
  // Only pixels near the object need supersampling.
  const xs = Array.from(corners).filter((_, i) => i % 2 === 0), ys = Array.from(corners).filter((_, i) => i % 2 === 1);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 2), x1 = Math.min(k.width - 1, Math.ceil(Math.max(...xs)) + 2);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)) - 2), y1 = Math.min(k.height - 1, Math.ceil(Math.max(...ys)) + 2);
  for (let y = 0; y < k.height; y++) {
    for (let x = 0; x < k.width; x++) {
      let cover = 0;
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) {
        for (let sy = 0; sy < supersample; sy++)
          for (let sx = 0; sx < supersample; sx++) cover += inside(x + (sx + 0.5) / supersample - 0.5, y + (sy + 0.5) / supersample - 0.5) ? 1 : 0;
        cover /= supersample * supersample;
      }
      data[y * k.width + x] = background + (object - background) * cover + r() * noise;
    }
  }
  return { image: { width: k.width, height: k.height, data }, corners };
}
