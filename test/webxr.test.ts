import { describe, expect, it } from 'vitest';
import { WEBXR_JOINTS, handsFromFrame } from '../src/backends/webxr';

/** A fake XR frame: one input source per hand, each joint at a known position (WebXR axes). */
function fakeFrame(hands: { handedness: XRHandedness; position: (joint: string) => [number, number, number] | null }[]) {
  const inputSources = hands.map(({ handedness, position }) => {
    const map = new Map<string, { joint: string }>();
    // All 25 WebXR joints exist on a hand, including the finger metacarpals we don't use.
    for (const joint of [...WEBXR_JOINTS, 'index-finger-metacarpal', 'middle-finger-metacarpal', 'ring-finger-metacarpal', 'pinky-finger-metacarpal']) {
      map.set(joint, { joint });
    }
    return { handedness, hand: map, position };
  });
  const frame = {
    session: { inputSources: [{ handedness: 'none', hand: undefined }, ...inputSources] },
    getJointPose(space: { joint: string }) {
      for (const s of inputSources) {
        if ([...s.hand.values()].includes(space)) {
          const p = s.position(space.joint);
          return p ? { transform: { position: { x: p[0], y: p[1], z: p[2] } }, radius: 0.01 } : null;
        }
      }
      return null;
    },
  };
  return frame as unknown as XRFrame;
}

describe('WebXR hands', () => {
  it('maps the 25 WebXR joints onto the 21 used everywhere else, in camera-style axes', () => {
    // Joint k of the 21 placed at (k, k + 0.5, -1 - k) in WebXR space; metacarpals elsewhere.
    const index = (joint: string) => WEBXR_JOINTS.indexOf(joint as XRHandJoint);
    const frame = fakeFrame([
      { handedness: 'right', position: (j) => (index(j) >= 0 ? [index(j), index(j) + 0.5, -1 - index(j)] : [99, 99, 99]) },
    ]);
    const [hand] = handsFromFrame(frame, {} as XRReferenceSpace, 1234);
    expect(hand.handedness).toBe('Right');
    expect(hand.timestamp).toBe(1234);
    for (let k = 0; k < 21; k++) {
      // y and z flipped: WebXR is y up / −z forward, ours y down / +z forward.
      expect([hand.joints[k * 3], hand.joints[k * 3 + 1], hand.joints[k * 3 + 2]]).toEqual([k, -(k + 0.5), 1 + k]);
    }
  });

  it('reports both hands with the right handedness and skips one that lost tracking', () => {
    const frame = fakeFrame([
      { handedness: 'left', position: () => [0, 1, -0.5] },
      { handedness: 'right', position: (j) => (j === 'thumb-tip' ? null : [0, 1, -0.5]) },
    ]);
    const hands = handsFromFrame(frame, {} as XRReferenceSpace, 0);
    expect(hands.map((h) => h.handedness)).toEqual(['Left']);
  });

  it('uses each finger’s proximal phalanx as its knuckle (MediaPipe MCP)', () => {
    expect(WEBXR_JOINTS[5]).toBe('index-finger-phalanx-proximal');
    expect(WEBXR_JOINTS[1]).toBe('thumb-metacarpal');
    expect(new Set(WEBXR_JOINTS).size).toBe(21);
  });
});
