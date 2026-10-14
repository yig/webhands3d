import { JOINT_PARENTS, NUM_BONES, boneLengths } from '../geometry/bones';
import { median } from '../geometry/numeric';
import type { Intrinsics } from '../intrinsics';
import { NUM_JOINTS, type Hand3D, type Handedness } from '../types';
import {
  decomposeEssential,
  ransacEssential,
  refineRelativePose,
  sampsonDistance,
  triangulate,
  triangulateLinear,
  type RelativePose,
} from './epipolar';
import { groupByFrame, interpolateLandmarks, type TimedHands } from './pairing';

/** Where camera 1 is relative to camera 0: X1 = R·X0 + t (metres). */
export interface StereoCalibration {
  R: number[];
  t: number[];
  /** Add to camera 1's timestamps to put them on camera 0's clock, ms. */
  timeOffsetMs: number;
  /** RMS epipolar (Sampson) error of the inliers, pixels. */
  rmsPx: number;
  inlierRatio: number;
  /** Paired frames used. */
  frames: number;
  /** Source of the metric scale. */
  scaleFrom: 'skeleton' | 'handSize';
}

export interface StereoCalibrationInput {
  samples0: Hand3D[];
  samples1: Hand3D[];
  k0: Intrinsics;
  k1: Intrinsics;
  /** True bone lengths per hand (calibrated skeletons), for the metric scale. */
  skeletonLengths?: Partial<Record<Handedness, ArrayLike<number>>>;
  /** Fallback scale: multiplier on MediaPipe's hand size (calibrated hand size). */
  handScale: number;
}

export interface StereoCalibrationOptions {
  /** Time offsets searched, ms (camera 1 relative to camera 0). */
  maxOffsetMs?: number;
  /** RANSAC inlier threshold, pixels. */
  thresholdPx?: number;
  random?: () => number;
}

export class StereoCalibrationError extends Error {
  constructor(
    readonly code: 'too-few-frames' | 'no-geometry',
    message: string,
  ) {
    super(message);
    this.name = 'StereoCalibrationError';
  }
}

/**
 * Self-calibrate a camera pair from a hand moving in front of both, using the
 * 21 landmarks per frame as correspondences:
 *   1. time offset: for candidate offsets, pair frames (interpolating camera 1)
 *      and keep the offset whose robust essential matrix fits best; then refine
 *      it by hand-size constancy. A timing error shifts camera 1's points along
 *      the hand's motion; where that is along the epipolar lines the epipolar
 *      fit can't see it, but it changes the triangulated depth, so the
 *      triangulated hand appears to grow and shrink as it moves. The offset
 *      that keeps its size most constant wins;
 *   2. relative pose: RANSAC 8-point essential matrix → decomposition →
 *      Levenberg–Marquardt on Sampson distances;
 *   3. metric scale: triangulated (unit-baseline) bone lengths vs. the hand's
 *      true bone lengths (calibrated skeleton, else hand size × MediaPipe).
 * Needs the hand to move through the shared view at varied depths.
 */
export function calibrateStereo(input: StereoCalibrationInput, options: StereoCalibrationOptions = {}): StereoCalibration {
  const { maxOffsetMs = 200, thresholdPx = 4, random = Math.random } = options;
  const frames0 = groupByFrame(input.samples0);
  const frames1 = groupByFrame(input.samples1);
  const f = (input.k0.fx + input.k1.fx) / 2;
  const threshold = thresholdPx / f;

  // 1. Time offset (coarse then fine), scored by median Sampson distance.
  const score = (offset: number, iterations: number) => {
    const c = correspondences(frames0, frames1, input.k0, input.k1, offset, 3000, random);
    if (c.n < 100) return { offset, cost: Infinity };
    const fit = ransacEssential(c.x0, c.x1, { iterations, threshold, random, groups: c.groups });
    if (!fit) return { offset, cost: Infinity };
    const d = Array.from({ length: c.n }, (_, i) => sampsonDistance(fit.E, c.x0[i * 2], c.x0[i * 2 + 1], c.x1[i * 2], c.x1[i * 2 + 1]));
    return { offset, cost: median(d) };
  };
  let best = { offset: 0, cost: Infinity };
  for (let o = -maxOffsetMs; o <= maxOffsetMs; o += 10) {
    const s = score(o, 120);
    if (s.cost < best.cost) best = s;
  }
  if (!Number.isFinite(best.cost)) {
    throw new StereoCalibrationError('too-few-frames', 'Not enough frames with the hand visible in both cameras');
  }
  {
    const c = correspondences(frames0, frames1, input.k0, input.k1, best.offset, 3000, random);
    const fit = ransacEssential(c.x0, c.x1, { iterations: 300, threshold, random, groups: c.groups });
    if (fit) {
      const start = decomposeEssential(fit.E, c.x0, c.x1, fit.inliers);
      let bestSpread = Infinity;
      const centre = best.offset;
      for (let o = centre - 60; o <= centre + 60; o += 4) {
        const spread = sizeSpread(frames0, frames1, input.k0, input.k1, o, start);
        if (spread < bestSpread) {
          bestSpread = spread;
          best = { offset: o, cost: best.cost };
        }
      }
      for (let o = best.offset - 3; o <= best.offset + 3; o += 1) {
        const spread = sizeSpread(frames0, frames1, input.k0, input.k1, o, start);
        if (spread < bestSpread) {
          bestSpread = spread;
          best = { offset: o, cost: best.cost };
        }
      }
    }
  }

  // 2. Relative pose at the best offset.
  const c = correspondences(frames0, frames1, input.k0, input.k1, best.offset, Infinity, random);
  const fit = ransacEssential(c.x0, c.x1, { iterations: 600, threshold, random, groups: c.groups });
  if (!fit || fit.inliers.length < 50) {
    throw new StereoCalibrationError('no-geometry', 'Could not find a consistent camera geometry; move the hand around more');
  }
  const pose = refineRelativePose(decomposeEssential(fit.E, c.x0, c.x1, fit.inliers), c.x0, c.x1, fit.inliers);

  // 3. Metric scale from bone lengths of triangulated hands.
  const ratios: number[] = [];
  const mpLengths = new Map<Handedness, Float64Array>();
  for (const side of ['Left', 'Right'] as const) {
    const lengths = input.samples0
      .filter((h) => h.handedness === side && h.debug?.worldLandmarks)
      .map((h) => boneLengths(h.debug!.worldLandmarks!));
    if (lengths.length) {
      mpLengths.set(side, Float64Array.from({ length: NUM_BONES }, (_, b) => input.handScale * median(lengths.map((l) => l[b]))));
    }
  }
  const scaleFrom = input.skeletonLengths?.Left || input.skeletonLengths?.Right ? 'skeleton' : 'handSize';
  for (const frame of c.frames) {
    const truth = input.skeletonLengths?.[frame.handedness] ?? mpLengths.get(frame.handedness);
    if (!truth) continue;
    const joints: (Float64Array | null)[] = [];
    for (let j = 0; j < NUM_JOINTS; j++) {
      const i = frame.offset + j;
      const res = triangulate(pose.R, pose.t, c.x0[i * 2], c.x0[i * 2 + 1], c.x1[i * 2], c.x1[i * 2 + 1], input.k0.fx, input.k1.fx);
      joints.push(res && res.error < thresholdPx && res.X[2] > 0 ? res.X : null);
    }
    for (let j = 1; j < NUM_JOINTS; j++) {
      const a = joints[j], b = joints[JOINT_PARENTS[j]];
      if (!a || !b) continue;
      const len = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      if (len > 0) ratios.push(truth[j - 1] / len);
    }
  }
  if (!ratios.length) throw new StereoCalibrationError('no-geometry', 'Could not triangulate the hand to set the scale');
  const scale = median(ratios);

  return {
    R: Array.from(pose.R),
    t: Array.from(pose.t, (v) => v * scale),
    timeOffsetMs: best.offset,
    rmsPx: pose.rms * f,
    inlierRatio: fit.inliers.length / c.n,
    frames: c.frames.length,
    scaleFrom,
  };
}

/**
 * Robust spread (median absolute deviation of the log) of the triangulated
 * hand size over frames, with the pose refined at this time offset. Small when
 * the offset is right.
 */
function sizeSpread(
  frames0: TimedHands[],
  frames1: TimedHands[],
  k0: Intrinsics,
  k1: Intrinsics,
  offsetMs: number,
  start: RelativePose,
): number {
  const c = correspondences(frames0, frames1, k0, k1, offsetMs, 3000);
  if (c.n < 100) return Infinity;
  const all = Array.from({ length: c.n }, (_, i) => i);
  const pose = refineRelativePose(start, c.x0, c.x1, all, 8);
  const logSizes: number[] = [];
  for (const frame of c.frames) {
    const joints: (Float64Array | null)[] = [];
    for (let j = 0; j < NUM_JOINTS; j++) {
      const i = frame.offset + j;
      joints.push(triangulateLinear(pose.R, pose.t, c.x0[i * 2], c.x0[i * 2 + 1], c.x1[i * 2], c.x1[i * 2 + 1]));
    }
    let size = 0;
    for (let j = 1; j < NUM_JOINTS; j++) {
      const a = joints[j], b = joints[JOINT_PARENTS[j]];
      if (!a || !b) {
        size = NaN;
        break;
      }
      size += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    }
    if (size > 0) logSizes.push(Math.log(size));
  }
  if (logSizes.length < 20) return Infinity;
  const m = median(logSizes);
  return median(logSizes.map((v) => Math.abs(v - m)));
}

/**
 * Normalised correspondences between camera 0 frames and camera 1 landmarks
 * interpolated to the same instant (camera 1 time = camera 0 time − offset).
 * At most `limit` correspondences, sampled by whole frames.
 */
function correspondences(
  frames0: TimedHands[],
  frames1: TimedHands[],
  k0: Intrinsics,
  k1: Intrinsics,
  offsetMs: number,
  limit: number,
  random?: () => number,
) {
  const pairs: { a: Float32Array; b: Float32Array; handedness: Handedness }[] = [];
  for (const frame of frames0) {
    for (const hand of frame.hands) {
      const a = hand.debug?.landmarks2d;
      if (!a) continue;
      const b = interpolateLandmarks(frames1, hand.handedness, frame.timestamp - offsetMs);
      if (b) pairs.push({ a, b: b.landmarks, handedness: hand.handedness });
    }
  }
  const maxFrames = Math.floor(limit / NUM_JOINTS);
  let chosen = pairs;
  if (pairs.length > maxFrames && random) {
    chosen = [...pairs];
    for (let i = chosen.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [chosen[i], chosen[j]] = [chosen[j], chosen[i]];
    }
    chosen = chosen.slice(0, maxFrames);
  } else if (pairs.length > maxFrames) {
    // Deterministic, evenly spaced (so costs at different offsets are comparable).
    chosen = Array.from({ length: maxFrames }, (_, i) => pairs[Math.floor((i * pairs.length) / maxFrames)]);
  }
  const n = chosen.length * NUM_JOINTS;
  const x0 = new Float64Array(n * 2), x1 = new Float64Array(n * 2), groups = new Int32Array(n);
  const frames: { offset: number; handedness: Handedness }[] = [];
  chosen.forEach((p, g) => {
    frames.push({ offset: g * NUM_JOINTS, handedness: p.handedness });
    for (let j = 0; j < NUM_JOINTS; j++) {
      const i = g * NUM_JOINTS + j;
      x0[i * 2] = (p.a[j * 2] - k0.cx) / k0.fx;
      x0[i * 2 + 1] = (p.a[j * 2 + 1] - k0.cy) / k0.fy;
      x1[i * 2] = (p.b[j * 2] - k1.cx) / k1.fx;
      x1[i * 2 + 1] = (p.b[j * 2 + 1] - k1.cy) / k1.fy;
      groups[i] = g;
    }
  });
  return { x0, x1, groups, n, frames };
}
