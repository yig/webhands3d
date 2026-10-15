import { HandAssembler, type DepthMethod, type SkeletonsByHand } from '../backends/assemble';
import type { ViewSource } from '../backends/multiview';
import { Calibrator } from '../calibration/calibrator';
import type { OneEuroOptions } from '../filter/oneEuro';
import { loadCalibration, type Intrinsics } from '../intrinsics';
import type { Hand3D, HandFrameListener } from '../types';
import { ClockSync } from './clock';
import type { Link } from './link';
import {
  PROTOCOL_VERSION,
  decodeHandedness,
  encodeHand,
  type HostToRemote,
  type RemoteToHost,
} from './protocol';

export interface RemoteCameraOptions {
  smoothing?: OneEuroOptions | false;
  /** Close the link if nothing arrives for this long, ms (a vanished peer can take ~30 s to be noticed otherwise). Default 5000. */
  silenceTimeoutMs?: number;
  /** Clock, for tests. */
  now?: () => number;
}

/**
 * Host side of a remote camera (e.g. a phone running MediaPipe and sending its
 * landmarks over WebRTC). Behaves like a local single-camera tracker: a
 * ViewSource for MultiViewHandTracker, with the remote's capture times
 * converted to this page's clock (ping/pong clock sync) and hands placed in 3D
 * here with the same code as a local camera. Its hand size and skeleton are
 * stored on this page under the remote's camera id, and sent to the remote.
 */
export class RemoteCamera implements ViewSource {
  intrinsics: Intrinsics | null = null;
  handScale = 1;
  skeletons: SkeletonsByHand = {};
  depthMethod: DepthMethod = 'skeleton';
  refineRotation = false;
  /** 'remote:' + the remote's own camera id, once it has said hello. */
  cameraId = '';
  label = '';
  readonly clock = new ClockSync();
  /** Whether the remote calibrated its own focal length (it does that on its own page). */
  focalCalibrated = false;
  /** Frames received / emitted, for diagnostics. */
  framesReceived = 0;

  private readonly listeners = new Set<HandFrameListener>();
  private readonly closeListeners = new Set<() => void>();
  private readonly assembler: HandAssembler;
  private readonly now: () => number;
  private emitting = false;
  private ready: Promise<void>;
  private resolveReady!: () => void;
  private pingTimer: ReturnType<typeof setTimeout> | undefined;
  private pings = 0;
  private calibratorInstance: Calibrator | null = null;
  private lastHeard: number;
  private readonly silenceTimeoutMs: number;

  constructor(
    readonly link: Link,
    options: RemoteCameraOptions = {},
  ) {
    this.assembler = new HandAssembler(options.smoothing);
    this.now = options.now ?? (() => performance.now());
    this.silenceTimeoutMs = options.silenceTimeoutMs ?? 5000;
    this.lastHeard = this.now();
    this.ready = new Promise((resolve) => (this.resolveReady = resolve));
    link.onMessage((m) => {
      this.lastHeard = this.now();
      this.handle(JSON.parse(m) as RemoteToHost);
    });
    link.onClose(() => {
      clearTimeout(this.pingTimer);
      this.closeListeners.forEach((l) => l());
    });
    this.ping();
  }

  get calibrator(): Calibrator {
    if (!this.calibratorInstance) {
      this.calibratorInstance = new Calibrator(this);
      // Share measured calibration with the remote, for its own preview and fallback.
      this.calibratorInstance.onChange(() => this.sendCalibration());
    }
    return this.calibratorInstance;
  }

  get connected(): boolean {
    return this.link.open;
  }

  /** Resolves once the remote has identified itself and sent its intrinsics; then frames are emitted. */
  async start(): Promise<void> {
    await this.ready;
    this.emitting = true;
  }

  /** Stop emitting frames (the connection stays open). */
  stop(): void {
    this.emitting = false;
    this.assembler.reset();
  }

  close(): void {
    this.stop();
    this.link.close();
  }

  onFrame(listener: HandFrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  private send(message: HostToRemote) {
    this.link.send(JSON.stringify(message));
  }

  /** Pings quickly at first for a good clock estimate, then every second (follows drift, detects silence). */
  private ping() {
    if (!this.link.open) return;
    if (this.now() - this.lastHeard > this.silenceTimeoutMs) {
      this.link.close();
      return;
    }
    this.send({ type: 'ping', t0: this.now() });
    this.pings++;
    this.pingTimer = setTimeout(() => this.ping(), this.pings < 10 ? 300 : 1000);
  }

  private sendCalibration() {
    this.send({
      type: 'calibration',
      handScale: this.handScale,
      skeletons: Object.fromEntries(
        Object.entries(this.skeletons).map(([side, s]) => [side, { lengths: Array.from(s!.lengths), palm: Array.from(s!.palm) }]),
      ),
    });
  }

  private handle(message: RemoteToHost) {
    switch (message.type) {
      case 'hello': {
        if (message.version !== PROTOCOL_VERSION) {
          console.warn(`webhands: remote protocol ${message.version}, expected ${PROTOCOL_VERSION}`);
        }
        this.cameraId = `remote:${message.cameraId}`;
        this.label = message.label;
        const stored = loadCalibration(this.cameraId);
        this.handScale = stored.handScale ?? 1;
        this.skeletons = stored.skeletons ?? {};
        if (stored.handScale !== undefined || stored.skeletons) this.sendCalibration();
        break;
      }
      case 'intrinsics':
        this.intrinsics = message.k;
        this.focalCalibrated = !!message.calibrated;
        if (this.cameraId) this.resolveReady();
        break;
      case 'pong':
        this.clock.add(message.t0, message.t1, this.now());
        break;
      case 'frame': {
        this.framesReceived++;
        if (!this.emitting || !this.intrinsics || !this.clock.ready) return;
        const timestamp = this.clock.toLocal(message.t);
        const hands: Hand3D[] = this.assembler.assemble(
          message.hands.map((h) => ({
            handedness: decodeHandedness(h.h),
            confidence: h.c,
            image: Float32Array.from(h.uv),
            world: Float32Array.from(h.w),
          })),
          timestamp,
          this.intrinsics,
          this,
        );
        for (const listener of this.listeners) listener(hands, timestamp);
        break;
      }
    }
  }
}

/** What a remote camera needs from its local tracker (a MonocularHandTracker fits). */
export interface SenderSource {
  intrinsics: Intrinsics | null;
  cameraId: string;
  onFrame(listener: HandFrameListener): () => void;
  readonly calibrator?: Calibrator;
}

export interface RemoteSenderOptions {
  /** Stable id for this camera on the host (default: the source's camera id). */
  cameraId?: string;
  label?: string;
  /** Clock, for tests. */
  now?: () => number;
}

/**
 * Remote side: forwards a local tracker's landmarks, intrinsics and capture
 * times to the host over a Link, answers clock pings, and applies calibration
 * the host measured (hand size, skeleton) to the local tracker.
 */
export class RemoteCameraSender {
  framesSent = 0;
  private unsubscribes: (() => void)[] = [];
  private lastIntrinsics = '';
  private readonly now: () => number;

  constructor(
    private readonly source: SenderSource,
    private readonly link: Link,
    private readonly options: RemoteSenderOptions = {},
  ) {
    this.now = options.now ?? (() => performance.now());
  }

  start(): void {
    if (this.unsubscribes.length) return;
    this.post({
      type: 'hello',
      version: PROTOCOL_VERSION,
      cameraId: this.options.cameraId ?? this.source.cameraId,
      label: this.options.label ?? '',
    });
    this.sendIntrinsicsIfChanged();
    this.unsubscribes.push(
      this.source.onFrame((hands, t) => {
        this.sendIntrinsicsIfChanged();
        this.post({
          type: 'frame',
          t,
          hands: hands.flatMap((h) =>
            h.debug?.landmarks2d && h.debug.worldLandmarks
              ? [encodeHand(h.handedness, h.confidence, h.debug.landmarks2d, h.debug.worldLandmarks)]
              : [],
          ),
        });
        this.framesSent++;
      }),
      this.link.onMessage((m) => this.handle(JSON.parse(m) as HostToRemote)),
    );
  }

  stop(): void {
    this.unsubscribes.forEach((u) => u());
    this.unsubscribes = [];
  }

  private post(message: RemoteToHost) {
    this.link.send(JSON.stringify(message));
  }

  private sendIntrinsicsIfChanged() {
    const k = this.source.intrinsics;
    if (!k) return;
    const calibrated = !!this.source.calibrator?.status.focal.calibrated;
    const key = JSON.stringify([k, calibrated]);
    if (key === this.lastIntrinsics) return;
    this.lastIntrinsics = key;
    this.post({ type: 'intrinsics', k, calibrated });
  }

  private handle(message: HostToRemote) {
    if (message.type === 'ping') {
      this.post({ type: 'pong', t0: message.t0, t1: this.now() });
    } else if (message.type === 'calibration') {
      const cal = this.source.calibrator;
      if (!cal) return;
      if (message.handScale !== undefined) cal.setHandScale(message.handScale);
      for (const side of ['Left', 'Right'] as const) {
        const s = message.skeletons?.[side];
        if (s) cal.setSkeleton(side, s);
      }
    }
  }
}
