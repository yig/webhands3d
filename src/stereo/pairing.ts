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
