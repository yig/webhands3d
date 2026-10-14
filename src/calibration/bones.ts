import { JOINT_PARENTS, NUM_BONES, boneLengths } from '../geometry/bones';
import { median, percentile } from '../geometry/numeric';
import { centroid, kabsch } from '../geometry/rigid';
import { PALM_JOINTS, placeSkeleton } from '../geometry/skeleton';
import type { Intrinsics } from '../intrinsics';
import { NUM_JOINTS, type Hand3D, type Handedness } from '../types';

/*
 * Hand skeleton calibration: bone lengths plus a rigid palm template.
 *
 * True bone lengths never change, and perspective foreshortening can only make
 * a bone look shorter. So, over a few seconds of the hand turning, each bone's
 * longest appearance (after correcting each frame for its distance) is its true
 * length. Distance and lengths are estimated alternately:
 *   1. per frame, place the skeleton with the current lengths (placeSkeleton:
 *      depth from the rigid palm, so it doesn't depend on MediaPipe's tilt);
 *   2. per bone, L = high percentile over frames of depth × normalised image length.
 * The palm template is MediaPipe's median palm shape from frames where the palm
 * faces the camera (where MediaPipe's weak depth matters least), scaled to the
 * wrist→MCP bone lengths. Everything shares one overall scale, fixed by
 * `totalLength`.
 */

/** Calibrated geometry of one hand, metres. */
export interface HandSkeleton {
  /** 20 bone lengths (bone b = joint b + 1 to its parent). */
  lengths: Float64Array;
  /** 5 × 3 palm template, PALM_JOINTS order, centred at its centroid. */
  palm: Float64Array;
}

export interface BoneCalibrationOptions {
  /** Percentile of the per-frame apparent lengths taken as the true length (not the max: noise only adds). */
  quantile?: number;
  iterations?: number;
  /** Minimum frames with this hand. */
  minFrames?: number;
}

/**
 * Bone lengths and palm template of one hand from frames where it moved around.
 * @param totalLength  sum of the 20 lengths to scale the result to.
 */
export function calibrateHandSkeleton(
  samples: Hand3D[],
  k: Intrinsics,
  totalLength: number,
  options: BoneCalibrationOptions = {},
): HandSkeleton | null {
  const { quantile = 0.9, iterations = 6, minFrames = 30 } = options;
  const frames = samples.filter((h) => h.debug?.landmarks2d && h.debug.worldLandmarks);
  if (frames.length < minFrames) return null;

  let lengths = medianBoneLengths(frames);
  rescale(lengths, totalLength);
  const palmShape = palmTemplateFromMediaPipe(frames);
  let palm = fitPalmToLengths(palmShape, lengths);
  for (let iter = 0; iter < iterations; iter++) {
    const observed: number[][] = Array.from({ length: NUM_BONES }, () => []);
    for (const hand of frames) {
      const image = hand.debug!.landmarks2d!;
      const { joints } = placeSkeleton(hand.debug!.worldLandmarks!, image, k, lengths, palm);
      for (let j = 1; j < NUM_JOINTS; j++) {
        const p = JOINT_PARENTS[j];
        const a = Math.hypot(
          (image[j * 2] - image[p * 2]) / k.fx,
          (image[j * 2 + 1] - image[p * 2 + 1]) / k.fy,
        );
        observed[j - 1].push(((joints[j * 3 + 2] + joints[p * 3 + 2]) / 2) * a);
      }
    }
    lengths = Float64Array.from(observed, (o, b) => (o.length ? percentile(o, quantile) : lengths[b]));
    // Wrist→MCP lengths come from the rigid palm (its depth fit makes them
    // self-consistent, so they carry no new information).
    for (const j of PALM_JOINTS.slice(1)) lengths[j - 1] = palmBone(palm, j);
    rescale(lengths, totalLength);
    palm = fitPalmToLengths(palmShape, lengths);
  }
  for (const j of PALM_JOINTS.slice(1)) lengths[j - 1] = palmBone(palm, j);
  return { lengths, palm };
}

/** Bone lengths only; see calibrateHandSkeleton. */
export function calibrateBoneLengths(
  samples: Hand3D[],
  k: Intrinsics,
  totalLength: number,
  options?: BoneCalibrationOptions,
): Float64Array | null {
  return calibrateHandSkeleton(samples, k, totalLength, options)?.lengths ?? null;
}

/**
 * MediaPipe's median palm shape (5 × 3, centred), from frames whose palm faces
 * the camera within ~35° (all frames if too few). Frames are rotated onto a
 * reference before taking the per-coordinate median.
 */
export function palmTemplateFromMediaPipe(frames: Hand3D[]): Float64Array {
  const palms = frames.map((h) => {
    const w = h.debug!.worldLandmarks!;
    return Float64Array.from(PALM_JOINTS.flatMap((j) => [w[j * 3], w[j * 3 + 1], w[j * 3 + 2]]));
  });
  const facing = palms.filter((p) => {
    const ax = p[3] - p[0], ay = p[4] - p[1], az = p[5] - p[2]; // wrist → index MCP
    const bx = p[12] - p[0], by = p[13] - p[1], bz = p[14] - p[2]; // wrist → pinky MCP
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    return Math.abs(nz) / Math.hypot(nx, ny, nz) > Math.cos((35 * Math.PI) / 180);
  });
  return medianPalmShape(facing.length >= 10 ? facing : palms);
}

/**
 * Median shape of several 5 × 3 palms (any position and orientation): each is
 * centred and rotated onto a reference (Kabsch), then the per-coordinate
 * median is taken. Result centred at its centroid.
 */
export function medianPalmShape(palms: ArrayLike<number>[]): Float64Array {
  let reference = centre(palms[0]);
  for (let pass = 0; pass < 2; pass++) {
    const aligned = palms.map((p) => {
      const c = centre(p);
      return rotate(kabsch(c, reference), c);
    });
    reference = Float64Array.from({ length: 15 }, (_, i) => median(aligned.map((a) => a[i])));
  }
  return centre(reference);
}

/** Scale a palm shape so its wrist→MCP distances best match the bone lengths. */
function fitPalmToLengths(palm: Float64Array, lengths: ArrayLike<number>): Float64Array {
  let num = 0, den = 0;
  for (const j of PALM_JOINTS.slice(1)) {
    const d = palmBone(palm, j);
    num += lengths[j - 1] * d;
    den += d * d;
  }
  return palm.map((v) => (v * num) / den);
}

/** Wrist → MCP distance in a palm template, for MCP joint index j. */
function palmBone(palm: ArrayLike<number>, j: number): number {
  const i = PALM_JOINTS.indexOf(j) * 3;
  return Math.hypot(palm[i] - palm[0], palm[i + 1] - palm[1], palm[i + 2] - palm[2]);
}

function centre(p: ArrayLike<number>): Float64Array {
  const c = centroid(p);
  return Float64Array.from(p, (v, i) => v - c[i % 3]);
}

function rotate(R: ArrayLike<number>, p: ArrayLike<number>): Float64Array {
  const out = new Float64Array(p.length);
  for (let i = 0; i < p.length; i += 3)
    for (let r = 0; r < 3; r++) out[i + r] = R[r * 3] * p[i] + R[r * 3 + 1] * p[i + 1] + R[r * 3 + 2] * p[i + 2];
  return out;
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
): Partial<Record<Handedness, HandSkeleton>> {
  const bySide = { Left: samples.filter((h) => h.handedness === 'Left'), Right: samples.filter((h) => h.handedness === 'Right') };
  const sides = (['Left', 'Right'] as const).filter((s) => bySide[s].length);
  const totals = sides.map((s) => sum(medianBoneLengths(bySide[s])));
  const total = (handScale * sum(totals)) / Math.max(totals.length, 1);
  const out: Partial<Record<Handedness, HandSkeleton>> = {};
  for (const side of sides) {
    const skeleton = calibrateHandSkeleton(bySide[side], k, total, options);
    if (skeleton) out[side] = skeleton;
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
