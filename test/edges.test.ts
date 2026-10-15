import { describe, expect, it } from 'vitest';
import { refineRectangleCorners } from '../src/calibration/edges';
import { focalFromRectangle, KNOWN_RECTANGLES } from '../src/calibration/objects';
import { median } from '../src/geometry/numeric';
import { intrinsicsFromFov } from '../src/intrinsics';
import { renderRectangle } from './render';
import { rng } from './sim';

const K = intrinsicsFromFov(1280, 720, 62);
const card = KNOWN_RECTANGLES.find((r) => r.id === 'card')!;
const CARD_RADIUS = 0.00318;

describe('refineRectangleCorners', () => {
  it('snaps rough clicks on a rounded credit card to its sharp corners', () => {
    const { image, corners } = renderRectangle({
      width: card.width, height: card.height, radius: CARD_RADIUS,
      rotation: [0.6, 0.25, 0.1], translation: [0.02, 0.01, 0.3], k: K,
    });
    const r = rng(4);
    const rough = Array.from(corners, (v) => v + r() * 6);
    const fit = refineRectangleCorners(image, rough)!;
    const err = Array.from({ length: 4 }, (_, i) => Math.hypot(fit.corners[i * 2] - corners[i * 2], fit.corners[i * 2 + 1] - corners[i * 2 + 1]));
    expect(Math.max(...err)).toBeLessThan(0.5);
    expect(Math.max(...fit.rmsPx)).toBeLessThan(0.5);
  });

  it('works whether the card is darker or brighter than the background', () => {
    const { image, corners } = renderRectangle({
      width: card.width, height: card.height, radius: CARD_RADIUS, object: 40, background: 200,
      rotation: [0.2, -0.7, 0], translation: [-0.03, 0, 0.32], k: K,
    });
    const fit = refineRectangleCorners(image, Array.from(corners, (v, i) => v + (i % 3) - 1))!;
    for (let i = 0; i < 8; i++) expect(Math.abs(fit.corners[i] - corners[i])).toBeLessThan(0.5);
  });

  it('makes a credit card about as accurate as A4 paper for focal length', () => {
    const r = rng(8);
    const clicked: number[] = [], snapped: number[] = [];
    for (let v = 0; v < 12; v++) {
      const tilt = 0.5 + 0.08 * (v % 4), axis = v * 0.5;
      const { image, corners } = renderRectangle({
        width: card.width, height: card.height, radius: CARD_RADIUS,
        rotation: [tilt * Math.cos(axis), tilt * Math.sin(axis), 0], translation: [0, 0, 0.35], k: K, seed: v,
      });
      // Clicking a rounded corner: ~1.5 px of click noise plus aiming at the visible (rounded) corner.
      const rough = Array.from(corners, (c) => c + r() * 2.5);
      const fc = focalFromRectangle(rough, card, K.cx, K.cy, K.fx * 1.1);
      const fit = refineRectangleCorners(image, rough);
      const fs = fit && focalFromRectangle(fit.corners, card, K.cx, K.cy, K.fx * 1.1);
      if (fc) clicked.push(Math.abs(fc / K.fx - 1));
      if (fs) snapped.push(Math.abs(fs / K.fx - 1));
    }
    console.log(
      `card at 35 cm, focal error median: clicked ${(median(clicked) * 100).toFixed(1)} %, snapped to edges ${(median(snapped) * 100).toFixed(1)} %`,
    );
    expect(snapped.length).toBe(12);
    expect(median(snapped)).toBeLessThan(0.02);
    expect(median(snapped)).toBeLessThan(median(clicked) / 2);
  });
});
