import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { onVideoFrame, openCamera, type CameraHandle } from '../camera';
import { OneEuroFilter, type OneEuroOptions } from '../filter/oneEuro';
import { retarget, translationFromBones } from '../geometry/bones';
import { reprojectionError, solvePose, transformPoints, type Pose } from '../geometry/solvePose';
import {
  intrinsicsFromCalibration,
  loadCalibration,
  scaleIntrinsics,
  type Intrinsics,
} from '../intrinsics';
import {
  NUM_JOINTS,
  type Hand3D,
  type HandFrameListener,
  type HandTrackerBackend,
  type Handedness,
} from '../types';

const MEDIAPIPE_VERSION = '1.1.0';
export const DEFAULT_WASM_PATH = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
export const DEFAULT_MODEL_PATH =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task';

export interface MonocularOptions {
  /** Video to track. If omitted, a camera is opened (see `deviceId`). */
  video?: HTMLVideoElement;
  deviceId?: string;
  /** Camera intrinsics. If omitted: stored calibration for this camera, else a default FOV. */
  intrinsics?: Intrinsics;
  /** Multiplier on MediaPipe's average-sized hand. If omitted: stored calibration, else 1. */
  handScale?: number;
  /** Also solve for hand rotation instead of trusting MediaPipe's world orientation ('pnp' only). */
  refineRotation?: boolean;
  /**
   * How to place the hand in depth.
   * - 'pnp': fit all joints' reprojection (default). Best if MediaPipe's relative
   *   joint depths are accurate.
   * - 'bones': per-bone depth L·cos(tilt)/(image length), trusting bones that lie
   *   flat to the camera. More robust if MediaPipe flattens or distorts depth.
   * Either way, calibrated bone lengths (if any) replace MediaPipe's per-frame
   * hand size, which is what makes the distance drift with pose.
   */
  depthMethod?: DepthMethod;
  /** Calibrated bone lengths per hand. If omitted: stored calibration. */
  boneLengths?: BoneLengthsByHand;
  /** One Euro filter settings for the output joints, or false to disable. */
  smoothing?: OneEuroOptions | false;
  numHands?: number;
  /** Set true if the frames given to the tracker are already mirrored (selfie view). */
  mirroredInput?: boolean;
  delegate?: 'GPU' | 'CPU';
  wasmPath?: string;
  modelAssetPath?: string;
}

export type DepthMethod = 'pnp' | 'bones';
export type BoneLengthsByHand = Partial<Record<Handedness, ArrayLike<number>>>;

/**
 * Single-camera 3D hands: MediaPipe gives each hand's metric shape (world
 * landmarks, origin at the hand centre) and its 2D image landmarks; a
 * perspective-n-point solve places that shape in the camera frame.
 */
export class MonocularHandTracker implements HandTrackerBackend {
  intrinsics: Intrinsics | null;
  handScale: number;
  refineRotation: boolean;
  depthMethod: DepthMethod;
  boneLengths: BoneLengthsByHand;
  camera: CameraHandle | null = null;
  /** Identifier used for stored calibration, available after start(). */
  cameraId = '';

  private readonly options: MonocularOptions;
  private readonly listeners = new Set<HandFrameListener>();
  private readonly filters = new Map<Handedness, OneEuroFilter>();
  private landmarker: HandLandmarker | null = null;
  private video: HTMLVideoElement | null = null;
  private stopLoop: (() => void) | null = null;
  private lastTimestamp = -Infinity;

  constructor(options: MonocularOptions = {}) {
    this.options = options;
    this.intrinsics = options.intrinsics ?? null;
    this.handScale = options.handScale ?? 1;
    this.refineRotation = options.refineRotation ?? false;
    this.depthMethod = options.depthMethod ?? 'pnp';
    this.boneLengths = options.boneLengths ?? {};
  }

  onFrame(listener: HandFrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.stopLoop) return;
    const o = this.options;
    if (o.video) {
      this.video = o.video;
      const track = (o.video.srcObject as MediaStream | null)?.getVideoTracks()[0];
      this.cameraId = track ? track.getSettings().deviceId || track.label : 'video';
    } else {
      this.camera = await openCamera({ deviceId: o.deviceId });
      this.video = this.camera.video;
      this.cameraId = this.camera.cameraId;
    }

    // Reload per-camera calibration on every start, since the camera may have changed.
    const stored = loadCalibration(this.cameraId);
    if (o.handScale === undefined) this.handScale = stored.handScale ?? 1;
    if (!o.boneLengths) this.boneLengths = stored.boneLengths ?? {};
    if (!o.intrinsics) {
      this.intrinsics = intrinsicsFromCalibration(
        this.video.videoWidth,
        this.video.videoHeight,
        stored,
      );
    }

    if (!this.landmarker) {
      const fileset = await FilesetResolver.forVisionTasks(o.wasmPath ?? DEFAULT_WASM_PATH);
      this.landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: o.modelAssetPath ?? DEFAULT_MODEL_PATH,
          delegate: o.delegate ?? 'GPU',
        },
        runningMode: 'VIDEO',
        numHands: o.numHands ?? 2,
      });
    }
    this.stopLoop = onVideoFrame(this.video, (t) => this.process(t));
  }

  stop(): void {
    this.stopLoop?.();
    this.stopLoop = null;
    this.camera?.stop();
    this.camera = null;
    this.filters.clear();
  }

  /** Release the MediaPipe model as well. */
  dispose(): void {
    this.stop();
    this.landmarker?.close();
    this.landmarker = null;
  }

  private process(captureTime: number): void {
    const video = this.video;
    if (!video || !this.landmarker || !this.intrinsics || !video.videoWidth) return;
    // MediaPipe requires strictly increasing timestamps.
    const timestamp = Math.max(captureTime, this.lastTimestamp + 0.001);
    this.lastTimestamp = timestamp;

    const width = video.videoWidth, height = video.videoHeight;
    if (this.intrinsics.width !== width || this.intrinsics.height !== height) {
      this.intrinsics = scaleIntrinsics(this.intrinsics, width, height);
    }
    const k = this.intrinsics;
    const result = this.landmarker.detectForVideo(video, timestamp);

    const hands: Hand3D[] = [];
    const seen = new Set<Handedness>();
    for (let h = 0; h < result.landmarks.length; h++) {
      const image = new Float32Array(NUM_JOINTS * 2);
      const world = new Float32Array(NUM_JOINTS * 3);
      result.landmarks[h].forEach((p, i) => {
        image[i * 2] = p.x * width;
        image[i * 2 + 1] = p.y * height;
      });
      result.worldLandmarks[h].forEach((p, i) => {
        world[i * 3] = p.x;
        world[i * 3 + 1] = p.y;
        world[i * 3 + 2] = p.z;
      });
      // MediaPipe's label is correct for unmirrored camera frames (verified in the demo).
      const category = result.handedness[h]?.[0];
      let handedness: Handedness = category?.categoryName === 'Left' ? 'Left' : 'Right';
      if (this.options.mirroredInput) handedness = handedness === 'Left' ? 'Right' : 'Left';

      const lengths = this.boneLengths[handedness];
      const model = lengths ? retarget(world, lengths) : world.map((v) => v * this.handScale);
      const pose = this.placeHand(model, image, k);
      const joints = transformPoints(model, pose);

      if (this.options.smoothing !== false && !seen.has(handedness)) {
        let filter = this.filters.get(handedness);
        if (!filter) {
          filter = new OneEuroFilter(this.options.smoothing ?? { minCutoff: 1.5, beta: 5 });
          this.filters.set(handedness, filter);
        }
        filter.filter(joints, timestamp);
      }
      seen.add(handedness);

      hands.push({
        handedness,
        joints,
        confidence: category?.score ?? 0,
        timestamp,
        debug: {
          landmarks2d: image,
          worldLandmarks: world,
          center: Float32Array.from(pose.translation),
          reprojectionError: pose.reprojectionError,
        },
      });
    }
    for (const key of this.filters.keys()) if (!seen.has(key)) this.filters.get(key)!.reset();
    for (const listener of this.listeners) listener(hands);
  }

  private placeHand(model: Float32Array, image: Float32Array, k: Intrinsics): Pose {
    if (this.depthMethod === 'bones') {
      const translation = translationFromBones(model, image, k);
      if (translation) {
        const pose = { rotation: Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1), translation };
        return { ...pose, reprojectionError: reprojectionError(model, image, k, pose) };
      }
    }
    return solvePose(model, image, k, { refineRotation: this.refineRotation });
  }
}
