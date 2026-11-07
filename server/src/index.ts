import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { LIMITS, ROOM_ID, type ClientMessage, type Peer } from '../../shared/protocol.ts';
import { migrate } from './migrate.ts';
import { Rooms } from './rooms.ts';
import { MemoryStore, PgStore, type Store } from './store.ts';

// The collab server: rooms over WebSockets under /collab, saved to Postgres.
// It sits behind the platform's sign-in (auth: forward), which sets the
// identity headers below on every request it lets through.
//
//   POST /collab/rooms          -> { id }  new empty room
//   GET  /collab/rooms/<id>     -> 200 | 404 (why a WebSocket was refused)
//   GET  /collab/rooms/<id>/ws  -> WebSocket, messages in shared/protocol.ts
//   GET  /collab/health         -> ok
//
// Env: PORT (8080), DATABASE_URL (unset = in memory), ALLOWED_ORIGIN (the
// only Origin accepted, e.g. https://canvas.app.ekkylab.uk).

const PORT = Number(process.env.PORT ?? 8080);
const ORIGIN = process.env.ALLOWED_ORIGIN ? new URL(process.env.ALLOWED_ORIGIN).origin : null;
// Set by Traefik from the platform sign-in (oauth2-proxy). Traefik deletes
// client-sent copies of these headers before setting them, so they can be
// trusted from behind it; never expose this server another way.
const USER_HEADER = 'x-auth-request-user'; // OIDC sub: stable
const NAME_HEADERS = ['x-auth-request-preferred-username', 'x-auth-request-email'];
// Per connection: messages per second, and the burst allowed above it.
const RATE = 120;
const BURST = 600;

type User = { sub: string; name: string };

function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null;
}

function identity(req: IncomingMessage): User | null {
  const sub = header(req, USER_HEADER);
  if (!sub) return null;
  const name = NAME_HEADERS.map((h) => header(req, h)).find(Boolean) ?? 'Someone';
  return { sub, name: name.slice(0, 60) };
}

// Cookies make every request from another site look signed in, so state
// changes and WebSockets must come from the app's own pages.
function sameOrigin(req: IncomingMessage): boolean {
  return ORIGIN === null || req.headers.origin === ORIGIN;
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function roomFromPath(url: string | undefined, suffix: string): string | null {
  const match = /^\/collab\/rooms\/([^/?]+)(\/[^?]*)?(\?.*)?$/.exec(url ?? '');
  if (!match || (match[2] ?? '') !== suffix || !ROOM_ID.test(match[1])) return null;
  return match[1];
}

async function main(): Promise<void> {
  if (process.argv.includes('--migrate')) {
    // The platform's migrate Job: DATABASE_URL is the owner here.
    await migrate(requiredEnv('DATABASE_URL'), requiredEnv('DATABASE_RUNTIME_ROLE'));
    return;
  }

  let store: Store;
  if (process.env.DATABASE_URL) {
    store = new PgStore(process.env.DATABASE_URL);
  } else {
    console.warn('DATABASE_URL is unset: rooms are kept in memory and lost on restart');
    store = new MemoryStore();
  }
  if (!ORIGIN) console.warn('ALLOWED_ORIGIN is unset: requests are accepted from any origin');
  const rooms = new Rooms(store);

  const server = createServer(async (req, res) => {
    try {
      const path = (req.url ?? '').split('?')[0];
      if (req.method === 'GET' && path === '/collab/health') return reply(res, 200, 'ok');
      if (req.method === 'POST' && path === '/collab/rooms') {
        const user = identity(req);
        if (!user) return reply(res, 401, { error: 'not signed in' });
        if (!sameOrigin(req)) return reply(res, 403, { error: 'wrong origin' });
        return reply(res, 201, { id: await rooms.create(user.sub) });
      }
      const roomId = req.method === 'GET' ? roomFromPath(req.url, '') : null;
      if (roomId) {
        if (!identity(req)) return reply(res, 401, { error: 'not signed in' });
        return (await rooms.exists(roomId)) ? reply(res, 200, { id: roomId }) : reply(res, 404, { error: 'no such room' });
      }
      reply(res, 404, { error: 'not found' });
    } catch (error) {
      console.error(error);
      reply(res, 500, { error: 'internal error' });
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.frameBytes });

  server.on('upgrade', async (req, socket, head) => {
    const refuse = (status: number, text: string) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    try {
      const user = identity(req);
      if (!user) return refuse(401, 'Unauthorized');
      if (!sameOrigin(req)) return refuse(403, 'Forbidden');
      const roomId = roomFromPath(req.url, '/ws');
      if (!roomId || !(await rooms.exists(roomId))) return refuse(404, 'Not Found');
      wss.handleUpgrade(req, socket, head, (ws) => {
        void connect(ws, roomId, { id: randomBytes(8).toString('hex'), name: user.name });
      });
    } catch (error) {
      console.error(error);
      refuse(500, 'Internal Server Error');
    }
  });

  async function connect(ws: WebSocket, roomId: string, peer: Peer): Promise<void> {
    // Messages that arrive while the room loads are handled after it has.
    const early: Buffer[] = [];
    const onEarly = (data: Buffer) => early.push(data);
    ws.on('message', onEarly);
    let room;
    try {
      room = await rooms.join(roomId, ws, peer);
    } catch (error) {
      console.error(`room ${roomId}: could not open`, error);
      ws.close(1011, 'could not open the room');
      return;
    }
    ws.off('message', onEarly);

    let tokens = BURST;
    let last = Date.now();
    let queue = Promise.resolve();
    const onMessage = (data: Buffer) => {
      const now = Date.now();
      tokens = Math.min(BURST, tokens + ((now - last) / 1000) * RATE);
      last = now;
      if (--tokens < 0) {
        // The client reconnects and resyncs from the server's scene.
        ws.close(1008, 'too many messages');
        return;
      }
      let message: ClientMessage;
      try {
        message = JSON.parse(data.toString());
      } catch {
        ws.close(1003, 'not JSON');
        return;
      }
      if (!isClientMessage(message)) {
        ws.close(1003, 'unknown message');
        return;
      }
      // In arrival order, also when one message waits for the store.
      queue = queue.then(() => room.receive(ws, message)).catch((error) => {
        console.error(`room ${roomId}:`, error);
        ws.close(1011, 'server error');
      });
    };
    ws.on('message', onMessage);
    for (const data of early) onMessage(data);

    // Proxies drop idle connections; a ping every 25 s keeps it open and
    // notices peers that vanished without closing.
    let alive = true;
    ws.on('pong', () => (alive = true));
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 25_000);

    ws.on('close', () => {
      clearInterval(ping);
      void queue.then(() => rooms.leave(room, ws)).catch((error) => console.error(`room ${roomId}:`, error));
    });
  }

  server.listen(PORT, () => console.log(`collab listening on :${PORT}`));

  const shutdown = async () => {
    console.log('shutting down: saving open rooms');
    server.close();
    for (const ws of wss.clients) ws.close(1012, 'server restarting');
    await rooms.flushAll();
    await store.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function isClientMessage(value: unknown): value is ClientMessage {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  switch (m.type) {
    case 'update':
      return Array.isArray(m.elements);
    case 'files':
      return Array.isArray(m.files);
    case 'file-request':
      return Array.isArray(m.ids) && m.ids.every((id) => typeof id === 'string');
    case 'pointer': {
      const p = m.pointer as Record<string, unknown> | null;
      return (
        typeof p === 'object' &&
        p !== null &&
        Number.isFinite(p.x) &&
        Number.isFinite(p.y) &&
        (p.tool === 'pointer' || p.tool === 'laser') &&
        (m.button === 'up' || m.button === 'down') &&
        typeof m.selectedElementIds === 'object' &&
        m.selectedElementIds !== null &&
        Object.values(m.selectedElementIds).every((v) => v === true)
      );
    }
    default:
      return false;
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
