import { describe, expect, it } from 'vitest';
import type { SkeletonsByHand } from '../src/backends/assemble';
import { Calibrator } from '../src/calibration/calibrator';
import { ClockSync } from '../src/remote/clock';
import { RemoteCamera, RemoteCameraSender, type SenderSource } from '../src/remote/camera';
import { memoryLinkPair } from '../src/remote/link';
import type { HandFrameListener, Hand3D } from '../src/types';
import { asHand, K, rng, simulate, TRUE_LENGTHS } from './sim';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A phone-side tracker whose clock runs 5 s ahead of the host's. */
class FakePhoneTracker implements SenderSource {
  intrinsics = { ...K };
  cameraId = 'phone-back';
  handScale = 1;
  skeletons: SkeletonsByHand = {};
  readonly calibrator: Calibrator;
  private listeners = new Set<HandFrameListener>();
  constructor() {
    this.calibrator = new Calibrator(this as never);
  }
  onFrame(l: HandFrameListener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(hands: Hand3D[], t: number) {
    for (const l of this.listeners) l(hands, t);
  }
}

const CLOCK_SKEW = 5000;

describe('ClockSync', () => {
  it('uses the round trip with the least delay', () => {
    const c = new ClockSync();
    c.add(0, 1000 + 50, 100); // slow, asymmetric
    c.add(200, 1000 + 205, 210); // fast
    expect(c.offset).toBeCloseTo(1000, 0);
    expect(c.toLocal(2000)).toBeCloseTo(1000, 0);
  });
});

describe('RemoteCamera ↔ RemoteCameraSender', () => {
  async function connect() {
    const [hostLink, phoneLink] = memoryLinkPair();
    const phone = new FakePhoneTracker();
    const sender = new RemoteCameraSender(phone, phoneLink, { label: 'iPhone', now: () => performance.now() + CLOCK_SKEW });
    const camera = new RemoteCamera(hostLink, { smoothing: false });
    sender.start();
    await camera.start();
    for (let i = 0; i < 5 && !camera.clock.ready; i++) await tick();
    return { phone, sender, camera, hostLink };
  }

  it('identifies the remote, syncs clocks and delivers hands on the host clock', async () => {
    const { phone, camera } = await connect();
    expect(camera.cameraId).toBe('remote:phone-back');
    expect(camera.label).toBe('iPhone');
    expect(camera.intrinsics).toEqual(K);
    expect(Math.abs(camera.clock.offset - CLOCK_SKEW)).toBeLessThan(5);

    const received: { hands: Hand3D[]; t: number }[] = [];
    camera.onFrame((hands, t) => received.push({ hands, t }));
    const r = rng(2);
    const hostCapture = performance.now();
    phone.emit([asHand(simulate(r))], hostCapture + CLOCK_SKEW);
    await tick();
    expect(received).toHaveLength(1);
    expect(Math.abs(received[0].t - hostCapture)).toBeLessThan(5);
    const hand = received[0].hands[0];
    expect(hand.handedness).toBe('Right');
    expect(hand.joints).toHaveLength(63);
    expect(hand.debug?.landmarks2d).toHaveLength(42);
  });

  it('sends calibration measured on the host to the remote tracker', async () => {
    const { phone, camera } = await connect();
    camera.calibrator.setHandScale(1.07);
    camera.calibrator.setSkeleton('Right', { lengths: TRUE_LENGTHS, palm: new Float64Array(15) });
    await tick();
    expect(phone.handScale).toBeCloseTo(1.07, 6);
    expect((phone.skeletons as Record<string, { lengths: number[] }>).Right.lengths[0]).toBeCloseTo(TRUE_LENGTHS[0], 9);
  });

  it('reports when the connection closes', async () => {
    const { camera, hostLink } = await connect();
    let closed = false;
    camera.onClose(() => (closed = true));
    hostLink.close();
    expect(closed).toBe(true);
    expect(camera.connected).toBe(false);
  });
});
