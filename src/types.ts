/** MediaPipe's 21 hand joints, in landmark order. */
export const JOINT_NAMES = [
  'wrist',
  'thumb_cmc', 'thumb_mcp', 'thumb_ip', 'thumb_tip',
  'index_mcp', 'index_pip', 'index_dip', 'index_tip',
  'middle_mcp', 'middle_pip', 'middle_dip', 'middle_tip',
  'ring_mcp', 'ring_pip', 'ring_dip', 'ring_tip',
  'pinky_mcp', 'pinky_pip', 'pinky_dip', 'pinky_tip',
] as const;

export const NUM_JOINTS = JOINT_NAMES.length;

/** Bones as joint-index pairs, for drawing. */
export const HAND_BONES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

export type Handedness = 'Left' | 'Right';

/**
 * One tracked hand. Coordinates are in metres in the camera frame, OpenCV
 * convention: +x right, +y down, +z forward (away from the camera).
 */
export interface Hand3D {
  /** The user's actual hand (not the mirror-image label). */
  handedness: Handedness;
  /** 21 × 3 joint positions, flattened [x0, y0, z0, x1, ...]. */
  joints: Float32Array;
  /** Detection confidence in [0, 1]. */
  confidence: number;
  /** Capture time of the source frame, in milliseconds (performance.now() clock). */
  timestamp: number;
  /** Diagnostics from the backend that produced the hand; may be absent. */
  debug?: {
    /** 21 × 2 detected image landmarks in pixels. */
    landmarks2d?: Float32Array;
    /** 21 × 3 unscaled MediaPipe world landmarks (metres, hand-centred). */
    worldLandmarks?: Float32Array;
    /** Hand centre (world-landmark origin) in the camera frame, before smoothing. */
    center?: Float32Array;
    /** RMS reprojection error of `joints` against `landmarks2d`, in pixels. */
    reprojectionError?: number;
    /**
     * Multi-camera backends: 'stereo' if `joints` were triangulated from two or
     * more cameras, else 'view<i>' for the single camera they came from.
     */
    source?: string;
    /** Multi-camera backends: indices of the cameras used. */
    views?: number[];
  };
}

/** Called once per processed frame; `timestamp` is the frame's capture time (also when no hands are seen). */
export type HandFrameListener = (hands: Hand3D[], timestamp: number) => void;

/** Common interface for every tracking backend (monocular, stereo, WebXR, ...). */
export interface HandTrackerBackend {
  start(): Promise<void>;
  stop(): void;
  /** Subscribe to per-frame results. Returns an unsubscribe function. */
  onFrame(listener: HandFrameListener): () => void;
}
