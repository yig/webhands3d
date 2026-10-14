import type { HandLandmarkerResult } from '@mediapipe/tasks-vision';
import { OneEuroFilter, type OneEuroOptions } from '../filter/oneEuro';
import { retarget, translationFromBones } from '../geometry/bones';
import { placeSkeleton } from '../geometry/skeleton';
import { reprojectionError, solvePose, transformPoints, type Pose } from '../geometry/solvePose';
import type { Intrinsics } from '../intrinsics';
import { NUM_JOINTS, type Hand3D, type Handedness } from '../types';

/** One hand as MediaPipe reports it for one image. */
export interface Detection {
  handedness: Handedness;
  confidence: number;
  /** 21 × 2 image landmarks, pixels. */
  image: Float32Array;
  /** 21 × 3 MediaPipe world landmarks, metres, hand-centred. */
  world: Float32Array;
}

export type DepthMethod = 'skeleton' | 'pnp' | 'bones';
export type SkeletonsByHand = Partial<
  Record<Handedness, { lengths: ArrayLike<number>; palm: ArrayLike<number> }>
>;

/** Per-camera settings that turn a detection into 3D. */
export interface PlacementSettings {
  depthMethod: DepthMethod;
  handScale: number;
  skeletons: SkeletonsByHand;
  refineRotation: boolean;
}

/** MediaPipe result → detections (pixels). Labels are swapped if the frames were mirrored. */
export function detectionsFromResult(
  result: HandLandmarkerResult,
  width: number,
  height: number,
  mirroredInput = false,
): Detection[] {
  return result.landmarks.map((landmarks, h) => {
    const image = new Float32Array(NUM_JOINTS * 2);
    const world = new Float32Array(NUM_JOINTS * 3);
    landmarks.forEach((p, i) => {
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
    if (mirroredInput) handedness = handedness === 'Left' ? 'Right' : 'Left';
    return { handedness, confidence: category?.score ?? 0, image, world };
  });
}

/** Place one detected hand in the camera frame (see MonocularOptions.depthMethod). */
export function placeHand(
  detection: Pick<Detection, 'image' | 'world' | 'handedness'>,
  k: Intrinsics,
  settings: PlacementSettings,
): { joints: Float32Array; center: ArrayLike<number>; reprojectionError: number } {
  const { world, image } = detection;
  const skeleton = settings.skeletons[detection.handedness];
  if (skeleton && settings.depthMethod === 'skeleton') {
    return placeSkeleton(world, image, k, skeleton.lengths, skeleton.palm);
  }
  const model = skeleton ? retarget(world, skeleton.lengths) : world.map((v) => v * settings.handScale);
  let pose: Pose | null = null;
  if (settings.depthMethod === 'bones') {
    const translation = translationFromBones(model, image, k);
    if (translation) {
      const p = { rotation: Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1), translation };
      pose = { ...p, reprojectionError: reprojectionError(model, image, k, p) };
    }
  }
  pose ??= solvePose(model, image, k, { refineRotation: settings.refineRotation });
  return { joints: transformPoints(model, pose), center: pose.translation, reprojectionError: pose.reprojectionError };
}

/**
 * Detections → smoothed Hand3D for one camera. Shared by the local tracker and
 * remote cameras, so both produce identical output from the same landmarks.
 */
export class HandAssembler {
  private readonly filters = new Map<Handedness, OneEuroFilter>();

  constructor(private readonly smoothing: OneEuroOptions | false = { minCutoff: 1.5, beta: 5 }) {}

  assemble(detections: Detection[], timestamp: number, k: Intrinsics, settings: PlacementSettings): Hand3D[] {
    const hands: Hand3D[] = [];
    const seen = new Set<Handedness>();
    for (const d of detections) {
      const { joints, center, reprojectionError } = placeHand(d, k, settings);
      if (this.smoothing !== false && !seen.has(d.handedness)) {
        let filter = this.filters.get(d.handedness);
        if (!filter) {
          filter = new OneEuroFilter(this.smoothing);
          this.filters.set(d.handedness, filter);
        }
        filter.filter(joints, timestamp);
      }
      seen.add(d.handedness);
      hands.push({
        handedness: d.handedness,
        joints,
        confidence: d.confidence,
        timestamp,
        debug: {
          landmarks2d: d.image,
          worldLandmarks: d.world,
          center: Float32Array.from(center),
          reprojectionError,
        },
      });
    }
    for (const [side, filter] of this.filters) if (!seen.has(side)) filter.reset();
    return hands;
  }

  reset(): void {
    this.filters.clear();
  }
}
