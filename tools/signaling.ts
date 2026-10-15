import type { IncomingMessage, ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import type { Plugin } from 'vite';

/*
 * Minimal signaling mailbox for setting up WebRTC between the host page and
 * remote cameras, served by the Vite dev server. Protocol (all JSON):
 *
 *   POST /webhands-signal/<room>/<mailbox>         body: message  → 204
 *   GET  /webhands-signal/<room>/<mailbox>?after=n → { messages, next }
 *        (long-polls up to 20 s while there is nothing after n;
 *        after=latest returns no messages and the current `next` at once)
 *   GET  /webhands-signal/_info                    → { urls: [this server on each LAN address] }
 *
 * Mailboxes: 'host' for the host page, a random peer id for each remote.
 * Rooms are in memory and forgotten after an hour of inactivity. Any server
 * implementing this protocol works with `httpSignaling`.
 */

const PREFIX = '/webhands-signal/';
const LONG_POLL_MS = 20000;
const ROOM_TTL_MS = 60 * 60 * 1000;

interface Mailbox {
  messages: unknown[];
  waiters: Set<() => void>;
}

export function signalingPlugin(): Plugin {
  const rooms = new Map<string, { mailboxes: Map<string, Mailbox>; touched: number }>();
  const mailbox = (room: string, name: string): Mailbox => {
    let r = rooms.get(room);
    if (!r) rooms.set(room, (r = { mailboxes: new Map(), touched: Date.now() }));
    r.touched = Date.now();
    let m = r.mailboxes.get(name);
    if (!m) r.mailboxes.set(name, (m = { messages: [], waiters: new Set() }));
    return m;
  };
  const sweep = () => {
    for (const [name, r] of rooms) if (Date.now() - r.touched > ROOM_TTL_MS) rooms.delete(name);
  };

  let origin = { protocol: 'http', port: 5173 };
  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!url.pathname.startsWith(PREFIX)) return next();
    const parts = url.pathname.slice(PREFIX.length).split('/').map(decodeURIComponent);
    const json = (status: number, body?: unknown) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(body === undefined ? '' : JSON.stringify(body));
    };

    if (parts[0] === '_info') {
      const urls = Object.values(networkInterfaces())
        .flat()
        .filter((a) => a && a.family === 'IPv4' && !a.internal)
        .map((a) => `${origin.protocol}://${a!.address}:${origin.port}`);
      return json(200, { urls });
    }
    const [room, name] = parts;
    if (!room || !name || parts.length !== 2) return json(400, { error: 'expected /webhands-signal/<room>/<mailbox>' });
    sweep();
    const box = mailbox(room, name);

    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        box.messages.push(JSON.parse(body));
      } catch {
        return json(400, { error: 'invalid JSON' });
      }
      box.waiters.forEach((w) => w());
      return json(204);
    }
    if (req.method === 'GET') {
      if (url.searchParams.get('after') === 'latest') return json(200, { messages: [], next: box.messages.length });
      const after = Number(url.searchParams.get('after') ?? 0);
      if (box.messages.length <= after) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            box.waiters.delete(done);
            resolve();
          };
          const timer = setTimeout(done, LONG_POLL_MS);
          box.waiters.add(done);
          req.on('close', done);
        });
      }
      return json(200, { messages: box.messages.slice(after), next: box.messages.length });
    }
    json(405, { error: 'GET or POST' });
  };

  return {
    name: 'webhands-signaling',
    configureServer(server) {
      origin = { protocol: server.config.server.https ? 'https' : 'http', port: server.config.server.port ?? 5173 };
      server.httpServer?.once('listening', () => {
        const address = server.httpServer?.address();
        if (address && typeof address === 'object') origin.port = address.port;
      });
      server.middlewares.use(handler);
    },
  };
}
