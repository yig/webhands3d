import { median } from '../geometry/numeric';
import type { Hand3D } from '../types';

export * from './objects';

/*
 * Monocular depth is set by two unknowns that trade off against each other:
 * depth ≈ f · handSize / (hand size in pixels). So calibrate in two steps:
 *   1. hand scale, from an object of known length gripped between thumb and
 *      index tips (objects.ts) or the user's measured hand length;
 *   2. focal length, from the clicked corners of a known rectangle
 *      (objects.ts) or the hand held at a measured distance.
 * Hand-based steps take samples over a short window and use their median.
 */

const WRIST = 0;
const MIDDLE_TIP = 12;

/** Straight-line wrist → middle fingertip length (metres) of unscaled world landmarks. */
export function modelHandLength(worldLandmarks: ArrayLike<number>): number {
  const a = WRIST * 3, b = MIDDLE_TIP * 3;
  return Math.hypot(
    worldLandmarks[b] - worldLandmarks[a],
    worldLandmarks[b + 1] - worldLandmarks[a + 1],
    worldLandmarks[b + 2] - worldLandmarks[a + 2],
  );
}

/**
 * Hand scale such that MediaPipe's hand matches the user's.
 * @param measuredLength  user's wrist crease → middle fingertip, metres, fingers extended.
 * @param samples  hands observed with fingers extended.
 */
export function handScaleFromLength(measuredLength: number, samples: Hand3D[]): number {
  const lengths = samples
    .map((h) => h.debug?.worldLandmarks)
    .filter((w): w is Float32Array => !!w)
    .map(modelHandLength);
  return measuredLength / median(lengths);
}

/**
 * Corrected focal length from the hand held at a known distance, near the image
 * centre. Depth scales linearly with focal length, so f' = f · measured / estimated.
 * @param measuredDistance  camera → palm centre, metres.
 */
export function focalFromDistance(currentFocal: number, measuredDistance: number, samples: Hand3D[]): number {
  const depths = samples
    .map((h) => h.debug?.center?.[2])
    .filter((z): z is number => z !== undefined && z > 0);
  return (currentFocal * measuredDistance) / median(depths);
}

/** Collects hands for a fixed duration, then resolves with them. */
export function collectSamples(
  subscribe: (listener: (hands: Hand3D[]) => void) => () => void,
  durationMs = 1500,
): Promise<Hand3D[]> {
  return new Promise((resolve, reject) => {
    const samples: Hand3D[] = [];
    const unsubscribe = subscribe((hands) => {
      if (hands[0]) samples.push(hands[0]);
    });
    setTimeout(() => {
      unsubscribe();
      if (samples.length) resolve(samples);
      else reject(new Error('No hand seen during calibration'));
    }, durationMs);
  });
}
