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

export interface PatternCalibrationOptions {
  /** Views to collect (default 8). */
  views?: number;
  /** Give up after this long, ms (default 60 s). */
  timeoutMs?: number;
  /** How often to look for the pattern, ms. */
  intervalMs?: number;
  signal?: AbortSignal;
  onProgress?: (p: { views: number; needed: number; seen: boolean; focal: number | null }) => void;
}

/**
 * Calibrate a camera's focal length from the pattern shown on another screen:
 * watches `video`, and each time the pattern is seen tilted enough (and
 * different enough from the previous view) adds a view to `calibrator`
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
  calibrator.clearRectangleViews();
  const accepted: Float64Array[] = [];
  let focal: number | null = null;
  const start = performance.now();
  while (accepted.length < needed) {
    if (signal?.aborted) throw new DOMException('Pattern calibration cancelled', 'AbortError');
    if (performance.now() - start > timeoutMs) {
      if (accepted.length >= 3) break;
      throw new Error(`Saw the pattern in only ${accepted.length} usable views; tilt the screen more and keep it in view`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    const k = intrinsics();
    if (!k || !video.videoWidth) continue;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);
    const corners = detectPattern(ctx.getImageData(0, 0, canvas.width, canvas.height));
    let usable = false;
    if (corners) {
      // A new view only if the pattern moved noticeably since the last one.
      const moved = accepted.every((prev) => {
        let d = 0;
        for (let i = 0; i < 8; i++) d = Math.max(d, Math.abs(prev[i] - corners[i]));
        return d > 0.04 * canvas.width;
      });
      if (moved && focalFromRectangle(corners, PATTERN_SQUARE, k.cx, k.cy, k.fx)) {
        focal = calibrator.addRectangleView(corners, PATTERN_SQUARE);
        accepted.push(corners);
        usable = true;
      }
    }
    onProgress?.({ views: accepted.length, needed, seen: !!corners, focal: usable ? focal : focal });
  }
  return focal!;
}
