export interface PickCornersOptions {
  /** Set if the video is shown mirrored (e.g. CSS scaleX(-1)), so the frozen frame matches what the user sees. */
  mirrored?: boolean;
  /** Number of points to collect. */
  count?: number;
  color?: string;
  signal?: AbortSignal;
}

/**
 * Freeze the current video frame over the video element and let the user click
 * points on it (Escape cancels). Resolves with the points in image pixels
 * (count × 2, flattened), undoing letterboxing and mirroring. Rejects with an
 * AbortError DOMException if cancelled.
 *
 * Assumes the video is displayed with object-fit: contain (the default for
 * <video>). For a rectangle, click its corners in order around its edge.
 */
export function pickCorners(video: HTMLVideoElement, options: PickCornersOptions = {}): Promise<Float32Array> {
  const { mirrored = false, count = 4, color = '#ffd23f', signal } = options;
  const width = video.videoWidth, height = video.videoHeight;
  if (!width) return Promise.reject(new DOMException('Video has no frame yet', 'InvalidStateError'));

  const frame = document.createElement('canvas');
  frame.width = width;
  frame.height = height;
  frame.getContext('2d')!.drawImage(video, 0, 0);

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
  const points: number[] = [];

  const draw = () => {
    ctx.drawImage(frame, 0, 0);
    const r = Math.max(3, width / 200);
    ctx.strokeStyle = ctx.fillStyle = color;
    ctx.lineWidth = r / 2;
    ctx.beginPath();
    for (let i = 0; i < points.length; i += 2) {
      if (i) ctx.lineTo(points[i], points[i + 1]);
      else ctx.moveTo(points[i], points[i + 1]);
    }
    if (points.length === count * 2) ctx.closePath();
    ctx.stroke();
    for (let i = 0; i < points.length; i += 2) {
      ctx.beginPath();
      ctx.arc(points[i], points[i + 1], r, 0, Math.PI * 2);
      ctx.fill();
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
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
    };
    canvas.addEventListener('click', (e) => {
      // Click → image pixels: undo the mirror and object-fit: contain letterboxing.
      const rect = canvas.getBoundingClientRect();
      const scale = Math.min(rect.width / width, rect.height / height);
      let x = e.clientX - rect.left;
      if (mirrored) x = rect.width - x;
      points.push(
        (x - (rect.width - width * scale) / 2) / scale,
        (e.clientY - rect.top - (rect.height - height * scale) / 2) / scale,
      );
      draw();
      if (points.length < count * 2) return;
      // Leave the closed shape visible briefly.
      setTimeout(() => {
        cleanup();
        resolve(Float32Array.from(points));
      }, 250);
    });
    addEventListener('resize', place);
    addEventListener('scroll', place, true);
    addEventListener('keydown', onKey);
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
  });
}
