import { JOINT_PARENTS, NUM_BONES, boneLengths } from '../geometry/bones';
import { essentialFromPose } from '../geometry/linalg';
import { median } from '../geometry/numeric';
import type { Intrinsics } from '../intrinsics';
import { NUM_JOINTS, type Hand3D, type Handedness } from '../types';
import { sampsonDistance, triangulateViews, type RelativePose } from './epipolar';
import { frameInterval, groupByFrame, interpolateLandmarks, pairingLimits, type TimedHands } from './pairing';
import { fitStereo, refineRobust, sampsonPx, type PixelPairs, type StereoFit } from './robust';

/** Where camera 1 is relative to camera 0: X1 = R·X0 + t (metres). */
export interface StereoCalibration {
  R: number[];
  t: number[];
  /** Add to camera 1's timestamps to put them on camera 0's clock, ms. */
  timeOffsetMs: number;
  /** Typical (median) epipolar error over all correspondences, pixels. */
  rmsPx: number;
  inlierRatio: number;
  /** Paired hand-frames used. */
  frames: number;
  /** Source of the metric scale. */
  scaleFrom: 'skeleton' | 'handSize';
  /** Set when the fit looks poor, with advice. */
  warning?: string;
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
  /** Inlier threshold, pixels. Default: 3 % of the hand's length in pixels, at least 4. */
  thresholdPx?: number;
  random?: () => number;
  /** Receives intermediate results, for debugging. */
  onDiagnostics?: (d: StereoDiagnostics) => void;
}

/** Intermediate results of calibrateStereo (pixel units where noted). */
export interface StereoDiagnostics {
  /** Median hand length (wrist → middle tip) in pixels, and the inlier threshold derived from it. */
  handPx: number;
  thresholdPx: number;
  /** Time-offset search: offset → median Sampson distance (px) under the current pose. */
  coarse: { offset: number; sampsonPx: number }[];
  /** Fine search: offset → hand-size spread (MAD of log size) and median Sampson (px). */
  fine: { offset: number; spread: number; sampsonPx: number }[];
  chosenOffsetMs: number;
  /** Paired hand-frames from single-hand frames (initial pose) and in total (with two-hand frames). */
  singleHandPairs: number;
  totalPairs: number;
  /** Median Sampson (px) of the initial pose (at offset 0) and of the final pose. */
  initialPx: number;
  finalPx: number;
  finalInliers: number;
  correspondences: number;
  /** Per-bone ratios (true / triangulated length) used for the scale: count and quartiles. */
  scaleRatios: { count: number; q25: number; median: number; q75: number };
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

/** Hand-frames used while searching (subsampled evenly), for speed. */
const SEARCH_FRAMES = 150;

/**
 * Self-calibrate a camera pair from a hand moving in front of both, using the
 * 21 landmarks per frame as correspondences. Built for real MediaPipe
 * landmarks, which disagree between views by several pixels and include
 * garbage frames (see robust.ts):
 *   1. initial pose at offset 0 (timing error just adds noise): `fitStereo`,
 *      from RANSAC and from the rotation between MediaPipe's 3D hands;
 *   2. time offset: median epipolar error under that pose over −200…200 ms,
 *      refit, repeat finer; then, among offsets that fit about as well, the
 *      one that keeps the triangulated hand size most constant (timing errors
 *      along the epipolar lines change depth, not the epipolar error);
 *   3. final pose with two-hand frames added (paired by geometry);
 *   4. metric scale: triangulated bone lengths vs. the hand's true bone lengths
 *      (calibrated skeleton, else hand size × MediaPipe).
 * Needs the hand to move through the shared view at varied depths, and each
 * camera's field of view (the epipolar geometry can't determine them).
 */
export function calibrateStereo(input: StereoCalibrationInput, options: StereoCalibrationOptions = {}): StereoCalibration {
  const { maxOffsetMs = 200, random = Math.random, onDiagnostics } = options;
  const { k0, k1 } = input;
  const frames0 = groupByFrame(input.samples0);
  const frames1 = groupByFrame(input.samples1);
  const handPx = median(
    [...input.samples0, ...input.samples1].flatMap((h) => {
      const uv = h.debug?.landmarks2d;
      return uv ? [Math.hypot(uv[24] - uv[0], uv[25] - uv[1])] : [];
    }),
  );
  const thr = options.thresholdPx ?? Math.max(4, 0.03 * (handPx || 0));
  const pairsAt = (offset: number, pose?: RelativePose) => toPixelPairs(pairHands(frames0, frames1, k0, k1, offset, pose));
  const sub = (p: PixelPairs) => subsample(p, SEARCH_FRAMES);
  const medianPx = (pose: RelativePose, p: PixelPairs) => {
    const E = essentialFromPose(pose.R, pose.t);
    return median(Array.from({ length: p.n }, (_, i) => sampsonPx(E, k0, k1, p, i)));
  };
  const tooFew = () =>
    new StereoCalibrationError(
      'too-few-frames',
      'Not enough frames with one hand visible in both cameras (show just one hand while calibrating)',
    );

  // 1. Initial pose.
  const initial = pairsAt(0);
  if (initial.n < 100) throw tooFew();
  let fit: StereoFit | null = fitStereo(sub(initial), k0, k1, { thresholdPx: thr, random });
  if (!fit) throw new StereoCalibrationError('no-geometry', 'Could not find a consistent camera geometry; move the hand around more');
  const initialPx = fit.medianPx;

  // 2. Time offset: coarse then finer, refitting the pose at the best offset each time.
  const coarse: StereoDiagnostics['coarse'] = [];
  let offset = 0;
  for (const [from, to, step] of [[-maxOffsetMs, maxOffsetMs, 10], [-20, 20, 2]] as const) {
    let best = { offset, cost: Infinity };
    for (let o = (step === 10 ? 0 : offset) + from; o <= (step === 10 ? 0 : offset) + to; o += step) {
      const p = sub(pairsAt(o));
      if (p.n < 100) continue;
      const cost = medianPx(fit, p);
      coarse.push({ offset: o, sampsonPx: cost });
      if (cost < best.cost) best = { offset: o, cost };
    }
    if (!Number.isFinite(best.cost)) break;
    offset = best.offset;
    fit = refineRobust(fit, sub(pairsAt(offset)), k0, k1, thr);
  }
  // Fine: hand-size constancy among offsets whose epipolar fit is about as good.
  const fine: StereoDiagnostics['fine'] = [];
  for (let o = offset - 30; o <= offset + 30; o += 3) {
    const p = sub(pairsAt(o));
    if (p.n < 100) continue;
    fine.push({ offset: o, sampsonPx: medianPx(fit, p), spread: sizeSpread(p, fit, k0, k1, thr) });
  }
  if (fine.length) {
    const minPx = Math.min(...fine.map((c) => c.sampsonPx));
    offset = fine.filter((c) => c.sampsonPx <= minPx * 1.2 + 0.3).reduce((a, b) => (b.spread < a.spread ? b : a)).offset;
  }

  // 3. Final pose on all frames, two-hand frames paired by the geometry.
  const singles = pairsAt(offset);
  if (singles.n < 100) throw tooFew();
  fit = refineRobust(fit, singles, k0, k1, thr);
  const c = pairsAt(offset, fit);
  fit = refineRobust(fit, c, k0, k1, thr);

  // 4. Metric scale from bone lengths of triangulated hands.
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
  const ratios: number[] = [];
  const handedness = c.handedness ?? [];
  for (let g = 0; g < c.n / NUM_JOINTS; g++) {
    const truth = input.skeletonLengths?.[handedness[g]] ?? mpLengths.get(handedness[g]);
    if (!truth) continue;
    const joints = triangulateFrame(c, g, fit, k0, k1, thr);
    for (let j = 1; j < NUM_JOINTS; j++) {
      const a = joints[j], b = joints[JOINT_PARENTS[j]];
      if (!a || !b) continue;
      const len = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      if (len > 0) ratios.push(truth[j - 1] / len);
    }
  }
  const sorted = [...ratios].sort((a, b) => a - b);
  const q = (pr: number) => sorted[Math.floor(pr * (sorted.length - 1))] ?? NaN;
  onDiagnostics?.({
    handPx,
    thresholdPx: thr,
    coarse,
    fine,
    chosenOffsetMs: offset,
    singleHandPairs: singles.n / NUM_JOINTS,
    totalPairs: c.n / NUM_JOINTS,
    initialPx,
    finalPx: fit.medianPx,
    finalInliers: fit.inliers.length,
    correspondences: c.n,
    scaleRatios: { count: ratios.length, q25: q(0.25), median: q(0.5), q75: q(0.75) },
  });
  if (!ratios.length) throw new StereoCalibrationError('no-geometry', 'Could not triangulate the hand to set the scale');
  const scale = median(ratios);
  const inlierRatio = fit.inliers.length / c.n;
  const poor = inlierRatio < 0.5 || fit.medianPx > thr;
  return {
    R: Array.from(fit.R),
    t: Array.from(fit.t, (v) => v * scale),
    timeOffsetMs: offset,
    rmsPx: fit.medianPx,
    inlierRatio,
    frames: c.n / NUM_JOINTS,
    scaleFrom,
    ...(poor
      ? {
          warning:
            "Poor fit: set each camera's field of view (A4 step), keep the cameras still, " +
            'and move one hand slowly through the shared view.',
        }
      : {}),
  };
}

/** Each joint of hand-frame g triangulated (camera 0 coordinates), or null where it fits badly. */
function triangulateFrame(p: PixelPairs, g: number, pose: RelativePose, k0: Intrinsics, k1: Intrinsics, thr: number) {
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1], Z = [0, 0, 0];
  return Array.from({ length: NUM_JOINTS }, (_, j) => {
    const i = g * NUM_JOINTS + j;
    const r = triangulateViews([
      { R: I, t: Z, x: (p.u0[i * 2] - k0.cx) / k0.fx, y: (p.u0[i * 2 + 1] - k0.cy) / k0.fy, f: k0.fx },
      { R: pose.R, t: pose.t, x: (p.u1[i * 2] - k1.cx) / k1.fx, y: (p.u1[i * 2 + 1] - k1.cy) / k1.fy, f: k1.fx },
    ]);
    return r && r.error < thr && r.X[2] > 0 ? r.X : null;
  });
}

/** Robust spread (MAD of log) of the triangulated hand size over hand-frames. Small when timing is right. */
function sizeSpread(p: PixelPairs, pose: RelativePose, k0: Intrinsics, k1: Intrinsics, thr: number): number {
  const logs: number[] = [];
  for (let g = 0; g < p.n / NUM_JOINTS; g++) {
    const joints = triangulateFrame(p, g, pose, k0, k1, 3 * thr);
    let size = 0;
    for (let j = 1; j < NUM_JOINTS && size >= 0; j++) {
      const a = joints[j], b = joints[JOINT_PARENTS[j]];
      size = a && b ? size + Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : -1;
    }
    if (size > 0) logs.push(Math.log(size));
  }
  if (logs.length < 20) return Infinity;
  const m = median(logs);
  return median(logs.map((v) => Math.abs(v - m)));
}

/** Evenly spaced subset of at most `maxFrames` hand-frames. */
function subsample(p: PixelPairs, maxFrames: number): PixelPairs {
  const frames = p.n / NUM_JOINTS;
  if (frames <= maxFrames) return p;
  const keep = Array.from({ length: maxFrames }, (_, k) => Math.floor((k * frames) / maxFrames));
  const n = keep.length * NUM_JOINTS;
  const u0 = new Float64Array(n * 2), u1 = new Float64Array(n * 2), groups = new Int32Array(n);
  keep.forEach((g, k) => {
    u0.set(p.u0.subarray(g * NUM_JOINTS * 2, (g + 1) * NUM_JOINTS * 2), k * NUM_JOINTS * 2);
    u1.set(p.u1.subarray(g * NUM_JOINTS * 2, (g + 1) * NUM_JOINTS * 2), k * NUM_JOINTS * 2);
    groups.fill(k, k * NUM_JOINTS, (k + 1) * NUM_JOINTS);
  });
  return {
    u0, u1, groups, n,
    world: p.world && keep.map((g) => p.world![g]),
    handedness: p.handedness && keep.map((g) => p.handedness![g]),
  };
}

/**
 * The same hand in both cameras at the same instants, without trusting
 * MediaPipe's left/right labels to agree between cameras (they often don't with
 * two hands, and one swapped pair of labels can ruin the calibration):
 * - when each camera sees exactly one hand, they are paired whatever their labels;
 * - when a camera sees two hands, they are paired only if `pose` is given, by
 *   the assignment that fits its epipolar geometry clearly better.
 * The instants are the slower camera's frame times, the faster camera
 * interpolated to them. `handedness` is camera 0's label.
 */
export interface HandPair {
  /** 21 × 2 pixels in camera 0 / camera 1. */
  a: ArrayLike<number>;
  b: ArrayLike<number>;
  /** MediaPipe world landmarks in camera 0 / camera 1, if known. */
  wa?: ArrayLike<number>;
  wb?: ArrayLike<number>;
  /** Camera 0's label. */
  handedness: Handedness;
}

export function pairHands(
  frames0: TimedHands[],
  frames1: TimedHands[],
  k0: Intrinsics,
  k1: Intrinsics,
  offsetMs: number,
  pose?: RelativePose,
): HandPair[] {
  const pairs: HandPair[] = [];
  const cam1Slower = frameInterval(frames1, Infinity) > frameInterval(frames0, Infinity);
  const [slow, fast] = cam1Slower ? [frames1, frames0] : [frames0, frames1];
  const { maxGapMs, nearestMs } = pairingLimits(frameInterval(fast, Infinity));
  const E = pose ? essentialFromPose(pose.R, pose.t) : null;
  const sampson = (a: ArrayLike<number>, b: ArrayLike<number>) => {
    let total = 0;
    for (let j = 0; j < NUM_JOINTS; j++) {
      total += sampsonDistance(
        E!,
        (a[j * 2] - k0.cx) / k0.fx, (a[j * 2 + 1] - k0.cy) / k0.fy,
        (b[j * 2] - k1.cx) / k1.fx, (b[j * 2 + 1] - k1.cy) / k1.fy,
      );
    }
    return total;
  };
  for (const frame of slow) {
    const t = cam1Slower ? frame.timestamp + offsetMs : frame.timestamp - offsetMs;
    const slowHands = frame.hands.filter((h) => h.debug?.landmarks2d);
    // The fast camera's hands at t, by its own labels.
    const fastHands = (['Left', 'Right'] as const).flatMap((side) => {
      const r = interpolateLandmarks(fast, side, t, maxGapMs, nearestMs);
      return r ? [{ side, landmarks: r.landmarks, world: r.hand.debug?.worldLandmarks }] : [];
    });
    if (!slowHands.length || !fastHands.length) continue;
    const add = (slow: Hand3D, fast: (typeof fastHands)[number]) => {
      const sl = slow.debug!.landmarks2d!, sw = slow.debug!.worldLandmarks;
      pairs.push(
        cam1Slower
          ? { a: fast.landmarks, b: sl, wa: fast.world, wb: sw, handedness: fast.side }
          : { a: sl, b: fast.landmarks, wa: sw, wb: fast.world, handedness: slow.handedness },
      );
    };
    if (slowHands.length === 1 && fastHands.length === 1) {
      add(slowHands[0], fastHands[0]);
    } else if (E && slowHands.length === 2 && fastHands.length === 2) {
      const [s0, s1] = slowHands.map((h) => h.debug!.landmarks2d!);
      const [f0, f1] = fastHands.map((h) => h.landmarks);
      const cost = (a: ArrayLike<number>, b: ArrayLike<number>) => (cam1Slower ? sampson(b, a) : sampson(a, b));
      const straight = cost(s0, f0) + cost(s1, f1);
      const crossed = cost(s0, f1) + cost(s1, f0);
      if (straight < crossed * 0.5) {
        add(slowHands[0], fastHands[0]);
        add(slowHands[1], fastHands[1]);
      } else if (crossed < straight * 0.5) {
        add(slowHands[0], fastHands[1]);
        add(slowHands[1], fastHands[0]);
      }
    }
  }
  return pairs;
}

/** Hand pairs as pixel correspondences (21 per hand-frame) for the robust fit. */
export function toPixelPairs(pairs: HandPair[]): PixelPairs {
  const n = pairs.length * NUM_JOINTS;
  const u0 = new Float64Array(n * 2), u1 = new Float64Array(n * 2), groups = new Int32Array(n);
  pairs.forEach((p, g) => {
    for (let j = 0; j < NUM_JOINTS; j++) {
      const i = g * NUM_JOINTS + j;
      u0[i * 2] = p.a[j * 2];
      u0[i * 2 + 1] = p.a[j * 2 + 1];
      u1[i * 2] = p.b[j * 2];
      u1[i * 2 + 1] = p.b[j * 2 + 1];
      groups[i] = g;
    }
  });
  const world = pairs.every((p) => p.wa && p.wb) ? pairs.map((p) => ({ w0: p.wa!, w1: p.wb! })) : undefined;
  return { u0, u1, groups, n, world, handedness: pairs.map((p) => p.handedness) };
}
