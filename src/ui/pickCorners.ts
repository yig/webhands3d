import { refineRectangleCorners, type EdgeFit } from '../calibration/edges';

export interface PickCornersOptions {
  /** Set if the video is shown mirrored (e.g. CSS scaleX(-1)), so the frozen frame matches what the user sees. */
  mirrored?: boolean;
  /** Number of points to collect. */
  count?: number;
  color?: string;
  signal?: AbortSignal;
}

export interface PickRectangleOptions extends Omit<PickCornersOptions, 'count'> {
  /** Snap the clicked corners to the rectangle's edges (default true). */
  snapToEdges?: boolean;
}

export interface PickedRectangle {
  /** 4 corners in image pixels, in order around the rectangle. */
  corners: Float32Array;
  /** Whether the corners were snapped to fitted edges (else they are the clicks). */
  snapped: boolean;
  /** Worst RMS distance of edge points to their fitted line, pixels (if snapped). */
  edgeRmsPx?: number;
}

/**
 * Freeze the current video frame over the video element and let the user click
 * points on it (Escape cancels). Resolves with the points in image pixels
 * (count × 2, flattened), undoing letterboxing and mirroring. Rejects with an
 * AbortError DOMException if cancelled.
 *
 * Assumes the video is displayed with object-fit: contain (the default for
 * <video>). For a rectangle, prefer `pickRectangle`.
 */
export async function pickCorners(video: HTMLVideoElement, options: PickCornersOptions = {}): Promise<Float32Array> {
  return (await pick(video, options.count ?? 4, { ...options, snapToEdges: false })).corners;
}

/**
 * Freeze the frame, let the user click a rectangle's 4 corners roughly (in
 * order around it), snap them to its edges (see refineRectangleCorners; this
 * also handles rounded corners like a credit card's), and show the fitted
 * edges for confirmation: "Use", "Redo" or "Cancel" (Esc). If the edges can't
 * be found, the clicks are offered as they are.
 */
export function pickRectangle(video: HTMLVideoElement, options: PickRectangleOptions = {}): Promise<PickedRectangle> {
  return pick(video, 4, options);
}

function pick(video: HTMLVideoElement, count: number, options: PickRectangleOptions): Promise<PickedRectangle> {
  const { mirrored = false, color = '#ffd23f', signal, snapToEdges = true } = options;
  const width = video.videoWidth, height = video.videoHeight;
  if (!width) return Promise.reject(new DOMException('Video has no frame yet', 'InvalidStateError'));

  const frame = document.createElement('canvas');
  frame.width = width;
  frame.height = height;
  const frameCtx = frame.getContext('2d', { willReadFrequently: true })!;
  frameCtx.drawImage(video, 0, 0);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  Object.assign(canvas.style, {
    position: 'fixed',
    zIndex: '2147483647',
    cursor: 'crosshair',
    objectFit: 'contain',
    background: 'transparent',
    transform: mirrored ? 'scaleX(-1)' : '',
  });
  const place = () => {
    const r = video.getBoundingClientRect();
    Object.assign(canvas.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  };
  place();
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;
  const unit = Math.max(3, width / 200);

  let points: number[] = [];
  let fit: EdgeFit | null = null;
  let confirming = false;
  // Buttons, in display (unmirrored) canvas coordinates.
  const buttons = [
    { label: 'Use', fill: '#2e9e5b' },
    { label: 'Redo', fill: '#555' },
    { label: 'Cancel', fill: '#555' },
  ].map((b, i) => {
    const w = unit * 22, h = unit * 9, gap = unit * 3;
    const total = 3 * w + 2 * gap;
    return { ...b, x: (width - total) / 2 + i * (w + gap), y: height - h - unit * 4, w, h };
  });

  const draw = () => {
    ctx.drawImage(frame, 0, 0);
    ctx.lineWidth = unit / 2;
    ctx.strokeStyle = ctx.fillStyle = color;
    const dots = (pts: ArrayLike<number>, r: number) => {
      for (let i = 0; i < pts.length; i += 2) {
        ctx.beginPath();
        ctx.arc(pts[i], pts[i + 1], r, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    const outline = (pts: ArrayLike<number>, closed: boolean) => {
      ctx.beginPath();
      for (let i = 0; i < pts.length; i += 2) {
        if (i) ctx.lineTo(pts[i], pts[i + 1]);
        else ctx.moveTo(pts[i], pts[i + 1]);
      }
      if (closed) ctx.closePath();
      ctx.stroke();
    };
    if (!confirming || !fit) {
      outline(points, points.length === count * 2);
      dots(points, unit);
    } else {
      // Clicks faint; fitted edges and snapped corners bright.
      ctx.globalAlpha = 0.4;
      dots(points, unit * 0.8);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = ctx.fillStyle = '#29e3ff';
      ctx.lineWidth = Math.max(1, unit / 3);
      outline(fit.corners, true);
      ctx.fillStyle = '#29e3ff';
      for (const side of fit.points) dots(side, Math.max(1, unit / 4));
      ctx.fillStyle = '#ff3fbf';
      dots(fit.corners, unit * 0.7);
    }
    if (confirming) {
      // Text and buttons in display orientation.
      ctx.save();
      if (mirrored) {
        ctx.translate(width, 0);
        ctx.scale(-1, 1);
      }
      ctx.font = `${unit * 5}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const message = fit
        ? `Edges found (fit ${Math.max(...fit.rmsPx).toFixed(1)} px). Do the cyan lines follow the edges?`
        : "Couldn't find the edges; using your clicks.";
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, unit * 2, width, unit * 9);
      ctx.fillStyle = '#fff';
      ctx.fillText(message, width / 2, unit * 6.5);
      for (const b of buttons) {
        ctx.fillStyle = b.fill;
        ctx.fillRect(b.x, b.y, b.w, b.h);
        ctx.fillStyle = '#fff';
        ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2);
      }
      ctx.restore();
    }
  };
  draw();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      canvas.remove();
      removeEventListener('resize', place);
      removeEventListener('scroll', place, true);
      removeEventListener('keydown', onKey);
      signal?.removeEventListener('abort', cancel);
    };
    const cancel = () => {
      cleanup();
      reject(new DOMException('Corner picking cancelled', 'AbortError'));
    };
    const finish = () => {
      cleanup();
      resolve(
        fit
          ? { corners: Float32Array.from(fit.corners), snapped: true, edgeRmsPx: Math.max(...fit.rmsPx) }
          : { corners: Float32Array.from(points), snapped: false },
      );
    };
    const redo = () => {
      points = [];
      fit = null;
      confirming = false;
      draw();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
      else if (confirming && (e.key === 'Enter' || e.key === ' ')) finish();
      else if (confirming && (e.key === 'r' || e.key === 'R')) redo();
    };
    canvas.addEventListener('click', (e) => {
      const rect = canvas.getBoundingClientRect();
      const scale = Math.min(rect.width / width, rect.height / height);
      const offX = (rect.width - width * scale) / 2, offY = (rect.height - height * scale) / 2;
      // Display coordinates (as drawn for the user), and image coordinates (undoing the mirror).
      const dx = (e.clientX - rect.left - offX) / scale, y = (e.clientY - rect.top - offY) / scale;
      const ix = mirrored ? width - dx : dx;
      if (confirming) {
        const hit = buttons.find((b) => dx >= b.x && dx <= b.x + b.w && y >= b.y && y <= b.y + b.h);
        if (hit?.label === 'Use') finish();
        else if (hit?.label === 'Redo') redo();
        else if (hit?.label === 'Cancel') cancel();
        return;
      }
      points.push(ix, y);
      draw();
      if (points.length < count * 2) return;
      if (!snapToEdges) {
        // Leave the closed shape visible briefly.
        setTimeout(finish, 250);
        return;
      }
      fit = refineRectangleCorners(frameCtx.getImageData(0, 0, width, height), points);
      confirming = true;
      draw();
    });
    addEventListener('resize', place);
    addEventListener('scroll', place, true);
    addEventListener('keydown', onKey);
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
  });
}
