import {
  fovFromIntrinsics,
  intrinsicsFromFov,
  loadCalibration,
  saveCalibration,
  type Intrinsics,
  type StoredCalibration,
} from '../intrinsics';
import { median } from '../geometry/numeric';
import type { HandFrameListener, Handedness, Hand3D } from '../types';
import { calibrateHandsBoneLengths, type HandSkeleton } from './bones';
import { focalFromDistance, handScaleFromLength } from './index';
import {
  KNOWN_LENGTHS,
  KNOWN_RECTANGLES,
  focalFromRectangle,
  handScaleFromGrip,
  type KnownLength,
  type KnownRectangle,
} from './objects';

/** The parts of a tracker the calibrator reads and writes. MonocularHandTracker implements it. */
export interface CalibratableTracker {
  intrinsics: Intrinsics | null;
  handScale: number;
  skeletons: Partial<Record<Handedness, { lengths: ArrayLike<number>; palm: ArrayLike<number> }>>;
  /** Key for stored calibration; set once the tracker has started. */
  readonly cameraId: string;
  onFrame(listener: HandFrameListener): () => void;
}

export type CalibrationStep = 'handSize' | 'focal' | 'skeleton';

export interface CalibrationStatus {
  cameraId: string;
  handSize: { calibrated: boolean; scale: number };
  focal: { calibrated: boolean; fx: number | null; hfovDegrees: number | null; views: number[] };
  skeleton: Record<Handedness, boolean>;
  /** Steps not yet done, in the recommended order. */
  missing: CalibrationStep[];
}

export type CalibrationErrorCode =
  | 'not-started'
  | 'no-hand'
  | 'needs-hand-size'
  | 'degenerate-view'
  | 'unknown-object'
  | 'aborted'
  | 'failed';

export class CalibrationError extends Error {
  constructor(
    readonly code: CalibrationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CalibrationError';
  }
}

export interface CollectOptions {
  /** How long to collect frames, ms. */
  durationMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: { elapsedMs: number; durationMs: number; frames: Record<Handedness, number> }) => void;
}

export interface PrerequisiteOptions {
  /** Proceed without a calibrated hand size (uses MediaPipe's average hand). */
  allowDefaultHandSize?: boolean;
}

/**
 * Runs the calibration steps against a tracker: collects frames, computes the
 * result, applies it to the tracker, and saves it per camera (localStorage).
 *
 * Recommended order: handSize → focal → skeleton. Each method rejects with a
 * CalibrationError whose `code` says what went wrong.
 *
 * ```ts
 * const cal = tracker.calibrator;
 * await cal.handSizeFromObject('card-long');
 * cal.addRectangleView(await pickCorners(video), 'a4');
 * await cal.skeleton({ onProgress });
 * ```
 */
export class Calibrator {
  private readonly listeners = new Set<(status: CalibrationStatus) => void>();
  private stored: StoredCalibration = {};
  private storedFor: string | null = null;
  private views: number[] = [];

  constructor(private readonly tracker: CalibratableTracker) {}

  get status(): CalibrationStatus {
    const s = this.sync();
    const k = this.tracker.intrinsics;
    const skeleton = { Left: !!this.tracker.skeletons.Left, Right: !!this.tracker.skeletons.Right };
    const status: CalibrationStatus = {
      cameraId: this.tracker.cameraId,
      handSize: { calibrated: s.handScale !== undefined, scale: this.tracker.handScale },
      focal: {
        calibrated: s.focalOverWidth !== undefined,
        fx: k?.fx ?? null,
        hfovDegrees: k ? fovFromIntrinsics(k) : null,
        views: [...this.views],
      },
      skeleton,
      missing: [],
    };
    if (!status.handSize.calibrated) status.missing.push('handSize');
    if (!status.focal.calibrated) status.missing.push('focal');
    if (!skeleton.Left && !skeleton.Right) status.missing.push('skeleton');
    return status;
  }

  /** Called with the new status after every change. Returns an unsubscribe function. */
  onChange(listener: (status: CalibrationStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---------- Step 1: hand size ----------

  /**
   * Hold an object of known length by its two ends between thumb tip and index
   * fingertip, facing the camera. `object` is a KNOWN_LENGTHS id, a KnownLength,
   * or a length in metres. Resolves with the new hand scale.
   */
  async handSizeFromObject(object: string | KnownLength | number, options: CollectOptions = {}): Promise<number> {
    const length = typeof object === 'number' ? object : resolveKnown(KNOWN_LENGTHS, object).length;
    const samples = await this.collectOneHand(options);
    return this.applyHandScale(handScaleFromGrip(length, samples));
  }

  /**
   * Hold one open hand, fingers together, facing the camera. `length` is the
   * user's wrist crease → middle fingertip, metres. Resolves with the new hand scale.
   */
  async handSizeFromLength(length: number, options: CollectOptions = {}): Promise<number> {
    const samples = await this.collectOneHand(options);
    return this.applyHandScale(handScaleFromLength(length, samples));
  }

  // ---------- Step 2: focal length ----------

  /**
   * Add one view of a known rectangle (corners in image pixels, in order around
   * its edge, held tilted ~45°). The focal length becomes the median over the
   * views added so far. Returns the new focal length in pixels.
   */
  addRectangleView(corners: ArrayLike<number>, rectangle: string | KnownRectangle): number {
    const k = this.requireIntrinsics();
    const rect = resolveKnown(KNOWN_RECTANGLES, rectangle);
    const f = focalFromRectangle(corners, rect, k.cx, k.cy);
    if (f === null) {
      throw new CalibrationError('degenerate-view', 'Could not use that view: tilt the object more (~45°) and try again');
    }
    this.views.push(f);
    this.applyFocal(median(this.views));
    return this.tracker.intrinsics!.fx;
  }

  /** Forget the rectangle views (the current focal length is kept). */
  clearRectangleViews(): void {
    this.views = [];
    this.emit();
  }

  /**
   * Hold the hand centred in view at `distance` metres from the camera.
   * Needs the hand size first. Resolves with the new focal length in pixels.
   */
  async focalFromDistance(distance: number, options: CollectOptions & PrerequisiteOptions = {}): Promise<number> {
    this.requireHandSize(options);
    const k = this.requireIntrinsics();
    const samples = await this.collectOneHand(options);
    const f = focalFromDistance(k.fx, distance, samples);
    if (!Number.isFinite(f)) throw new CalibrationError('failed', 'Calibration failed');
    this.views = [];
    this.applyFocal(f);
    return f;
  }

  /** Set the focal length from a known horizontal field of view, degrees. */
  setFieldOfView(hfovDegrees: number): void {
    const k = this.requireIntrinsics();
    this.views = [];
    this.applyFocal(intrinsicsFromFov(k.width, k.height, hfovDegrees).fx);
  }

  // ---------- Step 3: skeleton ----------

  /**
   * Show both hands, fingers spread, and slowly turn them in every direction
   * (and bend the fingers) for `durationMs` (default 8 s). Learns each hand's
   * bone lengths and palm shape. Needs the hand size first.
   */
  async skeleton(
    options: CollectOptions & PrerequisiteOptions = {},
  ): Promise<Partial<Record<Handedness, HandSkeleton>>> {
    this.requireHandSize(options);
    const k = this.requireIntrinsics();
    const samples = await this.collect({ durationMs: 8000, ...options });
    const result = calibrateHandsBoneLengths(samples, k, this.tracker.handScale);
    const sides = (['Left', 'Right'] as const).filter((s) => result[s]);
    if (!sides.length) {
      throw new CalibrationError('no-hand', 'Not enough frames of either hand; keep both hands in view and try again');
    }
    const skeletons = { ...this.sync().skeletons };
    for (const side of sides) {
      const { lengths, palm } = result[side]!;
      skeletons[side] = { lengths: Array.from(lengths), palm: Array.from(palm) };
      this.tracker.skeletons[side] = skeletons[side];
    }
    this.save({ skeletons });
    return result;
  }

  // ---------- all ----------

  /** Forget all calibration for this camera and return the tracker to defaults. */
  reset(): void {
    const k = this.tracker.intrinsics;
    this.tracker.handScale = 1;
    this.tracker.skeletons = {};
    if (k) this.tracker.intrinsics = intrinsicsFromFov(k.width, k.height);
    this.views = [];
    this.stored = {};
    saveCalibration(this.tracker.cameraId, {});
    this.emit();
  }

  // ---------- internals ----------

  private applyHandScale(scale: number): number {
    if (!Number.isFinite(scale) || scale <= 0) throw new CalibrationError('failed', 'Calibration failed');
    // Skeletons carry the overall size too; rescale them to match.
    const ratio = scale / this.tracker.handScale;
    const skeletons: StoredCalibration['skeletons'] = {};
    for (const side of ['Left', 'Right'] as const) {
      const skeleton = this.tracker.skeletons[side];
      if (!skeleton) continue;
      skeletons[side] = {
        lengths: Array.from(skeleton.lengths, (l) => l * ratio),
        palm: Array.from(skeleton.palm, (v) => v * ratio),
      };
      this.tracker.skeletons[side] = skeletons[side];
    }
    this.tracker.handScale = scale;
    this.save({ handScale: scale, skeletons });
    return scale;
  }

  private applyFocal(f: number): void {
    const k = this.requireIntrinsics();
    this.tracker.intrinsics = { ...k, fx: f, fy: f };
    this.save({ focalOverWidth: f / k.width });
  }

  private save(patch: Partial<StoredCalibration>): void {
    this.stored = { ...this.sync(), ...patch };
    saveCalibration(this.tracker.cameraId, this.stored);
    this.emit();
  }

  /** Stored calibration for the tracker's current camera (reloaded if the camera changed). */
  private sync(): StoredCalibration {
    if (this.storedFor !== this.tracker.cameraId) {
      // Rectangle views belong to the previous camera.
      if (this.storedFor !== null) this.views = [];
      this.storedFor = this.tracker.cameraId;
      this.stored = loadCalibration(this.tracker.cameraId);
    }
    return this.stored;
  }

  private emit(): void {
    const status = this.status;
    for (const listener of this.listeners) listener(status);
  }

  private requireIntrinsics(): Intrinsics {
    const k = this.tracker.intrinsics;
    if (!k || !this.tracker.cameraId) throw new CalibrationError('not-started', 'Start the tracker first');
    return k;
  }

  private requireHandSize(options: PrerequisiteOptions): void {
    if (!options.allowDefaultHandSize && this.sync().handScale === undefined) {
      throw new CalibrationError('needs-hand-size', 'Calibrate the hand size first');
    }
  }

  /** The first hand in each frame, for single-hand steps. */
  private async collectOneHand(options: CollectOptions): Promise<Hand3D[]> {
    this.requireIntrinsics();
    const all = await this.collect({ durationMs: 1500, ...options }, true);
    if (!all.length) throw new CalibrationError('no-hand', 'No hand seen; hold it in view and try again');
    return all;
  }

  private collect(options: CollectOptions, firstHandOnly = false): Promise<Hand3D[]> {
    const { durationMs = 1500, signal, onProgress } = options;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new CalibrationError('aborted', 'Calibration cancelled'));
      const samples: Hand3D[] = [];
      const frames = { Left: 0, Right: 0 };
      const start = performance.now();
      const finish = () => {
        unsubscribe();
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      const abort = () => {
        finish();
        reject(new CalibrationError('aborted', 'Calibration cancelled'));
      };
      const unsubscribe = this.tracker.onFrame((hands) => {
        for (const hand of firstHandOnly ? hands.slice(0, 1) : hands) {
          samples.push(hand);
          frames[hand.handedness]++;
        }
        onProgress?.({ elapsedMs: performance.now() - start, durationMs, frames: { ...frames } });
      });
      const timer = setTimeout(() => {
        finish();
        resolve(samples);
      }, durationMs);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
}

function resolveKnown<T extends { id: string }>(list: T[], item: string | T): T {
  if (typeof item !== 'string') return item;
  const found = list.find((o) => o.id === item);
  if (!found) {
    throw new CalibrationError('unknown-object', `Unknown object "${item}"; one of ${list.map((o) => o.id).join(', ')}`);
  }
  return found;
}
