import { OneEuroFilter, type OneEuroOptions } from '../filter/oneEuro';
import { NUM_JOINTS, type Hand3D, type HandFrameListener, type HandTrackerBackend, type Handedness } from '../types';

/**
 * WebXR's joints for each of our 21 (MediaPipe order). WebXR has 25: it adds
 * a metacarpal joint (near the wrist) for each finger, which MediaPipe lacks.
 * MediaPipe's MCP is the base of the proximal phalanx, i.e. WebXR's
 * "*-phalanx-proximal"; the thumb's CMC is WebXR's "thumb-metacarpal".
 */
export const WEBXR_JOINTS: XRHandJoint[] = [
  'wrist',
  'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip',
  'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip',
  'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip',
  'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip',
  'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip',
];

export interface WebXROptions {
  /**
   * Use an existing session (e.g. three.js's `renderer.xr.getSession()`), which
   * must have been requested with the 'hand-tracking' feature. Otherwise
   * `start()` requests one (call it from a user gesture, e.g. a button click).
   */
  session?: XRSession;
  /** Session mode when the tracker creates the session. Default: AR (passthrough) if supported, else VR. */
  mode?: 'immersive-ar' | 'immersive-vr';
  /** Reference space for the joints. Default 'local' (origin where the headset was at the start). */
  referenceSpaceType?: XRReferenceSpaceType;
  /** One Euro filter, or false (default: off — the headset's tracking is already filtered). */
  smoothing?: OneEuroOptions | false;
}

/**
 * Hands from a WebXR device with hand tracking (e.g. Meta Quest's browser).
 * Output uses the library's conventions: 21 joints in MediaPipe order, metres,
 * axes like a camera's (+x right, +y down, +z forward), relative to the
 * reference space — by default where the headset was when the session
 * started, looking forward. (WebXR's own axes are y up, −z forward; this is
 * (x, −y, −z) of those.) `handedness` is the user's actual hand.
 *
 * If the tracker creates the session itself, it shows passthrough (AR) or
 * black (VR) and nothing else; to draw your own content, create the session
 * with your renderer and pass it in `options.session`.
 */
export class WebXRHandTracker implements HandTrackerBackend {
  session: XRSession | null;
  private readonly options: WebXROptions;
  private readonly listeners = new Set<HandFrameListener>();
  private readonly filters = new Map<Handedness, OneEuroFilter>();
  private space: XRReferenceSpace | null = null;
  private ownsSession = false;
  private gl: WebGL2RenderingContext | null = null;
  private frameHandle = 0;

  constructor(options: WebXROptions = {}) {
    this.options = options;
    this.session = options.session ?? null;
  }

  /** Whether this browser can run an immersive session (hand tracking itself is only known once a session starts). */
  static async isSupported(): Promise<boolean> {
    const xr = typeof navigator === 'undefined' ? undefined : navigator.xr;
    if (!xr) return false;
    for (const mode of ['immersive-ar', 'immersive-vr'] as const) {
      if (await xr.isSessionSupported(mode).catch(() => false)) return true;
    }
    return false;
  }

  onFrame(listener: HandFrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.frameHandle) return;
    if (!this.session) {
      const xr = navigator.xr;
      if (!xr) throw new Error('WebXR is not available in this browser (try the Meta Quest Browser)');
      const mode =
        this.options.mode ?? ((await xr.isSessionSupported('immersive-ar').catch(() => false)) ? 'immersive-ar' : 'immersive-vr');
      this.session = await xr.requestSession(mode, { requiredFeatures: ['hand-tracking'] });
      this.ownsSession = true;
      // A session only produces frames once it has a layer to draw into; clear it to transparent.
      const canvas = document.createElement('canvas');
      this.gl = canvas.getContext('webgl2', { xrCompatible: true, alpha: true }) as WebGL2RenderingContext;
      await this.session.updateRenderState({ baseLayer: new XRWebGLLayer(this.session, this.gl) });
    }
    this.space = await this.session.requestReferenceSpace(this.options.referenceSpaceType ?? 'local');
    this.session.addEventListener('end', () => {
      this.frameHandle = 0;
      this.session = this.options.session ?? null;
    });
    const loop = (time: number, frame: XRFrame) => {
      this.frameHandle = frame.session.requestAnimationFrame(loop);
      this.process(time, frame);
    };
    this.frameHandle = this.session.requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.session && this.frameHandle) this.session.cancelAnimationFrame(this.frameHandle);
    this.frameHandle = 0;
    this.filters.clear();
    if (this.ownsSession) this.session?.end().catch(() => {});
    if (this.ownsSession) this.session = null;
    this.ownsSession = false;
  }

  private process(time: number, frame: XRFrame) {
    if (this.gl && this.ownsSession) {
      const layer = frame.session.renderState.baseLayer!;
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, layer.framebuffer);
      this.gl.clearColor(0, 0, 0, 0);
      this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    }
    const hands = handsFromFrame(frame, this.space!, time);
    if (this.options.smoothing) {
      for (const hand of hands) {
        let filter = this.filters.get(hand.handedness);
        if (!filter) this.filters.set(hand.handedness, (filter = new OneEuroFilter(this.options.smoothing)));
        filter.filter(hand.joints, time);
      }
    }
    for (const listener of this.listeners) listener(hands, time);
  }
}

/**
 * Hands in one XR frame (the hand-reading part of WebXRHandTracker, separate
 * for apps with their own frame loop and for testing).
 */
export function handsFromFrame(frame: XRFrame, space: XRReferenceSpace, time: number): Hand3D[] {
  const hands: Hand3D[] = [];
  for (const source of frame.session.inputSources) {
    const hand = source.hand;
    if (!hand || (source.handedness !== 'left' && source.handedness !== 'right')) continue;
    const joints = new Float32Array(NUM_JOINTS * 3);
    let tracked = true;
    for (let j = 0; j < NUM_JOINTS && tracked; j++) {
      const space_ = hand.get(WEBXR_JOINTS[j]);
      const pose = space_ && frame.getJointPose?.(space_, space);
      if (!pose) {
        tracked = false;
        break;
      }
      const p = pose.transform.position;
      // WebXR (y up, −z forward) → camera-style axes (y down, +z forward).
      joints[j * 3] = p.x;
      joints[j * 3 + 1] = -p.y;
      joints[j * 3 + 2] = -p.z;
    }
    if (!tracked) continue;
    hands.push({
      handedness: source.handedness === 'left' ? 'Left' : 'Right',
      joints,
      confidence: 1,
      timestamp: time,
      debug: { source: 'webxr' },
    });
  }
  return hands;
}
