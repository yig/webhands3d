import { describe, expect, it } from 'vitest';
import { focalFromRectangle } from '../src/calibration/objects';
import { PATTERN_LAYOUT, PATTERN_SQUARE, detectPattern } from '../src/calibration/pattern';
import { median } from '../src/geometry/numeric';
import { projectPoints, rodrigues, transformPoints } from '../src/geometry/solvePose';
import { intrinsicsFromFov, type Intrinsics } from '../src/intrinsics';
import { rng } from './sim';

/**
 * RGBA camera image of a screen showing the pattern: green disks on a black
 * screen (slightly lit, slightly tinted, as a camera sees it), in a grey room
 * with a bright white lamp and some green-ish clutter.
 */
export function renderPattern(k: Intrinsics, rotation: [number, number, number], translation: [number, number, number], seed = 1) {
  // As showCalibrationPattern draws it on a phone (~6.8 × 14 cm visible): the
  // pattern square is 78 % of the screen's short side, disks inside it.
  const halfW = 0.034, halfH = 0.07;
  const side = 0.78 * 2 * halfW;
  const radius = side * PATTERN_LAYOUT.diskRadius;
  const spacing = side - 2 * radius;
  const R = rodrigues(...rotation), t = Float64Array.from(translation);
  const centresPlane = [-spacing / 2, -spacing / 2, 0, spacing / 2, -spacing / 2, 0, spacing / 2, spacing / 2, 0, -spacing / 2, spacing / 2, 0];
  const centres = projectPoints(transformPoints(centresPlane, { rotation: R, translation: t }), k);
  // Inverse homography image → screen plane, from the 4 screen-corner projections.
  const screen = [-halfW, -halfH, 0, halfW, -halfH, 0, halfW, halfH, 0, -halfW, halfH, 0];
  const sc = projectPoints(transformPoints(screen, { rotation: R, translation: t }), k);
  const toPlane = (x: number, y: number) => {
    // Ray-plane intersection: plane z = 0 in screen coordinates.
    const d = [(x - k.cx) / k.fx, (y - k.cy) / k.fy, 1];
    const n = [R[2], R[5], R[8]]; // plane normal (third column of R)
    const s = (n[0] * t[0] + n[1] * t[1] + n[2] * t[2]) / (n[0] * d[0] + n[1] * d[1] + n[2] * d[2]);
    const X = [d[0] * s - t[0], d[1] * s - t[1], d[2] * s - t[2]];
    return [R[0] * X[0] + R[3] * X[1] + R[6] * X[2], R[1] * X[0] + R[4] * X[1] + R[7] * X[2]];
  };
  const r = rng(seed);
  const data = new Uint8ClampedArray(k.width * k.height * 4);
  const xs = Array.from(sc).filter((_, i) => i % 2 === 0), ys = Array.from(sc).filter((_, i) => i % 2 === 1);
  const [sx0, sx1, sy0, sy1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  for (let y = 0; y < k.height; y++)
    for (let x = 0; x < k.width; x++) {
      let rgb = [110, 110, 105];
      if (x > 900 && x < 980 && y > 60 && y < 140) rgb = [255, 255, 250]; // lamp
      if (x > 100 && x < 160 && y > 600 && y < 700) rgb = [90, 140, 70]; // green-ish clutter
      if (x >= sx0 && x <= sx1 && y >= sy0 && y <= sy1) {
        let cover = 0, onScreen = 0;
        for (const [ox, oy] of [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]]) {
          const [px, py] = toPlane(x + ox, y + oy);
          if (Math.abs(px) <= halfW && Math.abs(py) <= halfH) onScreen++;
          for (let c = 0; c < 4; c++) {
            if (Math.hypot(px - centresPlane[c * 3], py - centresPlane[c * 3 + 1]) <= radius) cover++;
          }
        }
        if (onScreen) {
          const f = onScreen / 4, g = cover / 4;
          rgb = rgb.map((v, i) => v * (1 - f) + f * (i === 1 ? 20 + 215 * g : 20 + 60 * g));
        }
      }
      const i = (y * k.width + x) * 4;
      data[i] = rgb[0] + r() * 4;
      data[i + 1] = rgb[1] + r() * 4;
      data[i + 2] = rgb[2] + r() * 4;
      data[i + 3] = 255;
    }
  return { image: { width: k.width, height: k.height, data }, centres };
}

describe('screen pattern', () => {
  const K = intrinsicsFromFov(1280, 720, 64);

  it('finds the four disks despite a lamp and green-ish clutter', () => {
    const { image, centres } = renderPattern(K, [0.5, 0.3, 0.2], [0.02, -0.01, 0.35]);
    const found = detectPattern(image)!;
    expect(found).not.toBeNull();
    // Same points, maybe a different starting corner / direction.
    for (let i = 0; i < 4; i++) {
      const d = Math.min(...[0, 1, 2, 3].map((j) => Math.hypot(found[j * 2] - centres[i * 2], found[j * 2 + 1] - centres[i * 2 + 1])));
      expect(d).toBeLessThan(0.6);
    }
  });

  it('gives the focal length to ~1 % from a few tilted views', () => {
    const focals: number[] = [];
    for (let v = 0; v < 6; v++) {
      const tilt = 0.55 + 0.05 * v, axis = v * 1.1;
      const { image } = renderPattern(K, [tilt * Math.cos(axis), tilt * Math.sin(axis), 0.3], [0.01 * (v - 3), 0, 0.3 + 0.02 * v], v);
      const corners = detectPattern(image);
      const f = corners && focalFromRectangle(corners, PATTERN_SQUARE, K.cx, K.cy, K.fx * 1.1);
      if (f) focals.push(f);
    }
    expect(focals.length).toBe(6);
    console.log(`pattern: focal errors ${focals.map((f) => ((f / K.fx - 1) * 100).toFixed(2) + '%').join(', ')}`);
    expect(Math.abs(median(focals) / K.fx - 1)).toBeLessThan(0.01);
  });

  it('finds nothing when no pattern is shown', () => {
    const { image } = renderPattern(K, [0, 0, 0], [5, 5, 0.3]); // screen far out of view
    expect(detectPattern(image)).toBeNull();
  });
});
