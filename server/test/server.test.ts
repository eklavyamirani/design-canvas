import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import type { ServerMessage, SyncedElement } from '../../shared/protocol.ts';
import { wins } from '../src/merge.ts';

const PORT = 18_000 + Math.floor(Math.random() * 1000);
const ORIGIN = 'https://canvas.test';
const BASE = `http://127.0.0.1:${PORT}`;

function element(id: string, version: number, versionNonce: number, extra: object = {}): SyncedElement {
  return { id, version, versionNonce, type: 'rectangle', isDeleted: false, ...extra };
}

describe('wins', () => {
  it('takes the higher version, then the lower versionNonce', () => {
    assert.equal(wins(element('a', 2, 9), element('a', 1, 1)), true);
    assert.equal(wins(element('a', 1, 1), element('a', 2, 9)), false);
    assert.equal(wins(element('a', 3, 1), element('a', 3, 5)), true);
    assert.equal(wins(element('a', 3, 5), element('a', 3, 1)), false);
    assert.equal(wins(element('a', 3, 5), element('a', 3, 5)), false);
    assert.equal(wins(element('a', 1, 1), undefined), true);
  });
});

// A WebSocket client that collects what the server sends.
class Client {
  ws: WebSocket;
  messages: ServerMessage[] = [];
  private waiters: Array<() => void> = [];

  constructor(roomId: string, user: string | null, origin = ORIGIN) {
    const headers: Record<string, string> = { origin };
    if (user) Object.assign(headers, { 'x-auth-request-user': `sub-${user}`, 'x-auth-request-email': user });
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/collab/rooms/${roomId}/ws`, { headers });
    this.ws.on('message', (data) => {
      this.messages.push(JSON.parse(data.toString()));
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  async next<T extends ServerMessage['type']>(type: T): Promise<Extract<ServerMessage, { type: T }>> {
    for (;;) {
      const index = this.messages.findIndex((m) => m.type === type);
      if (index >= 0) return this.messages.splice(index, 1)[0] as Extract<ServerMessage, { type: T }>;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ${type} message`)), 3000);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  send(message: object): void {
    this.ws.send(JSON.stringify(message));
  }

  async close(): Promise<void> {
    this.ws.close();
    await once(this.ws, 'close');
  }
}

async function createRoom(user = 'ana@example.test', origin = ORIGIN): Promise<Response> {
  return fetch(`${BASE}/collab/rooms`, {
    method: 'POST',
    headers: { origin, 'x-auth-request-user': `sub-${user}`, 'x-auth-request-email': user },
  });
}

// TEST_DATABASE_URL (the runtime role, after `npm run migrate` as the owner)
// runs the same tests against Postgres; unset, rooms are kept in memory.
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';

async function startServer(): Promise<ChildProcess> {
  const server = spawn(process.execPath, ['src/index.ts'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(PORT), ALLOWED_ORIGIN: ORIGIN, DATABASE_URL },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  for await (const chunk of server.stdout!) if (String(chunk).includes('listening')) break;
  return server;
}

async function stopServer(server: ChildProcess): Promise<void> {
  server.kill('SIGTERM');
  await once(server, 'exit');
}

describe('collab server', () => {
  let server: ChildProcess;

  before(async () => {
    server = await startServer();
  });

  after(async () => {
    await stopServer(server);
  });

  it('keeps rooms across restarts', { skip: !DATABASE_URL && 'needs TEST_DATABASE_URL' }, async () => {
    const { id } = (await (await createRoom()).json()) as { id: string };
    const ana = new Client(id, 'ana@example.test');
    await ana.next('init');
    ana.send({ type: 'update', elements: [element('kept', 4, 4)] });
    // Still connected: the shutdown has to save the room.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await stopServer(server);
    server = await startServer();
    const ben = new Client(id, 'ben@example.test');
    assert.deepEqual((await ben.next('init')).elements, [element('kept', 4, 4)]);
    await ben.close();
  });

  it('refuses requests without the platform identity or from another origin', async () => {
    const anonymous = await fetch(`${BASE}/collab/rooms`, { method: 'POST', headers: { origin: ORIGIN } });
    assert.equal(anonymous.status, 401);
    assert.equal((await createRoom('ana@example.test', 'https://evil.test')).status, 403);

    const { id } = (await (await createRoom()).json()) as { id: string };
    for (const [user, origin, status] of [
      [null, ORIGIN, 401],
      ['ana@example.test', 'https://evil.test', 403],
    ] as const) {
      const client = new Client(id, user, origin);
      const [, response] = (await once(client.ws, 'unexpected-response')) as [unknown, { statusCode: number }];
      assert.equal(response.statusCode, status);
      client.ws.on('error', () => {}); // terminate() reports the aborted handshake
      client.ws.terminate();
    }
  });

  it('answers 404 for a room that does not exist', async () => {
    const response = await fetch(`${BASE}/collab/rooms/AAAAAAAAAAAAAAAAAAAAAA`, {
      headers: { 'x-auth-request-user': 'sub-ana' },
    });
    assert.equal(response.status, 404);
  });

  it('relays edits, keeps the winning version, and serves the scene to late joiners', async () => {
    const { id } = (await (await createRoom()).json()) as { id: string };
    const ana = new Client(id, 'ana@example.test');
    const anaInit = await ana.next('init');
    assert.deepEqual(anaInit.elements, []);
    assert.equal(anaInit.you.name, 'ana@example.test');

    const ben = new Client(id, 'ben@example.test');
    await ben.next('init');
    assert.equal((await ana.next('peer-joined')).peer.name, 'ben@example.test');

    ana.send({ type: 'update', elements: [element('box', 2, 50)] });
    assert.deepEqual((await ben.next('update')).elements, [element('box', 2, 50)]);

    // Stale and losing edits are dropped; the winner is relayed.
    ben.send({ type: 'update', elements: [element('box', 1, 1), element('box', 2, 70), element('box', 2, 10)] });
    assert.deepEqual((await ana.next('update')).elements, [element('box', 2, 10)]);

    ana.send({ type: 'pointer', pointer: { x: 1, y: 2, tool: 'pointer', extra: 1 }, button: 'up', selectedElementIds: {} });
    const pointer = await ben.next('pointer');
    assert.deepEqual(pointer.pointer, { x: 1, y: 2, tool: 'pointer' });
    assert.equal(pointer.from, anaInit.you.id);

    const file = { id: 'f1', mimeType: 'image/png', dataURL: 'data:image/png;base64,AAAA', created: 1 };
    ana.send({ type: 'files', files: [file] });
    assert.deepEqual((await ben.next('files')).files, [file]);

    await ben.close();
    await ana.next('peer-left');
    await ana.close();

    const cleo = new Client(id, 'cleo@example.test');
    const init = await cleo.next('init');
    assert.deepEqual(init.elements, [element('box', 2, 10)]);
    assert.deepEqual(init.fileIds, ['f1']);
    cleo.send({ type: 'file-request', ids: ['f1', 'unknown'] });
    assert.deepEqual((await cleo.next('files')).files, [file]);
    await cleo.close();
  });

  it('rejects malformed elements and closes on garbage', async () => {
    const { id } = (await (await createRoom()).json()) as { id: string };
    const ana = new Client(id, 'ana@example.test');
    await ana.next('init');
    ana.send({ type: 'update', elements: [{ id: 'x' }, element('big', 1, 1, { text: 'x'.repeat(300_000) })] });
    assert.match((await ana.next('error')).message, /2 element/);
    ana.ws.send('not json');
    const [code] = (await once(ana.ws, 'close')) as [number];
    assert.equal(code, 1003);
  });
});
