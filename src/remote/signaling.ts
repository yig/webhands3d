/**
 * Exchanges WebRTC setup messages between the host page and remote cameras.
 * Mailboxes: 'host' for the host, a peer id for each remote.
 */
export interface Signaling {
  send(to: string, message: SignalMessage): Promise<void>;
  /**
   * Receive messages addressed to `me` until unsubscribed. With `fromNow`,
   * skip messages already waiting (e.g. offers from before a page reload).
   */
  receive(me: string, handler: (message: SignalMessage) => void, options?: { fromNow?: boolean }): () => void;
}

export type SignalMessage =
  | { type: 'offer'; from: string; sdp: RTCSessionDescriptionInit }
  | { type: 'answer'; from: string; sdp: RTCSessionDescriptionInit };

/**
 * Signaling through the HTTP mailbox protocol served by the demo's Vite plugin
 * (tools/signaling.ts): POST to send, long-poll GET to receive.
 * @param baseUrl  e.g. location.origin
 */
export function httpSignaling(baseUrl: string, room: string): Signaling {
  const url = (mailbox: string) =>
    `${baseUrl.replace(/\/$/, '')}/webhands-signal/${encodeURIComponent(room)}/${encodeURIComponent(mailbox)}`;
  return {
    async send(to, message) {
      const res = await fetch(url(to), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      });
      if (!res.ok) throw new Error(`Signaling failed: ${res.status}`);
    },
    receive(me, handler, options = {}) {
      let stopped = false;
      const controller = new AbortController();
      (async () => {
        let after: number | 'latest' = options.fromNow ? 'latest' : 0;
        while (!stopped) {
          try {
            const res = await fetch(`${url(me)}?after=${after}`, { signal: controller.signal, cache: 'no-store' });
            const body = (await res.json()) as { messages: SignalMessage[]; next: number };
            after = body.next;
            body.messages.forEach((m) => !stopped && handler(m));
          } catch {
            if (stopped) return;
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      })();
      return () => {
        stopped = true;
        controller.abort();
      };
    },
  };
}
