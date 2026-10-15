import type { Hand3D, Handedness } from '../types';

/** All hands one view reported for one video frame. */
export interface TimedHands {
  timestamp: number;
  hands: Hand3D[];
}

/** Group per-hand samples (as collected from onFrame) back into frames, in time order. */
export function groupByFrame(samples: Hand3D[]): TimedHands[] {
  const frames = new Map<number, Hand3D[]>();
  for (const h of samples) {
    const list = frames.get(h.timestamp);
    if (list) list.push(h);
    else frames.set(h.timestamp, [h]);
  }
  return [...frames.entries()].sort((a, b) => a[0] - b[0]).map(([timestamp, hands]) => ({ timestamp, hands }));
}

/** Median time between a camera's recent frames, ms (33 if unknown). */
export function frameInterval(frames: TimedHands[], recent = 30): number {
  const n = frames.length;
  if (n < 2) return 1000 / 30;
  const diffs: number[] = [];
  for (let i = Math.max(1, n - recent); i < n; i++) diffs.push(frames[i].timestamp - frames[i - 1].timestamp);
  diffs.sort((a, b) => a - b);
  return diffs[diffs.length >> 1] || 1000 / 30;
}

/**
 * Interpolation limits for a camera with this frame interval: bracketing frames
 * may be up to ~2.5 intervals apart (a dropped frame), and without a bracket the
 * nearest frame within ~0.6 interval is used. Slow cameras (a phone running
 * MediaPipe at 10 fps) need wider limits than the 30 fps defaults.
 */
export function pairingLimits(intervalMs: number): { maxGapMs: number; nearestMs: number } {
  return {
    maxGapMs: Math.min(400, Math.max(80, 2.5 * intervalMs)),
    nearestMs: Math.min(150, Math.max(20, 0.6 * intervalMs)),
  };
}

/**
 * The 2D landmarks (pixels) of the hand with this handedness at `time`,
 * linearly interpolated between the frames around it. Falls back to the
 * nearest frame within `nearestMs` if the hand isn't in both neighbours.
 * `frames` must be sorted by timestamp.
 */
export function interpolateLandmarks(
  frames: TimedHands[],
  handedness: Handedness,
  time: number,
  maxGapMs = 80,
  nearestMs = 20,
): { landmarks: Float32Array; hand: Hand3D } | null {
  // Binary search for the last frame at or before `time`.
  let lo = 0, hi = frames.length - 1, before = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].timestamp <= time) {
      before = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const find = (i: number) => (i >= 0 && i < frames.length ? frames[i].hands.find((h) => h.handedness === handedness) : undefined);
  const a = find(before), b = find(before + 1);
  const ta = before >= 0 ? frames[before].timestamp : -Infinity;
  const tb = before + 1 < frames.length ? frames[before + 1].timestamp : Infinity;
  const la = a?.debug?.landmarks2d, lb = b?.debug?.landmarks2d;
  if (a && b && la && lb && tb - ta <= maxGapMs) {
    const w = tb > ta ? (time - ta) / (tb - ta) : 0;
    return { landmarks: la.map((v, i) => v + (lb[i] - v) * w), hand: w < 0.5 ? a : b };
  }
  const candidates: [Hand3D | undefined, number][] = [[a, time - ta], [b, tb - time]];
  for (const [h, dt] of candidates.sort((x, y) => x[1] - y[1])) {
    if (h?.debug?.landmarks2d && dt <= nearestMs) return { landmarks: h.debug.landmarks2d, hand: h };
  }
  return null;
}
