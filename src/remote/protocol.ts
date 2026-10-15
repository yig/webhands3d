import type { Intrinsics } from '../intrinsics';
import type { Handedness } from '../types';

/*
 * Messages between a remote camera (sender, e.g. a phone) and the host page,
 * JSON over a Link. Times are each side's performance.now(), ms.
 */

export const PROTOCOL_VERSION = 1;

/** One hand in a frame: handedness, confidence, 21 × 2 pixels, 21 × 3 MediaPipe world metres. */
export interface WireHand {
  h: 'L' | 'R';
  c: number;
  uv: number[];
  w: number[];
}

export type RemoteToHost =
  | { type: 'hello'; version: number; cameraId: string; label: string }
  /** `calibrated`: whether the remote calibrated its focal length (vs. a default). */
  | { type: 'intrinsics'; k: Intrinsics; calibrated?: boolean }
  /** `t` is the frame's capture time on the remote clock. */
  | { type: 'frame'; t: number; hands: WireHand[] }
  | { type: 'pong'; t0: number; t1: number };

export type HostToRemote =
  | { type: 'ping'; t0: number }
  /** Measured calibration for the remote's own preview / fallback. */
  | {
      type: 'calibration';
      handScale?: number;
      skeletons?: Partial<Record<Handedness, { lengths: number[]; palm: number[] }>>;
    };

export function encodeHand(handedness: Handedness, confidence: number, uv: ArrayLike<number>, world: ArrayLike<number>): WireHand {
  return {
    h: handedness === 'Left' ? 'L' : 'R',
    c: round(confidence, 1000),
    uv: Array.from(uv, (v) => round(v, 10)), // 0.1 px
    w: Array.from(world, (v) => round(v, 1e5)), // 0.01 mm
  };
}

export function decodeHandedness(h: WireHand['h']): Handedness {
  return h === 'L' ? 'Left' : 'Right';
}

const round = (v: number, k: number) => Math.round(v * k) / k;
