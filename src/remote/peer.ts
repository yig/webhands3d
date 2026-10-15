import { Peer, type DataConnection, type PeerOptions } from 'peerjs';
import type { Link } from './link';

/*
 * Connecting remote cameras with PeerJS. Before two browsers can talk over
 * WebRTC they must exchange a short setup message each way ("signaling");
 * PeerJS does that through its PeerServer — by default the free public cloud
 * server run by the PeerJS project, so no server of your own is needed. The
 * host page registers under an id; the QR code carries it; each phone connects
 * to it. After setup, hand data flows directly between the devices (or through
 * a TURN relay when no direct path exists). The PeerServer sees the peer ids
 * and the setup messages (which include the devices' network addresses), not
 * the hand data. For your own PeerServer, pass `peerOptions` (host, port,
 * path, key, and `config.iceServers` for STUN/TURN).
 */

export interface PeerConnectOptions {
  /** PeerJS options (PeerServer host/port/path/key, ICE servers, debug level). Default: PeerJS cloud. */
  peerOptions?: PeerOptions;
  /** Give up connecting after this long, ms. Default 20 s. */
  timeoutMs?: number;
}

export interface RemoteCameraHost {
  /** The id phones connect to (put it in the QR code). */
  readonly id: string;
  readonly peer: Peer;
  /** Stop accepting phones (open links stay open until closed). */
  close(): void;
}

/** A Link over a PeerJS data connection (raw serialization: our messages are JSON strings). */
export function peerLink(connection: DataConnection): Link {
  const closeListeners = new Set<() => void>();
  let closed = false;
  const markClosed = () => {
    if (closed) return;
    closed = true;
    closeListeners.forEach((l) => l());
  };
  connection.on('close', markClosed);
  connection.on('error', markClosed);
  return {
    send: (m) => {
      if (!closed && connection.open) void connection.send(m);
    },
    onMessage(listener) {
      const handler = (data: unknown) => listener(String(data));
      connection.on('data', handler);
      return () => connection.off('data', handler);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    close: () => {
      connection.close();
      markClosed();
    },
    get open() {
      return !closed && connection.open;
    },
  };
}

/**
 * Host side: register under `id` (reused across reloads so a printed or
 * remembered QR code keeps working; a random id if it's taken, e.g. by another
 * tab) and call `onRemote` with each phone's Link once its connection opens.
 */
export function hostRemoteCameras(
  onRemote: (link: Link, peerId: string) => void,
  options: PeerConnectOptions & { id?: string } = {},
): Promise<RemoteCameraHost> {
  const open = (id: string | undefined): Promise<RemoteCameraHost> =>
    new Promise((resolve, reject) => {
      const peer = id ? new Peer(id, options.peerOptions ?? {}) : new Peer(options.peerOptions ?? {});
      const timer = setTimeout(() => {
        peer.destroy();
        reject(new Error("Couldn't reach the PeerJS server (no internet?)"));
      }, options.timeoutMs ?? 20000);
      peer.on('open', (assigned) => {
        clearTimeout(timer);
        resolve({ id: assigned, peer, close: () => peer.destroy() });
      });
      peer.on('error', (e) => {
        clearTimeout(timer);
        if (!peer.open) {
          peer.destroy();
          reject(e);
        }
      });
      // Keep accepting phones if the connection to the PeerServer drops (open links are unaffected).
      peer.on('disconnected', () => {
        if (!peer.destroyed) setTimeout(() => !peer.destroyed && peer.disconnected && peer.reconnect(), 1000);
      });
      peer.on('connection', (connection) => {
        const ready = () => onRemote(peerLink(connection), connection.peer);
        if (connection.open) ready();
        else connection.on('open', ready);
      });
    });
  return open(options.id).catch((e: { type?: string }) => {
    if (options.id && e?.type === 'unavailable-id') return open(undefined);
    throw e;
  });
}

/**
 * Remote side: connect to the host page with this id. Resolves with a Link
 * once the connection is open. The Link's close also releases the PeerJS peer.
 */
export function connectToHost(hostId: string, options: PeerConnectOptions = {}): Promise<Link> {
  return new Promise((resolve, reject) => {
    const peer = new Peer(options.peerOptions ?? {});
    const fail = (message: string) => {
      clearTimeout(timer);
      peer.destroy();
      reject(new Error(message));
    };
    const timer = setTimeout(
      () => fail('Could not reach the computer: is its page open, and are both devices online?'),
      options.timeoutMs ?? 20000,
    );
    peer.on('error', (e) => {
      if (e.type === 'peer-unavailable') fail("No computer with that code: check the code, and that the computer's page is open");
      else if (!peer.open) fail(`Couldn't reach the PeerJS server: ${e.message}`);
    });
    peer.on('open', () => {
      const connection = peer.connect(hostId, { serialization: 'raw', reliable: true });
      connection.on('open', () => {
        clearTimeout(timer);
        const link = peerLink(connection);
        link.onClose(() => peer.destroy());
        resolve(link);
      });
    });
  });
}

/** A short random id (hex). */
export function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
}
