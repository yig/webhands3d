import { dataChannelLink, type Link } from './link';
import type { Signaling } from './signaling';

export interface WebRtcOptions {
  /**
   * STUN/TURN servers. Default: none, which works when both devices are on the
   * same local network (host candidates). Add a STUN server for other networks.
   */
  iceServers?: RTCIceServer[];
  /** Give up connecting after this long, ms. */
  timeoutMs?: number;
}

/**
 * Remote side: connect to the host page through `signaling`. Resolves with a
 * Link once the data channel is open.
 */
export async function connectToHost(signaling: Signaling, options: WebRtcOptions = {}): Promise<Link> {
  const peerId = randomId();
  const pc = new RTCPeerConnection({ iceServers: options.iceServers ?? [] });
  const channel = pc.createDataChannel('webhands', { ordered: true });
  await pc.setLocalDescription(await pc.createOffer());
  await iceGathered(pc);

  const answered = new Promise<RTCSessionDescriptionInit>((resolve) => {
    const stop = signaling.receive(peerId, (m) => {
      if (m.type === 'answer') {
        stop();
        resolve(m.sdp);
      }
    });
  });
  await signaling.send('host', { type: 'offer', from: peerId, sdp: pc.localDescription!.toJSON() });
  await withTimeout(
    (async () => {
      await pc.setRemoteDescription(await answered);
      if (channel.readyState !== 'open') {
        await new Promise((resolve) => channel.addEventListener('open', resolve, { once: true }));
      }
    })(),
    options.timeoutMs ?? 20000,
    'Could not reach the host page (same network? host page open?)',
  );
  const link = dataChannelLink(channel);
  link.onClose(() => pc.close());
  watchConnection(pc, link);
  return link;
}

/**
 * Host side: accept remote cameras arriving through `signaling`; `onRemote` is
 * called with each one's Link once its data channel opens. Returns a function
 * that stops accepting (existing links stay open).
 */
export function acceptRemotes(
  signaling: Signaling,
  onRemote: (link: Link, peerId: string) => void,
  options: WebRtcOptions = {},
): () => void {
  return signaling.receive('host', async (m) => {
    if (m.type !== 'offer') return;
    const pc = new RTCPeerConnection({ iceServers: options.iceServers ?? [] });
    pc.addEventListener('datachannel', (e) => {
      const channel = e.channel;
      const ready = () => {
        const link = dataChannelLink(channel);
        link.onClose(() => pc.close());
        watchConnection(pc, link);
        onRemote(link, m.from);
      };
      if (channel.readyState === 'open') ready();
      else channel.addEventListener('open', ready, { once: true });
    });
    await pc.setRemoteDescription(m.sdp);
    await pc.setLocalDescription(await pc.createAnswer());
    await iceGathered(pc);
    await signaling.send(m.from, { type: 'answer', from: 'host', sdp: pc.localDescription!.toJSON() });
  }, { fromNow: true });
}

/** Wait for ICE gathering to finish (non-trickle ICE keeps signaling to one message each way). */
function iceGathered(pc: RTCPeerConnection, maxMs = 3000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (pc.iceGatheringState !== 'complete') return;
      pc.removeEventListener('icegatheringstatechange', done);
      resolve();
    };
    pc.addEventListener('icegatheringstatechange', done);
    setTimeout(resolve, maxMs);
  });
}

/** Close the link if the peer connection fails (e.g. the phone locks its screen). */
function watchConnection(pc: RTCPeerConnection, link: Link) {
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') link.close();
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
}

export function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
}
