import type { Intrinsics } from '../intrinsics';
import { NUM_JOINTS } from '../types';
import { JOINT_PARENTS } from './bones';
import { centroid, kabsch } from './rigid';
import { reprojectionError, solvePose, transformPoints } from './solvePose';

/** Wrist and the four finger MCPs: the (nearly) rigid part of the hand. */
export const PALM_JOINTS = [0, 5, 9, 13, 17];

export interface SkeletonPlacement {
  /** 21 × 3 joints, camera frame, metres. */
  joints: Float32Array;
  /** Palm centroid, camera frame. */
  center: Float64Array;
  reprojectionError: number;
}

/**
 * Place a hand from its image landmarks, calibrated bone lengths and palm shape,
 * using MediaPipe's 3D only to choose between mirror-image solutions.
 *
 * 1. Palm: rigid 6-DoF fit of the calibrated palm template to the 5 palm image
 *    points, starting from MediaPipe's palm orientation. Tilting a flat shape
 *    only shortens it across the tilt axis, so the fit's scale (depth) is
 *    right at any tilt — unlike fitting MediaPipe's per-frame 3D, which
 *    under-reports tilt and so pushes tilted hands back.
 * 2. Every other joint, parents first: it lies on its camera ray at exactly the
 *    bone length from its parent (ray–sphere intersection). Of the two
 *    intersections (bone tilted toward or away from the camera), take the one
 *    whose direction agrees best with MediaPipe's bone. If the ray misses the
 *    sphere (bone looks longer than its length — noise), take the ray's
 *    closest point.
 *
 * @param world  21 × 3 MediaPipe world landmarks (any scale; only directions used).
 * @param image  21 × 2 image landmarks, pixels.
 * @param lengths  20 calibrated bone lengths, metres.
 * @param palm  5 × 3 calibrated palm template (PALM_JOINTS order), metres.
 */
export function placeSkeleton(
  world: ArrayLike<number>,
  image: ArrayLike<number>,
  k: Intrinsics,
  lengths: ArrayLike<number>,
  palm: ArrayLike<number>,
): SkeletonPlacement {
  // Template rotated to MediaPipe's palm orientation, centred at its centroid.
  const mpPalm = gather(world, PALM_JOINTS, 3);
  const R0 = kabsch(palm, mpPalm);
  const c0 = centroid(palm, PALM_JOINTS.length);
  const model = new Float64Array(PALM_JOINTS.length * 3);
  for (let i = 0; i < PALM_JOINTS.length; i++) {
    const x = palm[i * 3] - c0[0], y = palm[i * 3 + 1] - c0[1], z = palm[i * 3 + 2] - c0[2];
    for (let r = 0; r < 3; r++) model[i * 3 + r] = R0[r * 3] * x + R0[r * 3 + 1] * y + R0[r * 3 + 2] * z;
  }
  const pose = solvePose(model, gather(image, PALM_JOINTS, 2), k, { refineRotation: true, iterations: 20 });
  const palm3d = transformPoints(model, pose);

  const joints = new Float32Array(NUM_JOINTS * 3);
  const placed = new Uint8Array(NUM_JOINTS);
  PALM_JOINTS.forEach((j, i) => {
    joints.set(palm3d.subarray(i * 3, i * 3 + 3), j * 3);
    placed[j] = 1;
  });

  for (let j = 1; j < NUM_JOINTS; j++) {
    if (placed[j]) continue;
    const p = JOINT_PARENTS[j];
    const Px = joints[p * 3], Py = joints[p * 3 + 1], Pz = joints[p * 3 + 2];
    // Unit ray through the child's image point.
    let rx = (image[j * 2] - k.cx) / k.fx, ry = (image[j * 2 + 1] - k.cy) / k.fy, rz = 1;
    const rn = Math.hypot(rx, ry, rz);
    rx /= rn; ry /= rn; rz /= rn;
    const L = lengths[j - 1];
    const b = rx * Px + ry * Py + rz * Pz;
    const disc = b * b - (Px * Px + Py * Py + Pz * Pz) + L * L;
    let lambda = b;
    if (disc > 0) {
      const s = Math.sqrt(disc);
      // MediaPipe's bone direction picks the branch.
      const dx = world[j * 3] - world[p * 3], dy = world[j * 3 + 1] - world[p * 3 + 1], dz = world[j * 3 + 2] - world[p * 3 + 2];
      const agree = (l: number) => (l * rx - Px) * dx + (l * ry - Py) * dy + (l * rz - Pz) * dz;
      lambda = agree(b + s) >= agree(b - s) ? b + s : b - s;
      if (lambda <= 0) lambda = b + s;
    }
    joints[j * 3] = lambda * rx;
    joints[j * 3 + 1] = lambda * ry;
    joints[j * 3 + 2] = lambda * rz;
  }

  const identity = { rotation: Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1), translation: new Float64Array(3) };
  return {
    joints,
    center: Float64Array.from(pose.translation),
    reprojectionError: reprojectionError(joints, image, k, identity),
  };
}

function gather(src: ArrayLike<number>, idx: number[], dim: number): Float64Array {
  const out = new Float64Array(idx.length * dim);
  idx.forEach((j, i) => {
    for (let d = 0; d < dim; d++) out[i * dim + d] = src[j * dim + d];
  });
  return out;
}
