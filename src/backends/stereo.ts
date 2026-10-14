import type { CalibratableTracker } from '../calibration/calibrator';
import { OneEuroFilter, type OneEuroOptions } from '../filter/oneEuro';
import { essentialFromPose, mulVec3, transpose3 } from '../geometry/linalg';
import { median } from '../geometry/numeric';
import { calibrateStereo, type StereoCalibration, type StereoCalibrationOptions } from '../stereo/calibrate';
import { sampsonDistance, triangulate } from '../stereo/epipolar';
import { interpolateLandmarks, type TimedHands } from '../stereo/pairing';
import {
  NUM_JOINTS,
  type Hand3D,
  type HandFrameListener,
  type HandTrackerBackend,
  type Handedness,
} from '../types';

/**
 * A view feeding the stereo tracker: anything that reports hands with raw 2D
 * landmarks and capture timestamps, and has intrinsics. MonocularHandTracker
 * is one; a remote (WebRTC) view can be another.
 */
export interface StereoSource extends CalibratableTracker {
  start(): Promise<void>;
  stop(): void;
}

export interface StereoOptions {
  /** One Euro filter for output joints, or false. */
  smoothing?: OneEuroOptions | false;
  /** Per-joint triangulation error above which a hand falls back to one view, pixels. */
  maxReprojectionPx?: number;
  /** Use a stored calibration instead of the one saved for this camera pair. */
  calibration?: StereoCalibration;
}

export interface StereoStatus {
  calibrated: boolean;
  calibration: StereoCalibration | null;
  /** Distance between the cameras, metres. */
  baseline: number | null;
}

const STORAGE_PREFIX = 'webhands:stereo:';
/** How long a camera 0 frame waits for camera 1 to catch up before going out alone, ms. */
const MAX_WAIT_MS = 120;
const HISTORY_MS = 400;

/**
 * Two-camera 3D hands. Each source is a single-camera tracker; this pairs their
 * frames by capture time (interpolating camera 1's landmarks to camera 0's
 * instant), matches hands between views, and triangulates every joint.
 * Output is in camera 0's frame. A hand seen by only one camera (or whose views
 * disagree) falls back to that camera's single-view 3D. Until calibrated, it
 * passes camera 0's hands through.
 */
export class StereoHandTracker implements HandTrackerBackend {
  calibration: StereoCalibration | null;
  readonly sources: [StereoSource, StereoSource];

  private readonly options: StereoOptions;
  private readonly listeners = new Set<HandFrameListener>();
  private readonly filters = new Map<Handedness, OneEuroFilter>();
  private unsubscribes: (() => void)[] = [];
  private pending: TimedHands[] = [];
  private history1: TimedHands[] = [];

  constructor(sources: [StereoSource, StereoSource], options: StereoOptions = {}) {
    this.sources = sources;
    this.options = options;
    this.calibration = options.calibration ?? null;
  }

  get status(): StereoStatus {
    return {
      calibrated: !!this.calibration,
      calibration: this.calibration,
      baseline: this.calibration ? Math.hypot(...this.calibration.t) : null,
    };
  }

  onFrame(listener: HandFrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.unsubscribes.length) return;
    // Sequentially: two simultaneous getUserMedia prompts can confuse browsers.
    await this.sources[0].start();
    await this.sources[1].start();
    if (!this.options.calibration) this.calibration = loadStereo(this.pairKey);
    this.unsubscribes = [
      this.sources[0].onFrame((hands, t) => this.onView0(hands, t)),
      this.sources[1].onFrame((hands, t) => this.onView1(hands, t)),
    ];
  }

  stop(): void {
    this.unsubscribes.forEach((u) => u());
    this.unsubscribes = [];
    this.pending = [];
    this.history1 = [];
    this.filters.clear();
    this.sources.forEach((s) => s.stop());
  }

  /**
   * Wave one hand through the space both cameras see — near and far, left and
   * right, turning it — for `durationMs` (default 12 s). Uses each camera's
   * intrinsics and, for the metric scale, the calibrated skeleton (or hand size)
   * of camera 0, so calibrate those first.
   */
  async calibrate(
    options: StereoCalibrationOptions & {
      durationMs?: number;
      signal?: AbortSignal;
      onProgress?: (p: { elapsedMs: number; durationMs: number; frames: [number, number] }) => void;
    } = {},
  ): Promise<StereoCalibration> {
    const [s0, s1] = this.sources;
    if (!s0.intrinsics || !s1.intrinsics) throw new Error('Start the tracker first');
    const { durationMs = 12000, signal, onProgress } = options;
    const samples: [Hand3D[], Hand3D[]] = [[], []];
    const start = performance.now();
    const progress = () =>
      onProgress?.({ elapsedMs: performance.now() - start, durationMs, frames: [samples[0].length, samples[1].length] });
    const unsubscribe = [0, 1].map((v) =>
      this.sources[v].onFrame((hands) => {
        samples[v].push(...hands);
        progress();
      }),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, durationMs);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Stereo calibration cancelled', 'AbortError'));
        });
      });
    } finally {
      unsubscribe.forEach((u) => u());
    }
    const skeletonLengths = { Left: s0.skeletons.Left?.lengths, Right: s0.skeletons.Right?.lengths };
    const calibration = calibrateStereo(
      { samples0: samples[0], samples1: samples[1], k0: s0.intrinsics, k1: s1.intrinsics!, skeletonLengths, handScale: s0.handScale },
      options,
    );
    this.calibration = calibration;
    saveStereo(this.pairKey, calibration);
    return calibration;
  }

  /** Forget the stereo calibration for this camera pair. */
  resetCalibration(): void {
    this.calibration = null;
    saveStereo(this.pairKey, null);
  }

  private get pairKey(): string {
    return `${this.sources[0].cameraId}|${this.sources[1].cameraId}`;
  }

  private onView0(hands: Hand3D[], timestamp: number) {
    if (!this.calibration) {
      this.emit(hands.map((h) => ({ ...h, debug: { ...h.debug, source: 'view0' as const } })), timestamp);
      return;
    }
    this.pending.push({ timestamp, hands });
    this.flush(false);
  }

  private onView1(hands: Hand3D[], captureTime: number) {
    if (!this.calibration) return;
    const timestamp = captureTime + this.calibration.timeOffsetMs;
    // Store on camera 0's clock.
    this.history1.push({ timestamp, hands: hands.map((h) => ({ ...h, timestamp })) });
    const cutoff = timestamp - HISTORY_MS;
    while (this.history1.length && this.history1[0].timestamp < cutoff) this.history1.shift();
    this.flush(true);
  }

  /** Process camera 0 frames that camera 1 has caught up with (or that waited too long). */
  private flush(fromView1: boolean) {
    const latest1 = this.history1.at(-1)?.timestamp ?? -Infinity;
    const now = this.pending.at(-1)?.timestamp ?? -Infinity;
    while (this.pending.length) {
      const frame = this.pending[0];
      const caughtUp = latest1 >= frame.timestamp;
      const stale = now - frame.timestamp > MAX_WAIT_MS || (!fromView1 && latest1 === -Infinity);
      if (!caughtUp && !stale) break;
      this.pending.shift();
      this.emit(this.fuse(frame), frame.timestamp);
    }
  }

  private fuse(frame: TimedHands): Hand3D[] {
    const cal = this.calibration!;
    const k0 = this.sources[0].intrinsics!, k1 = this.sources[1].intrinsics!;
    const out: Hand3D[] = [];
    const sides = new Set<Handedness>([
      ...frame.hands.map((h) => h.handedness),
      ...this.nearestView1(frame.timestamp).map((h) => h.handedness),
    ]);
    // Hands could be labelled inconsistently between views; with two hands in
    // both, check whether swapping the labels fits the epipolar geometry better.
    const swap = this.labelsSwapped(frame);
    for (const side of sides) {
      const a = frame.hands.find((h) => h.handedness === side);
      const other: Handedness = side === 'Left' ? 'Right' : 'Left';
      const b = interpolateLandmarks(this.history1, swap ? other : side, frame.timestamp);
      const la = a?.debug?.landmarks2d;
      if (a && la && b) {
        const joints = new Float32Array(NUM_JOINTS * 3);
        const errors: number[] = [];
        for (let j = 0; j < NUM_JOINTS; j++) {
          const res = triangulate(
            cal.R, cal.t,
            (la[j * 2] - k0.cx) / k0.fx, (la[j * 2 + 1] - k0.cy) / k0.fy,
            (b.landmarks[j * 2] - k1.cx) / k1.fx, (b.landmarks[j * 2 + 1] - k1.cy) / k1.fy,
            k0.fx, k1.fx,
          );
          if (!res) break;
          joints.set(res.X, j * 3);
          errors.push(res.error);
        }
        const error = errors.length === NUM_JOINTS ? median(errors) : Infinity;
        if (error <= (this.options.maxReprojectionPx ?? 12)) {
          out.push({
            handedness: side,
            joints,
            confidence: Math.min(a.confidence, b.hand.confidence),
            timestamp: frame.timestamp,
            debug: { ...a.debug, reprojectionError: error, source: 'stereo' },
          });
          continue;
        }
      }
      // One view only (or the views disagree): use the better single-view result.
      if (a) {
        out.push({ ...a, debug: { ...a.debug, source: 'view0' } });
      } else if (b) {
        out.push({
          ...b.hand,
          handedness: side,
          joints: toCamera0(b.hand.joints, cal),
          timestamp: frame.timestamp,
          debug: { ...b.hand.debug, source: 'view1' },
        });
      }
    }
    return out;
  }

  private nearestView1(time: number): Hand3D[] {
    let best: TimedHands | undefined;
    for (const f of this.history1) if (!best || Math.abs(f.timestamp - time) < Math.abs(best.timestamp - time)) best = f;
    return best && Math.abs(best.timestamp - time) < 50 ? best.hands : [];
  }

  private labelsSwapped(frame: TimedHands): boolean {
    if (frame.hands.length < 2) return false;
    const cal = this.calibration!;
    const E = essentialFromPose(cal.R, cal.t);
    const k0 = this.sources[0].intrinsics!, k1 = this.sources[1].intrinsics!;
    const cost = (swap: boolean) => {
      let total = 0;
      for (const a of frame.hands) {
        const side = swap ? (a.handedness === 'Left' ? 'Right' : 'Left') : a.handedness;
        const b = interpolateLandmarks(this.history1, side, frame.timestamp);
        const la = a.debug?.landmarks2d;
        if (!b || !la) return Infinity;
        for (let j = 0; j < NUM_JOINTS; j++) {
          total += sampsonDistance(
            E,
            (la[j * 2] - k0.cx) / k0.fx, (la[j * 2 + 1] - k0.cy) / k0.fy,
            (b.landmarks[j * 2] - k1.cx) / k1.fx, (b.landmarks[j * 2 + 1] - k1.cy) / k1.fy,
          );
        }
      }
      return total;
    };
    return cost(true) < cost(false) * 0.5;
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
  }
}

/** Camera 1 points into camera 0's frame: X0 = Rᵀ·(X1 − t). */
export function toCamera0(points: ArrayLike<number>, cal: Pick<StereoCalibration, 'R' | 't'>): Float32Array {
  const Rt = transpose3(cal.R);
  const out = new Float32Array(points.length);
  for (let i = 0; i < points.length; i += 3) {
    const p = mulVec3(Rt, [points[i] - cal.t[0], points[i + 1] - cal.t[1], points[i + 2] - cal.t[2]]);
    out.set(p, i);
  }
  return out;
}

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
