import { medianPalmShape, type HandSkeleton } from '../calibration/bones';
import type { CalibratableTracker, Calibrator } from '../calibration/calibrator';
import { OneEuroFilter, type OneEuroOptions } from '../filter/oneEuro';
import { boneLengths, NUM_BONES } from '../geometry/bones';
import { essentialFromPose, mul3, mulVec3, transpose3 } from '../geometry/linalg';
import { median } from '../geometry/numeric';
import { PALM_JOINTS } from '../geometry/skeleton';
import { calibrateStereo, type StereoCalibration, type StereoCalibrationOptions } from '../stereo/calibrate';
import { sampsonDistance, triangulateViews, type ViewObservation } from '../stereo/epipolar';
import { interpolateLandmarks, type TimedHands } from '../stereo/pairing';
import {
  NUM_JOINTS,
  type Hand3D,
  type HandFrameListener,
  type HandTrackerBackend,
  type Handedness,
} from '../types';

/**
 * A camera feeding the multi-view tracker: anything that reports hands with raw
 * 2D landmarks and capture timestamps (on this page's clock) and has
 * intrinsics. A local MonocularHandTracker is one; a RemoteCamera (WebRTC) is
 * another.
 */
export interface ViewSource extends CalibratableTracker {
  start(): Promise<void>;
  stop(): void;
  /** If present, measured values (hand size, skeleton) are saved through it. */
  readonly calibrator?: Calibrator;
}

export interface MultiViewOptions {
  /** One Euro filter for output joints, or false. */
  smoothing?: OneEuroOptions | false;
  /** Median per-joint triangulation error above which a view is dropped / the hand falls back to one view, pixels. */
  maxReprojectionPx?: number;
  /** Pose of each camera relative to camera 0 (index-aligned with sources; [0] ignored). Overrides stored ones. */
  calibrations?: (StereoCalibration | null | undefined)[];
  /**
   * Keep measuring each hand's skeleton (bone lengths, palm shape) from
   * triangulated frames and update every camera's skeleton every few seconds,
   * so single-camera fallback uses measured proportions. Default true.
   */
  refineSkeleton?: boolean;
  /** Minimum time between skeleton updates while running, ms. Default 5000. */
  refineIntervalMs?: number;
  /** Clock for arrival times (performance.now() by default), for tests. */
  now?: () => number;
}

export interface ViewStatus {
  index: number;
  cameraId: string;
  /** Camera 0 is the reference and always counts as calibrated. */
  calibrated: boolean;
  calibration: StereoCalibration | null;
  /** Distance to camera 0, metres. */
  baseline: number | null;
}

export interface MultiViewStatus {
  views: ViewStatus[];
  /** Good triangulated frames collected for skeleton measurement, per hand. */
  skeletonSamples: Record<Handedness, number>;
}

export interface MultiViewCalibrationResult {
  /** Per camera (index-aligned; [0] null): the new calibration, or why it failed, or null if not attempted. */
  views: (StereoCalibration | Error | null)[];
  /** Skeletons measured from the triangulated calibration frames and applied to every camera. */
  skeletons: Partial<Record<Handedness, HandSkeleton>>;
}

const STORAGE_PREFIX = 'webhands:stereo:';
/** Frames older than this (relative to the newest) are dropped from each camera's history, ms. */
const HISTORY_MS = 1000;
/** A camera counts as active if a frame from it arrived this recently, ms. */
const ACTIVE_MS = 500;
/** If camera 0 is silent this long, another camera drives the output, ms. */
const DRIVER_TIMEOUT_MS = 300;
/** Margin added to the slowest active camera's typical arrival delay before fusing anyway, ms. */
const WAIT_MARGIN_MS = 30;
/** Never wait longer than this for a slow camera, ms. */
const MAX_WAIT_MS = 500;
/** Tolerance when matching a camera's frame to an instant without a frame after it, ms. */
const NEAREST_MS = 40;
/** Triangulated frames this good feed the skeleton measurement. */
const GOOD_MEDIAN_PX = 3;
const GOOD_MAX_PX = 10;
const SKELETON_BUFFER = 600;
const MIN_SKELETON_SAMPLES = 30;

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const ZERO = [0, 0, 0];

/**
 * Hands from N cameras. Camera 0 is the reference: output is in its frame and
 * on its clock. Every other camera is calibrated against camera 0 (they must
 * share some view). Per camera-0 frame, each other camera's landmarks are
 * interpolated to the same instant, hands are matched across views, and every
 * joint is triangulated from all cameras that see it. A hand seen by only one
 * camera (or whose views disagree) comes from that camera's single-view 3D.
 *
 * Triangulated hands also measure each hand's skeleton (true bone lengths and
 * palm shape), which is given to every camera for its single-view fallback.
 */
export class MultiViewHandTracker implements HandTrackerBackend {
  readonly sources: ViewSource[];
  calibrations: (StereoCalibration | null)[];

  private readonly options: MultiViewOptions;
  private readonly now: () => number;
  private readonly listeners = new Set<HandFrameListener>();
  private readonly filters = new Map<Handedness, OneEuroFilter>();
  private readonly unsubscribes = new Map<ViewSource, () => void>();
  /** Instants (camera 0's clock) waiting to be fused: the driving camera's frame times. */
  private pending: number[] = [];
  /** Per camera: recent frames, timestamps on camera 0's clock. */
  private histories: TimedHands[][] = [];
  /** Per camera: arrival time of its latest frame (this page's clock). */
  private lastArrival: number[] = [];
  /** Per camera: recent arrival delays (arrival − capture on camera 0's clock), ms. */
  private lags: number[][] = [];
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private started = false;
  private readonly skeletonSamples = { Left: [] as Float32Array[], Right: [] as Float32Array[] };
  /** Per view: triangulated hand size / that view's MediaPipe hand size. */
  private handScaleRatios: number[][] = [];
  private newSamples = 0;
  private lastRefine = 0;

  constructor(sources: ViewSource[], options: MultiViewOptions = {}) {
    this.sources = [...sources];
    this.options = options;
    this.now = options.now ?? (() => performance.now());
    this.calibrations = this.sources.map((_, i) => (i ? options.calibrations?.[i] ?? null : null));
  }

  get status(): MultiViewStatus {
    return {
      views: this.sources.map((s, index) => {
        const calibration = index ? this.calibrations[index] : null;
        return {
          index,
          cameraId: s.cameraId,
          calibrated: index === 0 || !!calibration,
          calibration,
          baseline: calibration ? Math.hypot(...calibration.t) : index === 0 ? 0 : null,
        };
      }),
      skeletonSamples: { Left: this.skeletonSamples.Left.length, Right: this.skeletonSamples.Right.length },
    };
  }

  onFrame(listener: HandFrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // Fuse waiting frames even when no camera sends anything (deadlines).
    this.flushTimer = setInterval(() => this.flush(), 50);
    // Sequentially: simultaneous getUserMedia prompts can confuse browsers.
    for (const source of this.sources) await this.attach(source);
  }

  stop(): void {
    this.started = false;
    clearInterval(this.flushTimer);
    for (const unsubscribe of this.unsubscribes.values()) unsubscribe();
    this.unsubscribes.clear();
    this.pending = [];
    this.histories = [];
    this.lastArrival = [];
    this.lags = [];
    this.filters.clear();
    this.sources.forEach((s) => s.stop());
  }

  /**
   * Add a camera while running (e.g. a phone that just connected). Loads its
   * stored calibration against camera 0, if any. Returns its index.
   */
  async addSource(source: ViewSource): Promise<number> {
    this.sources.push(source);
    this.calibrations.push(null);
    if (this.started) await this.attach(source);
    return this.sources.length - 1;
  }

  /**
   * Remove a camera; later cameras' indices shift down. Removing camera 0 (the
   * reference) re-anchors to the first remaining calibrated camera (see
   * `reanchor`), so the others keep working; output is then in that camera's
   * frame. If no other camera is calibrated, the next camera simply becomes
   * camera 0.
   */
  removeSource(source: ViewSource): void {
    let index = this.sources.indexOf(source);
    if (index < 0) return;
    if (index === 0) {
      const next = this.calibrations.findIndex((c, i) => i > 0 && !!c);
      if (next > 0) {
        this.reanchor(next);
        index = this.sources.indexOf(source);
      }
    }
    this.unsubscribes.get(source)?.();
    this.unsubscribes.delete(source);
    source.stop();
    for (const list of [this.sources, this.calibrations, this.histories, this.lastArrival, this.lags, this.handScaleRatios]) {
      (list as unknown[]).splice(index, 1);
    }
    if (index === 0) this.calibrations = this.calibrations.map(() => null);
    this.calibrations[0] = null;
    this.pending = [];
  }

  /**
   * Make calibrated camera `k` the reference (camera 0): every other camera's
   * pose and time offset are re-expressed relative to it (and saved), and the
   * old camera 0 becomes an ordinary camera. Output switches to camera k's frame.
   */
  reanchor(k: number): void {
    const ck = this.calibrations[k];
    if (k <= 0 || !ck) throw new Error(`Camera ${k} is not calibrated`);
    // X_k = R_k·X_0 + t_k  ⇒  X_j = R_j·R_kᵀ·X_k + (t_j − R_j·R_kᵀ·t_k).
    const Rkt = transpose3(ck.R);
    const rebased = this.calibrations.map((c, j): StereoCalibration | null => {
      if (j === k) return null;
      const R = j === 0 ? Rkt : mul3(c ? c.R : IDENTITY, Rkt);
      if (j !== 0 && !c) return null;
      const t = j === 0 ? ZERO : c!.t;
      const Rtk = mulVec3(R, ck.t);
      return {
        ...(c ?? ck),
        R: Array.from(R),
        t: [t[0] - Rtk[0], t[1] - Rtk[1], t[2] - Rtk[2]],
        timeOffsetMs: (j === 0 ? 0 : c!.timeOffsetMs) - ck.timeOffsetMs,
      };
    });
    const order = [k, ...this.sources.map((_, i) => i).filter((i) => i !== k)];
    const reorder = <T>(list: T[]) => order.map((i) => list[i]);
    const sources = reorder(this.sources);
    this.sources.splice(0, this.sources.length, ...sources);
    this.calibrations = reorder(rebased);
    this.calibrations[0] = null;
    this.histories = [];
    this.lastArrival = [];
    this.lags = [];
    this.handScaleRatios = reorder(this.handScaleRatios);
    this.pending = [];
    this.calibrations.forEach((c, i) => c && saveStereo(this.pairKey(i), c));
  }

  /**
   * Hold up one hand where the cameras see it and move it slowly through the
   * shared space — near and far, side to side, turning it — for `durationMs`
   * (default 12 s). Calibrates each camera in `views` (default: all but 0)
   * against camera 0, then measures the skeleton from the triangulated frames
   * and gives it to every camera. Metric scale comes from camera 0's calibrated
   * skeleton, else its hand size, so calibrate camera 0's hand size first.
   */
  async calibrate(
    options: StereoCalibrationOptions & {
      views?: number[];
      durationMs?: number;
      signal?: AbortSignal;
      onProgress?: (p: { elapsedMs: number; durationMs: number; frames: number[] }) => void;
    } = {},
  ): Promise<MultiViewCalibrationResult> {
    const n = this.sources.length;
    const targets = options.views ?? Array.from({ length: n - 1 }, (_, i) => i + 1);
    const { durationMs = 12000, signal, onProgress } = options;
    const samples: Hand3D[][] = this.sources.map(() => []);
    const start = performance.now();
    const unsubscribe = this.sources.map((source, v) =>
      source.onFrame((hands) => {
        samples[v].push(...hands);
        onProgress?.({ elapsedMs: performance.now() - start, durationMs, frames: samples.map((s) => s.length) });
      }),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, durationMs);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Calibration cancelled', 'AbortError'));
        });
      });
    } finally {
      unsubscribe.forEach((u) => u());
    }

    const s0 = this.sources[0];
    if (!s0.intrinsics) throw new Error('Start the tracker first');
    const views: (StereoCalibration | Error | null)[] = this.sources.map(() => null);
    for (const i of targets) {
      const si = this.sources[i];
      if (!si?.intrinsics) {
        views[i] = new Error(`Camera ${i} has no intrinsics yet`);
        continue;
      }
      try {
        const calibration = calibrateStereo(
          {
            samples0: samples[0],
            samples1: samples[i],
            k0: s0.intrinsics,
            k1: si.intrinsics,
            skeletonLengths: { Left: s0.skeletons.Left?.lengths, Right: s0.skeletons.Right?.lengths },
            handScale: s0.handScale,
          },
          options,
        );
        this.calibrations[i] = calibration;
        saveStereo(this.pairKey(i), calibration);
        views[i] = calibration;
      } catch (e) {
        views[i] = e instanceof Error ? e : new Error(String(e));
      }
    }

    // Measure the skeleton from the calibration frames, fused exactly as at runtime.
    const histories = this.sources.map((_, i) =>
      i === 0 ? toHistory(samples[0], 0) : this.calibrations[i] ? toHistory(samples[i], this.calibrations[i]!.timeOffsetMs) : [],
    );
    for (const frame of histories[0]) this.fuse(frame.timestamp, histories);
    const skeletons = this.applySkeletons();
    return { views, skeletons };
  }

  /** Forget the calibration of camera `index` against camera 0 (default: all). */
  resetCalibration(index?: number): void {
    for (let i = 1; i < this.sources.length; i++) {
      if (index !== undefined && i !== index) continue;
      this.calibrations[i] = null;
      saveStereo(this.pairKey(i), null);
    }
  }

  // ---------- internals ----------

  private async attach(source: ViewSource) {
    await source.start();
    const i = this.sources.indexOf(source);
    if (i > 0 && !this.options.calibrations?.[i]) this.calibrations[i] = loadStereo(this.pairKey(i));
    this.subscribe(source);
  }

  private subscribe(source: ViewSource) {
    this.unsubscribes.get(source)?.();
    this.unsubscribes.set(
      source,
      source.onFrame((hands, t) => {
        const i = this.sources.indexOf(source);
        if (i >= 0) this.onView(i, hands, t);
      }),
    );
  }

  private pairKey(i: number): string {
    return `${this.sources[0].cameraId}|${this.sources[i].cameraId}`;
  }

  /** Camera 0 plus every calibrated camera. */
  private usableViews(): number[] {
    const out = [0];
    for (let i = 1; i < this.sources.length; i++) if (this.calibrations[i]) out.push(i);
    return out;
  }

  private onView(i: number, hands: Hand3D[], captureTime: number) {
    if (i > 0 && !this.calibrations[i]) return;
    const now = this.now();
    if (this.usableViews().length < 2) {
      // Nothing to fuse yet: camera 0 passes through.
      if (i === 0) this.emit(hands.map((h) => ({ ...h, debug: { ...h.debug, source: 'view0', views: [0] } })), captureTime);
      return;
    }
    // On camera 0's clock.
    const timestamp = captureTime + (i ? this.calibrations[i]!.timeOffsetMs : 0);
    const history = (this.histories[i] ??= []);
    history.push({ timestamp, hands: hands.map((h) => ({ ...h, timestamp })) });
    while (history.length && history[0].timestamp < timestamp - HISTORY_MS) history.shift();
    this.lastArrival[i] = now;
    const lags = (this.lags[i] ??= []);
    lags.push(now - timestamp);
    if (lags.length > 30) lags.shift();
    if (i === this.driver(now)) this.pending.push(timestamp);
    this.flush();
  }

  /** The camera whose frames set the output instants: camera 0 unless it has gone quiet. */
  private driver(now: number): number {
    for (const i of this.usableViews()) {
      if (now - (this.lastArrival[i] ?? -Infinity) < DRIVER_TIMEOUT_MS) return i;
    }
    return 0;
  }

  /**
   * Fuse waiting instants once every active camera has a frame at or after
   * them, or once the slowest active camera's usual delay has passed.
   */
  private flush() {
    const now = this.now();
    const active = this.usableViews().filter((i) => now - (this.lastArrival[i] ?? -Infinity) < ACTIVE_MS);
    const wait = Math.min(
      MAX_WAIT_MS,
      Math.max(0, ...active.map((i) => percentile90(this.lags[i] ?? []))) + WAIT_MARGIN_MS,
    );
    while (this.pending.length) {
      const t = this.pending[0];
      const behind = active.some((i) => (this.histories[i]?.at(-1)?.timestamp ?? -Infinity) < t);
      if (behind && now < t + wait) break;
      this.pending.shift();
      this.emit(this.fuse(t, this.histories), t);
    }
  }

  /** All hands at instant `t` (camera 0's clock) from every usable camera's history. */
  private fuse(t: number, histories: TimedHands[][]): Hand3D[] {
    const views = this.usableViews().filter((i) => histories[i]?.length);
    // Each camera's view of each hand at t (interpolated), by its own labels.
    const seen = new Map<number, Map<Handedness, { hand: Hand3D; landmarks: ArrayLike<number> }>>();
    for (const i of views) {
      const byLabel = new Map<Handedness, { hand: Hand3D; landmarks: ArrayLike<number> }>();
      for (const side of ['Left', 'Right'] as const) {
        const b = interpolateLandmarks(histories[i], side, t, 80, NEAREST_MS);
        if (b) byLabel.set(side, b);
      }
      if (byLabel.size) seen.set(i, byLabel);
    }
    // Labels can differ between cameras; with two hands, check against the
    // first camera that sees both whether swapping fits the geometry better.
    const reference = [...seen.entries()].find(([, m]) => m.size === 2)?.[0];
    const swapped = new Set<number>();
    if (reference !== undefined) {
      for (const [i, m] of seen) if (i !== reference && m.size === 2 && this.labelsSwapped(reference, i, seen)) swapped.add(i);
    }
    const sides = new Set<Handedness>();
    for (const [i, m] of seen) for (const side of m.keys()) sides.add(swapped.has(i) ? other(side) : side);

    const out: Hand3D[] = [];
    for (const side of sides) {
      const observations: { view: number; hand: Hand3D; landmarks: ArrayLike<number> }[] = [];
      for (const [i, m] of seen) {
        const b = m.get(swapped.has(i) ? other(side) : side);
        if (b) observations.push({ view: i, ...b });
      }
      const fused = this.triangulateHand(side, observations, t);
      if (fused) {
        out.push(fused);
        continue;
      }
      // One view only, or the views disagree: the most confident single view.
      const best = observations.sort((x, y) => y.hand.confidence - x.hand.confidence)[0];
      if (!best) continue;
      const cal = best.view ? this.calibrations[best.view]! : null;
      out.push({
        ...best.hand,
        handedness: side,
        joints: cal ? toCamera0(best.hand.joints, cal) : best.hand.joints,
        timestamp: t,
        debug: { ...best.hand.debug, source: `view${best.view}`, views: [best.view] },
      });
    }
    return out;
  }

  private triangulateHand(
    side: Handedness,
    observations: { view: number; hand: Hand3D; landmarks: ArrayLike<number> }[],
    timestamp: number,
  ): Hand3D | null {
    let obs = observations;
    const maxPx = this.options.maxReprojectionPx ?? 12;
    while (obs.length >= 2) {
      const joints = new Float32Array(NUM_JOINTS * 3);
      const errors: number[] = [];
      const perView = obs.map(() => [] as number[]);
      for (let j = 0; j < NUM_JOINTS; j++) {
        const res = triangulateViews(obs.map((o) => this.observation(o.view, o.landmarks, j)));
        if (!res) return null;
        joints.set(res.X, j * 3);
        errors.push(res.error);
        res.perView.forEach((e, k) => perView[k].push(e));
      }
      const error = median(errors);
      if (error <= maxPx) {
        if (error < GOOD_MEDIAN_PX && Math.max(...errors) < GOOD_MAX_PX) this.addSkeletonSample(side, joints, obs);
        const first = obs[0].hand;
        return {
          handedness: side,
          joints,
          confidence: Math.min(...obs.map((o) => o.hand.confidence)),
          timestamp,
          debug: {
            ...first.debug,
            landmarks2d: obs[0].view === 0 ? Float32Array.from(obs[0].landmarks) : undefined,
            reprojectionError: error,
            source: 'stereo',
            views: obs.map((o) => o.view),
          },
        };
      }
      // With three or more views, drop the one that disagrees most and retry.
      if (obs.length < 3) return null;
      const worst = perView.map((e) => median(e)).reduce((w, e, k, all) => (e > all[w] ? k : w), 0);
      obs = obs.filter((_, k) => k !== worst);
    }
    return null;
  }

  private observation(view: number, landmarks: ArrayLike<number>, j: number): ViewObservation {
    const k = this.sources[view].intrinsics!;
    const cal = view ? this.calibrations[view]! : null;
    return {
      R: cal ? cal.R : IDENTITY,
      t: cal ? cal.t : ZERO,
      x: (landmarks[j * 2] - k.cx) / k.fx,
      y: (landmarks[j * 2 + 1] - k.cy) / k.fy,
      f: k.fx,
    };
  }

  /** Pose of camera b relative to camera a (X_b = R·X_a + t), from both cameras' poses relative to camera 0. */
  private relativePose(a: number, b: number): { R: ArrayLike<number>; t: ArrayLike<number> } {
    const ca = a ? this.calibrations[a]! : { R: IDENTITY, t: ZERO };
    const cb = b ? this.calibrations[b]! : { R: IDENTITY, t: ZERO };
    const R = mul3(cb.R, transpose3(ca.R));
    const Rta = mulVec3(R, ca.t);
    return { R, t: [cb.t[0] - Rta[0], cb.t[1] - Rta[1], cb.t[2] - Rta[2]] };
  }

  /** With two hands in cameras a and b, does swapping b's labels fit the epipolar geometry much better? */
  private labelsSwapped(
    a: number,
    b: number,
    seen: Map<number, Map<Handedness, { landmarks: ArrayLike<number> }>>,
  ): boolean {
    const { R, t } = this.relativePose(a, b);
    const E = essentialFromPose(R, t);
    const ka = this.sources[a].intrinsics!, kb = this.sources[b].intrinsics!;
    const cost = (swap: boolean) => {
      let total = 0;
      for (const side of ['Left', 'Right'] as const) {
        const la = seen.get(a)!.get(side)?.landmarks;
        const lb = seen.get(b)!.get(swap ? other(side) : side)?.landmarks;
        if (!la || !lb) return Infinity;
        for (let j = 0; j < NUM_JOINTS; j++) {
          total += sampsonDistance(
            E,
            (la[j * 2] - ka.cx) / ka.fx, (la[j * 2 + 1] - ka.cy) / ka.fy,
            (lb[j * 2] - kb.cx) / kb.fx, (lb[j * 2 + 1] - kb.cy) / kb.fy,
          );
        }
      }
      return total;
    };
    return cost(true) < cost(false) * 0.5;
  }

  // ---------- skeleton measurement ----------

  private addSkeletonSample(
    side: Handedness,
    joints: Float32Array,
    obs: { view: number; hand: Hand3D }[],
  ) {
    const buffer = this.skeletonSamples[side];
    buffer.push(joints);
    if (buffer.length > SKELETON_BUFFER) buffer.shift();
    const total = sum(boneLengths(joints));
    for (const o of obs) {
      const world = o.hand.debug?.worldLandmarks;
      if (!world) continue;
      const ratios = (this.handScaleRatios[o.view] ??= []);
      ratios.push(total / sum(boneLengths(world)));
      if (ratios.length > SKELETON_BUFFER) ratios.shift();
    }
    this.newSamples++;
  }

  /** Current skeleton measurements, applied to every camera. */
  private applySkeletons(): Partial<Record<Handedness, HandSkeleton>> {
    this.newSamples = 0;
    this.lastRefine = performance.now();
    const skeletons: Partial<Record<Handedness, HandSkeleton>> = {};
    for (const side of ['Left', 'Right'] as const) {
      const buffer = this.skeletonSamples[side];
      if (buffer.length < MIN_SKELETON_SAMPLES) continue;
      const all = buffer.map((j) => boneLengths(j));
      const lengths = Float64Array.from({ length: NUM_BONES }, (_, b) => median(all.map((l) => l[b])));
      const palm = medianPalmShape(buffer.map((j) => Float64Array.from(PALM_JOINTS.flatMap((p) => [j[p * 3], j[p * 3 + 1], j[p * 3 + 2]]))));
      skeletons[side] = { lengths, palm };
    }
    this.sources.forEach((source, i) => {
      // Cameras without a calibrated hand size get one measured against the triangulated hands.
      const ratios = this.handScaleRatios[i];
      if (source.calibrator && !source.calibrator.status.handSize.calibrated && ratios && ratios.length >= MIN_SKELETON_SAMPLES) {
        source.calibrator.setHandScale(median(ratios));
      }
      for (const side of ['Left', 'Right'] as const) {
        const skeleton = skeletons[side];
        if (!skeleton) continue;
        if (source.calibrator) source.calibrator.setSkeleton(side, skeleton);
        else source.skeletons[side] = skeleton;
      }
    });
    return skeletons;
  }

  private emit(hands: Hand3D[], timestamp: number) {
    const seen = new Set<Handedness>();
    for (const hand of hands) {
      if (this.options.smoothing !== false && !seen.has(hand.handedness)) {
        let filter = this.filters.get(hand.handedness);
        if (!filter) {
          filter = new OneEuroFilter(this.options.smoothing ?? { minCutoff: 1.5, beta: 5 });
          this.filters.set(hand.handedness, filter);
        }
        hand.joints = filter.filter(Float32Array.from(hand.joints), timestamp);
      }
      seen.add(hand.handedness);
    }
    for (const [side, filter] of this.filters) if (!seen.has(side)) filter.reset();
    for (const listener of this.listeners) listener(hands, timestamp);
    if (
      this.options.refineSkeleton !== false &&
      this.newSamples >= 60 &&
      performance.now() - this.lastRefine >= (this.options.refineIntervalMs ?? 5000)
    ) {
      this.applySkeletons();
    }
  }
}

/** Points in camera i's frame → camera 0's frame: X0 = Rᵀ·(Xi − t). */
export function toCamera0(points: ArrayLike<number>, cal: Pick<StereoCalibration, 'R' | 't'>): Float32Array {
  const Rt = transpose3(cal.R);
  const out = new Float32Array(points.length);
  for (let i = 0; i < points.length; i += 3) {
    out.set(mulVec3(Rt, [points[i] - cal.t[0], points[i + 1] - cal.t[1], points[i + 2] - cal.t[2]]), i);
  }
  return out;
}

/** Points in camera 0's frame → camera i's frame: Xi = R·X0 + t. */
export function fromCamera0(points: ArrayLike<number>, cal: Pick<StereoCalibration, 'R' | 't'>): Float32Array {
  const out = new Float32Array(points.length);
  for (let i = 0; i < points.length; i += 3) {
    const p = mulVec3(cal.R, [points[i], points[i + 1], points[i + 2]]);
    out[i] = p[0] + cal.t[0];
    out[i + 1] = p[1] + cal.t[1];
    out[i + 2] = p[2] + cal.t[2];
  }
  return out;
}

function toHistory(samples: Hand3D[], offsetMs: number): TimedHands[] {
  const frames = new Map<number, Hand3D[]>();
  for (const h of samples) {
    const t = h.timestamp + offsetMs;
    const list = frames.get(t);
    const shifted = { ...h, timestamp: t };
    if (list) list.push(shifted);
    else frames.set(t, [shifted]);
  }
  return [...frames.entries()].sort((a, b) => a[0] - b[0]).map(([timestamp, hands]) => ({ timestamp, hands }));
}

function percentile90(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(0.9 * (sorted.length - 1))];
}

const other = (side: Handedness): Handedness => (side === 'Left' ? 'Right' : 'Left');
const sum = (v: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i];
  return s;
};

function loadStereo(key: string): StereoCalibration | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    return raw ? (JSON.parse(raw) as StereoCalibration) : null;
  } catch {
    return null;
  }
}

function saveStereo(key: string, calibration: StereoCalibration | null) {
  try {
    if (calibration) localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(calibration));
    else localStorage.removeItem(STORAGE_PREFIX + key);
  } catch {
    // Storage unavailable; calibration lasts for this session only.
  }
}
