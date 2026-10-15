/** A bidirectional message pipe between a remote camera and the host page. */
export interface Link {
  send(message: string): void;
  /** Subscribe to incoming messages. Returns an unsubscribe function. */
  onMessage(listener: (message: string) => void): () => void;
  /** Called once when the link closes (either side). */
  onClose(listener: () => void): () => void;
  close(): void;
  readonly open: boolean;
}

/** A Link over a WebRTC data channel. */
export function dataChannelLink(channel: RTCDataChannel): Link {
  const closeListeners = new Set<() => void>();
  channel.addEventListener('close', () => closeListeners.forEach((l) => l()));
  return {
    send: (m) => {
      if (channel.readyState === 'open') channel.send(m);
    },
    onMessage(listener) {
      const handler = (e: MessageEvent) => listener(String(e.data));
      channel.addEventListener('message', handler);
      return () => channel.removeEventListener('message', handler);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    close: () => channel.close(),
    get open() {
      return channel.readyState === 'open';
    },
  };
}

/** Two connected in-memory Links (asynchronous delivery), for tests and same-page use. */
export function memoryLinkPair(): [Link, Link] {
  const make = () => ({
    listeners: new Set<(m: string) => void>(),
    closeListeners: new Set<() => void>(),
    open: true,
  });
  const a = make(), b = make();
  const link = (self: ReturnType<typeof make>, peer: ReturnType<typeof make>): Link => ({
    send(m) {
      if (!self.open) return;
      queueMicrotask(() => peer.listeners.forEach((l) => l(m)));
    },
    onMessage(listener) {
      self.listeners.add(listener);
      return () => self.listeners.delete(listener);
    },
    onClose(listener) {
      self.closeListeners.add(listener);
      return () => self.closeListeners.delete(listener);
    },
    close() {
      for (const side of [self, peer]) {
        if (!side.open) continue;
        side.open = false;
        side.closeListeners.forEach((l) => l());
      }
    },
    get open() {
      return self.open;
    },
  });
  return [link(a, b), link(b, a)];
}
