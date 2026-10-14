import type { Intrinsics } from '../intrinsics';
import { NUM_JOINTS } from '../types';
import { weightedMedian } from './numeric';

/**
 * Parent of each joint in the hand's kinematic tree (wrist is the root).
 * Bone b connects joint b + 1 to its parent, so there are 20 bones.
 */
export const JOINT_PARENTS = [-1, 0, 1, 2, 3, 0, 5, 6, 7, 0, 9, 10, 11, 0, 13, 14, 15, 0, 17, 18, 19];
export const NUM_BONES = NUM_JOINTS - 1;

/** Lengths of the 20 skeleton bones of a 21 × 3 point set. */
export function boneLengths(points: ArrayLike<number>): Float64Array {
  const out = new Float64Array(NUM_BONES);
  for (let j = 1; j < NUM_JOINTS; j++) {
    const p = JOINT_PARENTS[j];
    out[j - 1] = Math.hypot(
      points[j * 3] - points[p * 3],
      points[j * 3 + 1] - points[p * 3 + 1],
      points[j * 3 + 2] - points[p * 3 + 2],
    );
  }
  return out;
}

/**
 * Rebuild a hand with the given bone lengths, keeping each bone's direction and
 * the wrist position from `points`.
 */
export function retarget(
  points: ArrayLike<number>,
  lengths: ArrayLike<number>,
  out = new Float32Array(NUM_JOINTS * 3),
): Float32Array {
  out[0] = points[0];
  out[1] = points[1];
  out[2] = points[2];
  for (let j = 1; j < NUM_JOINTS; j++) {
    const p = JOINT_PARENTS[j];
    const dx = points[j * 3] - points[p * 3];
    const dy = points[j * 3 + 1] - points[p * 3 + 1];
    const dz = points[j * 3 + 2] - points[p * 3 + 2];
    const s = lengths[j - 1] / (Math.hypot(dx, dy, dz) || 1);
    out[j * 3] = out[p * 3] + dx * s;
    out[j * 3 + 1] = out[p * 3 + 1] + dy * s;
    out[j * 3 + 2] = out[p * 3 + 2] + dz * s;
  }
  return out;
}

export interface BoneDepthOptions {
  /** Expected 2D landmark noise, pixels. */
  pixelNoise?: number;
  /** Expected error in a bone's tilt toward the camera, radians (MediaPipe's z is weak). */
  tiltNoise?: number;
}

/**
 * Hand translation from bone lengths rather than overall apparent size.
 *
 * A bone of length L whose direction has in-image-plane fraction c = cos(tilt)
 * and normalised image length a lies at depth L·c/a. Each bone gives one depth
 * estimate; bones lying flat to the image plane (c ≈ 1) are trusted most,
 * because there d(cos)/d(tilt) = 0 and tilt errors barely matter. Since c ≤ 1,
 * every bone also bounds the depth from above: L/a. The depth is the weighted
 * median of the per-bone estimates, capped by the tightest reliable bound;
 * x and y then follow by least squares.
 *
 * @param model  21 × 3 hand-centred metric joints (bone lengths are taken from it).
 * @param image  21 × 2 image landmarks, pixels.
 * @returns translation to add to `model`, or null if no bone is usable.
 */
export function translationFromBones(
  model: ArrayLike<number>,
  image: ArrayLike<number>,
  k: Intrinsics,
  options: BoneDepthOptions = {},
): Float64Array | null {
  const { pixelNoise = 2, tiltNoise = 0.15 } = options;
  const f = (k.fx + k.fy) / 2;
  const depths: number[] = [];
  const weights: number[] = [];
  let bound = Infinity;
  for (let j = 1; j < NUM_JOINTS; j++) {
    const p = JOINT_PARENTS[j];
    const a = Math.hypot(
      (image[j * 2] - image[p * 2]) / k.fx,
      (image[j * 2 + 1] - image[p * 2 + 1]) / k.fy,
    );
    const apx = a * f;
    if (apx < 5) continue;
    const dx = model[j * 3] - model[p * 3];
    const dy = model[j * 3 + 1] - model[p * 3 + 1];
    const dz = model[j * 3 + 2] - model[p * 3 + 2];
    const L = Math.hypot(dx, dy, dz);
    if (L < 1e-6) continue;
    const c = Math.hypot(dx, dy) / L;
    const midZ = (model[j * 3 + 2] + model[p * 3 + 2]) / 2;
    depths.push((L * c) / a - midZ);
    // Relative variance of the depth estimate: tilt error + 2D length error.
    const tan = Math.sqrt(Math.max(0, 1 - c * c)) / Math.max(c, 1e-3);
    weights.push(1 / ((tan * tiltNoise) ** 2 + (pixelNoise / apx) ** 2));
    // Upper bound, loosened by the 2D noise so a noisy short bone can't clamp it.
    if (apx > 30) bound = Math.min(bound, (L / a) * (1 + (2 * pixelNoise) / apx) - midZ);
  }
  if (!depths.length) return null;
  const tz = Math.min(weightedMedian(depths, weights), bound);

  let tx = 0, ty = 0;
  for (let i = 0; i < NUM_JOINTS; i++) {
    const z = model[i * 3 + 2] + tz;
    tx += ((image[i * 2] - k.cx) / k.fx) * z - model[i * 3];
    ty += ((image[i * 2 + 1] - k.cy) / k.fy) * z - model[i * 3 + 1];
  }
  return Float64Array.of(tx / NUM_JOINTS, ty / NUM_JOINTS, tz);
}
