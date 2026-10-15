import type { Calibrator } from '../calibration/calibrator';
import { PATTERN_LAYOUT, PATTERN_SQUARE, detectPattern } from '../calibration/pattern';
import { focalFromRectangle } from '../calibration/objects';
import type { Intrinsics } from '../intrinsics';

export interface ShowPatternOptions {
  /** Text under the pattern (keep it short; it is drawn dim so it can't be mistaken for the pattern). */
  message?: string;
  /** Element to fill (default: a fixed overlay over the whole page, made fullscreen if allowed). */
  container?: HTMLElement;
}

/**
 * Show the calibration pattern (see calibration/pattern.ts) for another
 * device's camera: four green disks at the corners of the largest square that
 * fits, on black. Tap/click or Escape closes it. Returns a handle to close it.
 */
export function showCalibrationPattern(options: ShowPatternOptions = {}): { close(): void } {
  const host = options.container ?? document.body;
  const overlay = document.createElement('div');
  Object.assign(overlay.style, {
    position: options.container ? 'absolute' : 'fixed',
    inset: '0',
    zIndex: '2147483647',
    background: '#000',
    cursor: 'pointer',
  });
  const canvas = document.createElement('canvas');
  Object.assign(canvas.style, { width: '100%', height: '100%', display: 'block' });
  overlay.append(canvas);
  host.append(overlay);

  const draw = () => {
    const r = overlay.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Largest centred square, inset so the disks stay clear of rounded screen corners and notches.
    const side = Math.min(canvas.width, canvas.height) * 0.78;
    const radius = side * PATTERN_LAYOUT.diskRadius;
    const spacing = side - 2 * radius;
    const x0 = (canvas.width - spacing) / 2, y0 = (canvas.height - spacing) / 2;
    ctx.fillStyle = PATTERN_LAYOUT.color;
    for (const [x, y] of [[x0, y0], [x0 + spacing, y0], [x0 + spacing, y0 + spacing], [x0, y0 + spacing]]) {
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    if (options.message) {
      ctx.fillStyle = '#555';
      ctx.font = `${Math.round(16 * dpr)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(options.message, canvas.width / 2, canvas.height / 2);
    }
  };
  draw();
  const observer = new ResizeObserver(draw);
  observer.observe(overlay);

  if (!options.container) overlay.requestFullscreen?.().catch(() => {});
  let wakeLock: { release(): Promise<void> } | null = null;
  (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock
    ?.request('screen')
    .then((l) => (wakeLock = l))
    .catch(() => {});

  const close = () => {
    observer.disconnect();
    removeEventListener('keydown', onKey);
    if (document.fullscreenElement === overlay) document.exitFullscreen().catch(() => {});
    wakeLock?.release().catch(() => {});
    overlay.remove();
  };
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
  overlay.addEventListener('click', close);
  addEventListener('keydown', onKey);
  return { close };
}

export type PatternViewState =
  /** No pattern in view. */
  | 'not-seen'
  /** Seen, but too flat to the camera to measure (tilt it 30–60°). */
  | 'too-flat'
  /** Seen, but too similar to a view already taken (move or tilt it differently). */
  | 'same-view'
  /** Taken as a new view. */
  | 'accepted';

export interface PatternCalibrationOptions {
  /** Views to collect (default 8). */
  views?: number;
  /** Give up after this long, ms (default 60 s). */
  timeoutMs?: number;
  /** How often to look for the pattern, ms. */
  intervalMs?: number;
  signal?: AbortSignal;
  onProgress?: (p: { views: number; needed: number; state: PatternViewState; corners: Float64Array | null; focal: number | null }) => void;
  /**
   * Draw live feedback over the video (detected dots, view count, what to do
   * next). Default true; set `mirrored` if the video is shown mirrored.
   */
  feedback?: boolean | { mirrored?: boolean };
}

/** Advice shown for each state. */
export const PATTERN_ADVICE: Record<PatternViewState, string> = {
  'not-seen': 'Show the four green dots to the camera',
  'too-flat': 'Tilt the screen more (30–60°)',
  'same-view': 'Now tilt it a different way',
  accepted: 'Got it — tilt it a different way',
};

/**
 * Calibrate a camera's focal length from the pattern shown on another screen:
 * watches `video`, and each time the pattern is seen tilted enough (and
 * different enough from the previous views) adds a view to `calibrator`
 * (median over views). Resolves with the focal length in pixels.
 * Move and tilt the screen (30–60°, in different directions) while it runs.
 */
export async function calibrateFromPattern(
  video: HTMLVideoElement,
  calibrator: Calibrator,
  intrinsics: () => Intrinsics | null,
  options: PatternCalibrationOptions = {},
): Promise<number> {
  const { views: needed = 8, timeoutMs = 60000, intervalMs = 150, signal, onProgress } = options;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const overlay = options.feedback === false ? null : feedbackOverlay(video, typeof options.feedback === 'object' && !!options.feedback.mirrored);
  calibrator.clearRectangleViews();
  const accepted: Float64Array[] = [];
  let focal: number | null = null;
  const start = performance.now();
  try {
    while (accepted.length < needed) {
      if (signal?.aborted) throw new DOMException('Pattern calibration cancelled', 'AbortError');
      if (performance.now() - start > timeoutMs) {
        if (accepted.length >= 3) break;
        throw new Error(
          accepted.length
            ? `Only ${accepted.length} usable views in ${timeoutMs / 1000} s; tilt the screen more, in different directions`
            : `Didn't see the pattern in ${timeoutMs / 1000} s; show the four green dots to the camera, larger in view`,
        );
      }
      await new Promise((r) => setTimeout(r, intervalMs));
      const k = intrinsics();
      if (!k || !video.videoWidth) continue;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      const corners = detectPattern(ctx.getImageData(0, 0, canvas.width, canvas.height));
      let state: PatternViewState = 'not-seen';
      if (corners) {
        // A new view only if the pattern moved noticeably since the previous ones.
        const moved = accepted.every((prev) => {
          let d = 0;
          for (let i = 0; i < 8; i++) d = Math.max(d, Math.abs(prev[i] - corners[i]));
          return d > 0.04 * canvas.width;
        });
        if (!focalFromRectangle(corners, PATTERN_SQUARE, k.cx, k.cy, k.fx)) state = 'too-flat';
        else if (!moved) state = 'same-view';
        else {
          focal = calibrator.addRectangleView(corners, PATTERN_SQUARE);
          accepted.push(corners);
          state = 'accepted';
        }
      }
      overlay?.draw(canvas.width, canvas.height, corners, state, accepted.length, needed);
      onProgress?.({ views: accepted.length, needed, state, corners, focal });
    }
  } finally {
    overlay?.remove();
  }
  return focal!;
}

/** A canvas over the video showing the detected dots, the view count and advice. */
function feedbackOverlay(video: HTMLVideoElement, mirrored: boolean) {
  const canvas = document.createElement('canvas');
  Object.assign(canvas.style, {
    position: 'fixed',
    zIndex: '2147483646',
    pointerEvents: 'none',
    objectFit: 'contain',
    transform: mirrored ? 'scaleX(-1)' : '',
  });
  const place = () => {
    const r = video.getBoundingClientRect();
    Object.assign(canvas.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  };
  place();
  document.body.append(canvas);
  addEventListener('resize', place);
  addEventListener('scroll', place, true);
  return {
    draw(width: number, height: number, corners: Float64Array | null, state: PatternViewState, views: number, needed: number) {
      place();
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;
      const unit = Math.max(3, width / 200);
      if (corners) {
        ctx.strokeStyle = state === 'accepted' ? '#3cff6e' : '#ffd23f';
        ctx.lineWidth = unit;
        ctx.beginPath();
        for (let i = 0; i < 4; i++) ctx.lineTo(corners[i * 2], corners[i * 2 + 1]);
        ctx.closePath();
        ctx.stroke();
        for (let i = 0; i < 4; i++) {
          ctx.beginPath();
          ctx.arc(corners[i * 2], corners[i * 2 + 1], unit * 3, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      // Count and advice, readable even when the video is mirrored.
      ctx.save();
      if (mirrored) {
        ctx.translate(width, 0);
        ctx.scale(-1, 1);
      }
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, height - unit * 22, width, unit * 22);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `bold ${unit * 8}px system-ui, sans-serif`;
      ctx.fillText(`${views} / ${needed} views`, width / 2, height - unit * 15);
      ctx.font = `${unit * 5}px system-ui, sans-serif`;
      ctx.fillText(PATTERN_ADVICE[state], width / 2, height - unit * 6);
      // Progress bar.
      ctx.fillStyle = '#3cff6e';
      ctx.fillRect(0, height - unit * 1.5, (width * views) / needed, unit * 1.5);
      ctx.restore();
    },
    remove() {
      removeEventListener('resize', place);
      removeEventListener('scroll', place, true);
      canvas.remove();
    },
  };
}
