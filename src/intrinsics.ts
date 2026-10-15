/** Pinhole camera intrinsics in pixels (no lens distortion). */
export interface Intrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
}

/** Default horizontal field of view for an unknown laptop webcam. */
export const DEFAULT_HFOV_DEGREES = 60;

/**
 * Default field of view across an unknown camera's *long* image side. Laptop
 * webcams and phone main cameras are typically 65–70° across the long side; a
 * phone held in portrait is then only ~40° across its (short) width, so a
 * fixed horizontal default would be far off for it.
 */
export const DEFAULT_LONG_SIDE_FOV_DEGREES = 66;

/** Default intrinsics for an uncalibrated camera (see DEFAULT_LONG_SIDE_FOV_DEGREES). */
export function defaultIntrinsics(width: number, height: number): Intrinsics {
  const f = Math.max(width, height) / 2 / Math.tan((DEFAULT_LONG_SIDE_FOV_DEGREES * Math.PI) / 360);
  return { fx: f, fy: f, cx: width / 2, cy: height / 2, width, height };
}

/** Intrinsics from a horizontal field of view, square pixels, centred principal point. */
export function intrinsicsFromFov(
  width: number,
  height: number,
  hfovDegrees = DEFAULT_HFOV_DEGREES,
): Intrinsics {
  const f = width / 2 / Math.tan((hfovDegrees * Math.PI) / 360);
  return { fx: f, fy: f, cx: width / 2, cy: height / 2, width, height };
}

export function fovFromIntrinsics(k: Intrinsics): number {
  return (360 / Math.PI) * Math.atan(k.width / 2 / k.fx);
}

/** Rescale intrinsics to a new resolution with the same field of view. */
export function scaleIntrinsics(k: Intrinsics, width: number, height: number): Intrinsics {
  const sx = width / k.width;
  const sy = height / k.height;
  return { fx: k.fx * sx, fy: k.fy * sy, cx: k.cx * sx, cy: k.cy * sy, width, height };
}

/**
 * Per-camera calibration stored in localStorage. Focal length is stored relative
 * to the image's long side so it survives rotation and resolution changes
 * (assuming no cropping).
 */
export interface StoredCalibration {
  /**
   * fx / the image's long side, so it survives rotating the camera between
   * portrait and landscape (and resolution changes that don't crop).
   */
  focalOverLongSide?: number;
  /** Older format: fx / width (wrong after rotating the camera). Read if focalOverLongSide is absent. */
  focalOverWidth?: number;
  /** Multiplier applied to MediaPipe's world landmarks (1 = MediaPipe's average hand). */
  handScale?: number;
  /** Calibrated skeleton per hand: 20 bone lengths and a 5 × 3 palm template, metres. */
  skeletons?: { Left?: StoredSkeleton; Right?: StoredSkeleton };
}

export interface StoredSkeleton {
  lengths: number[];
  palm: number[];
}

const STORAGE_PREFIX = 'webhands:calibration:';

export function loadCalibration(cameraId: string): StoredCalibration {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + cameraId);
    return raw ? (JSON.parse(raw) as StoredCalibration) : {};
  } catch {
    return {};
  }
}

export function saveCalibration(cameraId: string, calibration: StoredCalibration): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + cameraId, JSON.stringify(calibration));
  } catch {
    // Storage unavailable (private mode etc.); calibration lasts for this session only.
  }
}

export function intrinsicsFromCalibration(
  width: number,
  height: number,
  calibration: StoredCalibration,
): Intrinsics {
  const f =
    calibration.focalOverLongSide !== undefined
      ? calibration.focalOverLongSide * Math.max(width, height)
      : calibration.focalOverWidth !== undefined
        ? calibration.focalOverWidth * width
        : undefined;
  if (f === undefined) return defaultIntrinsics(width, height);
  return { fx: f, fy: f, cx: width / 2, cy: height / 2, width, height };
}
