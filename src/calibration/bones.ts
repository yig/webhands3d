import { JOINT_PARENTS, NUM_BONES, boneLengths, retarget, translationFromBones } from '../geometry/bones';
import { median, percentile } from '../geometry/numeric';
import type { Intrinsics } from '../intrinsics';
import { NUM_JOINTS, type Hand3D, type Handedness } from '../types';

/*
 * Bone-length calibration. True bone lengths never change, and perspective
 * foreshortening can only make a bone look shorter. So, over a few seconds of
 * the hand turning, each bone's longest appearance (after correcting each frame
 * for its distance) is its true length. Distance and lengths are estimated
 * alternately:
 *   1. per frame, depth from the current lengths (translationFromBones);
 *   2. per bone, L = high percentile over frames of depth × normalised image length.
 * Depth and lengths share one unknown overall scale, fixed by `totalLength`.
 */

export interface BoneCalibrationOptions {
  /** Percentile of the per-frame apparent lengths taken as the true length (not the max: noise only adds). */
  quantile?: number;
  iterations?: number;
  /** Minimum frames with this hand. */
  minFrames?: number;
}

/**
 * Bone lengths (metres) of one hand from frames where it moved around.
 * @param totalLength  sum of the 20 lengths to scale the result to.
 */
export function calibrateBoneLengths(
  samples: Hand3D[],
  k: Intrinsics,
  totalLength: number,
  options: BoneCalibrationOptions = {},
): Float64Array | null {
  const { quantile = 0.9, iterations = 6, minFrames = 30 } = options;
  const frames = samples.filter((h) => h.debug?.landmarks2d && h.debug.worldLandmarks);
  if (frames.length < minFrames) return null;

  let lengths = medianBoneLengths(frames);
  rescale(lengths, totalLength);
  const model = new Float32Array(NUM_JOINTS * 3);
  for (let iter = 0; iter < iterations; iter++) {
    const observed: number[][] = Array.from({ length: NUM_BONES }, () => []);
    for (const hand of frames) {
      const image = hand.debug!.landmarks2d!;
      retarget(hand.debug!.worldLandmarks!, lengths, model);
      const t = translationFromBones(model, image, k);
      if (!t) continue;
      for (let j = 1; j < NUM_JOINTS; j++) {
        const p = JOINT_PARENTS[j];
        const a = Math.hypot(
          (image[j * 2] - image[p * 2]) / k.fx,
          (image[j * 2 + 1] - image[p * 2 + 1]) / k.fy,
        );
        const depth = t[2] + (model[j * 3 + 2] + model[p * 3 + 2]) / 2;
        observed[j - 1].push(depth * a);
      }
    }
    lengths = Float64Array.from(observed, (o, b) => (o.length ? percentile(o, quantile) : lengths[b]));
    rescale(lengths, totalLength);
  }
  return lengths;
}

/**
 * Calibrate both hands from mixed samples. The two hands share one overall
 * scale (assumes left and right hands are the same size), so their distances
 * stay consistent with each other: the total is `handScale` × MediaPipe's
 * median hand size, averaged over the hands seen.
 */
export function calibrateHandsBoneLengths(
  samples: Hand3D[],
  k: Intrinsics,
  handScale: number,
  options?: BoneCalibrationOptions,
): Partial<Record<Handedness, Float64Array>> {
  const bySide = { Left: samples.filter((h) => h.handedness === 'Left'), Right: samples.filter((h) => h.handedness === 'Right') };
  const sides = (['Left', 'Right'] as const).filter((s) => bySide[s].length);
  const totals = sides.map((s) => sum(medianBoneLengths(bySide[s])));
  const total = (handScale * sum(totals)) / Math.max(totals.length, 1);
  const out: Partial<Record<Handedness, Float64Array>> = {};
  for (const side of sides) {
    const lengths = calibrateBoneLengths(bySide[side], k, total, options);
    if (lengths) out[side] = lengths;
  }
  return out;
}

/** Collects every hand seen for a fixed duration. */
export function collectHands(
  subscribe: (listener: (hands: Hand3D[]) => void) => () => void,
  durationMs: number,
): Promise<Hand3D[]> {
  return new Promise((resolve) => {
    const samples: Hand3D[] = [];
    const unsubscribe = subscribe((hands) => samples.push(...hands));
    setTimeout(() => {
      unsubscribe();
      resolve(samples);
    }, durationMs);
  });
}

function medianBoneLengths(frames: Hand3D[]): Float64Array {
  const all = frames.map((h) => boneLengths(h.debug!.worldLandmarks!));
  return Float64Array.from({ length: NUM_BONES }, (_, b) => median(all.map((l) => l[b])));
}

function rescale(lengths: Float64Array, total: number) {
  const s = total / sum(lengths);
  for (let b = 0; b < lengths.length; b++) lengths[b] *= s;
}

function sum(values: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < values.length; i++) s += values[i];
  return s;
}
