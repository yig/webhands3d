import type { ViewSource } from '../backends/multiview';
import type { Intrinsics } from '../intrinsics';
import { decodeHandedness, encodeHand, type WireHand } from '../remote/protocol';
import type { StereoCalibration } from '../stereo/calibrate';
import type { Hand3D, Handedness } from '../types';

/*
 * Debug recordings: what each camera reported (2D and MediaPipe world
 * landmarks, labels, confidences, capture and arrival times) plus each
 * camera's calibration, as JSON. No images. Replay offline with
 * `npm run replay -- <file>` (test/replay.test.ts).
 */

export interface RecordedFrame {
  /** Capture time as the camera reported it (this page's clock), ms. */
  t: number;
  /** When the frame arrived here (this page's clock), ms. */
  at: number;
  hands: WireHand[];
}

export interface RecordedView {
  index: number;
  cameraId: string;
  label: string;
  /** Intrinsics at the end of the recording. */
  intrinsics: Intrinsics | null;
  handScale: number;
  skeletons: Partial<Record<Handedness, { lengths: number[]; palm: number[] }>>;
  frames: RecordedFrame[];
}

export interface Recording {
  format: 'webhands-recording';
  version: 1;
  createdAt: string;
  userAgent: string;
  /** What was happening, e.g. 'calibrate'. */
  note: string;
  durationMs: number;
  views: RecordedView[];
  /** Each camera's pose relative to camera 0 when recording started / stopped ([0] null). */
  calibrationsBefore: (StereoCalibration | null)[];
  calibrationsAfter: (StereoCalibration | null)[];
  /** Anything else worth keeping (e.g. the calibration result or error). */
  extra?: unknown;
}

/** The parts of a multi-camera tracker a Recorder needs (MultiViewHandTracker fits). */
export interface RecordableTracker {
  readonly sources: ViewSource[];
  calibrations: (StereoCalibration | null)[];
}

/**
 * Records every camera of a multi-camera tracker. Start before reproducing a
 * problem (e.g. around `tracker.calibrate()`); `stop()` returns the recording
 * (plain JSON; save it with `downloadRecording`).
 */
export class Recorder {
  private views: RecordedView[] = [];
  private unsubscribes: (() => void)[] = [];
  private startedAt = 0;
  private before: (StereoCalibration | null)[] = [];

  constructor(
    private readonly tracker: RecordableTracker,
    private readonly now: () => number = () => performance.now(),
  ) {}

  get recording(): boolean {
    return this.unsubscribes.length > 0;
  }

  start(): void {
    if (this.recording) return;
    this.startedAt = this.now();
    this.before = clone(this.tracker.calibrations);
    this.views = this.tracker.sources.map((source, index) => ({
      index,
      cameraId: source.cameraId,
      label: sourceLabel(source),
      intrinsics: null,
      handScale: source.handScale,
      skeletons: {},
      frames: [],
    }));
    this.unsubscribes = this.tracker.sources.map((source, index) =>
      source.onFrame((hands, t) => {
        this.views[index].frames.push({
          t,
          at: this.now(),
          hands: hands.flatMap((h) =>
            h.debug?.landmarks2d && h.debug.worldLandmarks
              ? [encodeHand(h.handedness, h.confidence, h.debug.landmarks2d, h.debug.worldLandmarks)]
              : [],
          ),
        });
      }),
    );
  }

  stop(note = '', extra?: unknown): Recording {
    this.unsubscribes.forEach((u) => u());
    this.unsubscribes = [];
    this.tracker.sources.forEach((source, i) => {
      const view = this.views[i];
      if (!view) return;
      view.intrinsics = source.intrinsics ? { ...source.intrinsics } : null;
      view.handScale = source.handScale;
      view.skeletons = Object.fromEntries(
        Object.entries(source.skeletons).map(([side, s]) => [side, { lengths: Array.from(s!.lengths), palm: Array.from(s!.palm) }]),
      );
    });
    return {
      format: 'webhands-recording',
      version: 1,
      createdAt: new Date().toISOString(),
      userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
      note,
      durationMs: this.now() - this.startedAt,
      views: this.views,
      calibrationsBefore: this.before,
      calibrationsAfter: clone(this.tracker.calibrations),
      extra: extra === undefined ? undefined : JSON.parse(JSON.stringify(extra, errorReplacer)),
    };
  }
}

/** One camera's recorded frames as the Hand3D samples a tracker would have emitted (joints left empty). */
export function recordedSamples(view: RecordedView): Hand3D[] {
  return view.frames.flatMap((f) =>
    f.hands.map((h) => ({
      handedness: decodeHandedness(h.h),
      joints: new Float32Array(63),
      confidence: h.c,
      timestamp: f.t,
      debug: { landmarks2d: Float32Array.from(h.uv), worldLandmarks: Float32Array.from(h.w) },
    })),
  );
}

/** Save a recording as a JSON file (browser). */
export function downloadRecording(recording: Recording, filename?: string): void {
  const blob = new Blob([JSON.stringify(recording)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename ?? `webhands-${recording.note || 'recording'}-${recording.createdAt.replace(/[:.]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function sourceLabel(source: ViewSource): string {
  const s = source as { label?: string; camera?: { label?: string } | null };
  return s.label || s.camera?.label || '';
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** JSON.stringify drops Error contents; keep name and message. */
function errorReplacer(_key: string, value: unknown) {
  return value instanceof Error ? { error: value.name, message: value.message } : value;
}
