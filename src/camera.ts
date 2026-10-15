export interface OpenCameraOptions {
  deviceId?: string;
  /** Ideal capture size; the browser may choose something else. */
  width?: number;
  height?: number;
  /** Existing <video> element to attach to; one is created otherwise. */
  video?: HTMLVideoElement;
}

export interface CameraHandle {
  video: HTMLVideoElement;
  stream: MediaStream;
  /** Stable id for storing calibration (the track's deviceId, or its label). */
  cameraId: string;
  label: string;
  stop(): void;
}

/**
 * The cameras available. Before camera permission is granted, browsers hide
 * camera names (and some list only one placeholder device); with
 * `requestPermission`, this asks for permission first if needed (a brief
 * getUserMedia that is stopped at once), so the list is complete and named.
 */
export async function listCameras(options: { requestPermission?: boolean } = {}): Promise<MediaDeviceInfo[]> {
  const list = async () => (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  let cameras = await list();
  if (options.requestPermission && (!cameras.length || cameras.some((c) => !c.label))) {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    stream.getTracks().forEach((t) => t.stop());
    cameras = await list();
  }
  return cameras;
}

/** Call `listener` with the camera list now and whenever cameras are plugged in or removed. Returns an unsubscribe function. */
export function watchCameras(
  listener: (cameras: MediaDeviceInfo[]) => void,
  options: { requestPermission?: boolean; onError?: (e: unknown) => void } = {},
): () => void {
  const update = () => listCameras(options).then(listener, options.onError ?? (() => {}));
  update();
  navigator.mediaDevices.addEventListener('devicechange', update);
  return () => navigator.mediaDevices.removeEventListener('devicechange', update);
}

export async function openCamera(options: OpenCameraOptions = {}): Promise<CameraHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      deviceId: options.deviceId ? { exact: options.deviceId } : undefined,
      width: { ideal: options.width ?? 1280 },
      height: { ideal: options.height ?? 720 },
    },
  });
  const video = options.video ?? document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();
  if (!video.videoWidth) {
    await new Promise<void>((resolve) =>
      video.addEventListener('loadedmetadata', () => resolve(), { once: true }),
    );
  }
  const track = stream.getVideoTracks()[0];
  const settings = track.getSettings();
  return {
    video,
    stream,
    cameraId: settings.deviceId || track.label,
    label: track.label,
    stop() {
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    },
  };
}

/**
 * Call `callback` once per new video frame with the frame's capture time
 * (performance.now() clock). Uses requestVideoFrameCallback where available.
 * Returns a function that stops the loop.
 */
export function onVideoFrame(
  video: HTMLVideoElement,
  callback: (timeMs: number) => void,
): () => void {
  let stopped = false;
  if (typeof video.requestVideoFrameCallback === 'function') {
    let handle = 0;
    const step = (now: number, meta: VideoFrameCallbackMetadata) => {
      if (stopped) return;
      callback(meta.captureTime ?? meta.expectedDisplayTime ?? now);
      handle = video.requestVideoFrameCallback(step);
    };
    handle = video.requestVideoFrameCallback(step);
    return () => {
      stopped = true;
      video.cancelVideoFrameCallback(handle);
    };
  }
  let lastVideoTime = -1;
  let handle = 0;
  const step = (now: number) => {
    if (stopped) return;
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      callback(now);
    }
    handle = requestAnimationFrame(step);
  };
  handle = requestAnimationFrame(step);
  return () => {
    stopped = true;
    cancelAnimationFrame(handle);
  };
}
