import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { onVideoFrame, openCamera, type CameraHandle } from '../camera';
import { Calibrator } from '../calibration/calibrator';
import type { OneEuroOptions } from '../filter/oneEuro';
import {
  intrinsicsFromCalibration,
  loadCalibration,
  scaleIntrinsics,
  type Intrinsics,
} from '../intrinsics';
import type { HandFrameListener, HandTrackerBackend } from '../types';
import { HandAssembler, detectionsFromResult, type DepthMethod, type SkeletonsByHand } from './assemble';

export type { DepthMethod, SkeletonsByHand } from './assemble';

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
   * How to place the hand in 3D.
   * - 'skeleton' (default): rigid fit of the calibrated palm, then each finger
   *   joint on its camera ray at its bone length from its parent. Uses
   *   MediaPipe's 3D only to choose toward/away, so foreshortening doesn't push
   *   tilted hands back. Needs a calibrated skeleton; otherwise falls back to 'pnp'.
   * - 'pnp': fit all joints of MediaPipe's 3D hand (retargeted to calibrated
   *   bone lengths if available).
   * - 'bones': per-bone depth L·cos(tilt)/(image length), trusting bones that lie
   *   flat to the camera.
   */
  depthMethod?: DepthMethod;
  /** Calibrated skeletons per hand. If omitted: stored calibration. */
  skeletons?: SkeletonsByHand;
  /** One Euro filter settings for the output joints, or false to disable. */
  smoothing?: OneEuroOptions | false;
  numHands?: number;
  /** Set true if the frames given to the tracker are already mirrored (selfie view). */
  mirroredInput?: boolean;
  delegate?: 'GPU' | 'CPU';
  wasmPath?: string;
  modelAssetPath?: string;
}

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
  skeletons: SkeletonsByHand;
  camera: CameraHandle | null = null;
  /** Identifier used for stored calibration, available after start(). */
  cameraId = '';

  private readonly options: MonocularOptions;
  private readonly listeners = new Set<HandFrameListener>();
  private readonly assembler: HandAssembler;
  private landmarker: HandLandmarker | null = null;
  private video: HTMLVideoElement | null = null;
  private stopLoop: (() => void) | null = null;
  private lastTimestamp = -Infinity;
  private calibratorInstance: Calibrator | null = null;

  constructor(options: MonocularOptions = {}) {
    this.options = options;
    this.intrinsics = options.intrinsics ?? null;
    this.handScale = options.handScale ?? 1;
    this.refineRotation = options.refineRotation ?? false;
    this.depthMethod = options.depthMethod ?? 'skeleton';
    this.skeletons = options.skeletons ?? {};
    this.assembler = new HandAssembler(options.smoothing);
  }

  /** Calibration steps for this tracker; results are applied and saved per camera. */
  /** The video being tracked (the one passed in, or the camera's), once started. */
  get videoElement(): HTMLVideoElement | null {
    return this.video ?? this.options.video ?? null;
  }

  /** The camera's name, if known (from its video track). */
  get label(): string {
    const track = (this.videoElement?.srcObject as MediaStream | null)?.getVideoTracks()[0];
    return this.camera?.label || track?.label || '';
  }

  get calibrator(): Calibrator {
    return (this.calibratorInstance ??= new Calibrator(this));
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
    if (!o.skeletons) this.skeletons = stored.skeletons ?? {};
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
    this.assembler.reset();
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
    const result = this.landmarker.detectForVideo(video, timestamp);
    const hands = this.assembler.assemble(
      detectionsFromResult(result, width, height, this.options.mirroredInput),
      timestamp,
      this.intrinsics,
      this,
    );
    for (const listener of this.listeners) listener(hands, timestamp);
  }
}
