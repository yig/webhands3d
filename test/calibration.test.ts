import { describe, expect, it } from 'vitest';
import { focalFromRectangle, homography4, KNOWN_RECTANGLES } from '../src/calibration';
import { projectPoints, rodrigues, transformPoints } from '../src/geometry/solvePose';
import { intrinsicsFromFov } from '../src/intrinsics';

const K = intrinsicsFromFov(1280, 720, 62);
const card = KNOWN_RECTANGLES.find((r) => r.id === 'card')!;

/** Image corners of a card centred at `t`, tilted by axis-angle `w`. */
function imageCorners(w: [number, number, number], t: number[], width = card.width, height = card.height) {
  const corners = [
    -width / 2, -height / 2, 0, width / 2, -height / 2, 0,
    width / 2, height / 2, 0, -width / 2, height / 2, 0,
  ];
  const pts = transformPoints(corners, { rotation: rodrigues(...w), translation: Float64Array.from(t) });
  return projectPoints(pts, K);
}

describe('homography4', () => {
  it('maps the four source points onto the destination points', () => {
    const src = [0, 0, 1, 0, 1, 1, 0, 1];
    const dst = [10, 20, 110, 25, 105, 130, 5, 120];
    const H = homography4(src, dst)!;
    for (let i = 0; i < 4; i++) {
      const [x, y] = [src[i * 2], src[i * 2 + 1]];
      const w = H[6] * x + H[7] * y + H[8];
      expect((H[0] * x + H[1] * y + H[2]) / w).toBeCloseTo(dst[i * 2], 6);
      expect((H[3] * x + H[4] * y + H[5]) / w).toBeCloseTo(dst[i * 2 + 1], 6);
    }
  });
});

describe('focalFromRectangle', () => {
  it('recovers focal length from a tilted card', () => {
    const f = focalFromRectangle(imageCorners([0.6, 0.3, 0.1], [0.03, -0.02, 0.35]), card, K.cx, K.cy);
    expect(f).not.toBeNull();
    expect(Math.abs(f! - K.fx) / K.fx).toBeLessThan(0.01);
  });

  it('works whichever corner and direction the clicks start from', () => {
    const uv = Array.from(imageCorners([-0.5, 0.4, 0.2], [-0.05, 0.02, 0.4]));
    const shifted = [...uv.slice(2), ...uv.slice(0, 2)]; // start on a short edge
    const f = focalFromRectangle(shifted, card, K.cx, K.cy);
    expect(Math.abs(f! - K.fx) / K.fx).toBeLessThan(0.01);
  });

  // Small objects are sensitive to click error (a card at 40 cm: ~10 %), so the
  // demo recommends a sheet of paper. See docs/ARCHITECTURE.md.
  it('stays within a few percent with 1 px click error on A4 paper', () => {
    const a4 = KNOWN_RECTANGLES.find((r) => r.id === 'a4')!;
    const uv = imageCorners([0.7, 0, 0], [0, 0, 0.6], a4.width, a4.height);
    const noise = [0.8, -0.6, -1, 0.4, 0.5, 1, -0.7, -0.9];
    const f = focalFromRectangle(uv.map((v, i) => v + noise[i]), a4, K.cx, K.cy);
    expect(Math.abs(f! - K.fx) / K.fx).toBeLessThan(0.05);
  });

  // Tilting the sheet about one of its own edges (top tipped away) makes both
  // long/short-edge assignments fit exactly; a prior focal length decides.
  it('handles a sheet tilted about its own edge, given a rough prior', () => {
    const a4 = KNOWN_RECTANGLES.find((r) => r.id === 'a4')!;
    const prior = intrinsicsFromFov(1280, 720, 66).fx; // the default; truth here is 62°
    for (const w of [[0.7, 0, 0], [0, 0.7, 0], [0.9, 0, 0], [0, 0.5, 0]] as [number, number, number][]) {
      const f = focalFromRectangle(imageCorners(w, [0, 0, 0.6], a4.width, a4.height), a4, K.cx, K.cy, prior);
      expect(Math.abs(f! - K.fx) / K.fx).toBeLessThan(0.01);
    }
  });

  it('rejects a card facing the camera head-on', () => {
    expect(focalFromRectangle(imageCorners([0, 0, 0.2], [0, 0, 0.35]), card, K.cx, K.cy)).toBeNull();
  });
});
