import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  LIMITS,
  type ClientMessage,
  type Peer,
  type ServerMessage,
  type SyncedElement,
  type SyncedFile,
} from '../../shared/protocol.ts';
import { fitsLimit, isSyncedElement, wins } from './merge.ts';
import type { Store } from './store.ts';

const FLUSH_DELAY_MS = 500;
const FLUSH_RETRY_MS = 5_000;

export function newRoomId(): string {
  return randomBytes(16).toString('base64url');
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

// One open room: the authoritative scene while anyone is connected. Edits are
// merged here, relayed to the other peers, and written to the store in batches.
class Room {
  readonly elements = new Map<string, SyncedElement>();
  readonly peers = new Map<WebSocket, Peer>();
  fileIds = new Set<string>();
  private dirty = new Map<string, SyncedElement>();
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> = Promise.resolve();

  readonly id: string;
  private store: Store;
  // Called when everyone has left and every edit is saved.
  private onIdle: (room: Room) => void;

  constructor(id: string, store: Store, onIdle: (room: Room) => void) {
    this.id = id;
    this.store = store;
    this.onIdle = onIdle;
  }

  async load(): Promise<void> {
    const [elements, fileIds] = await Promise.all([this.store.loadElements(this.id), this.store.fileIds(this.id)]);
    for (const element of elements) this.elements.set(element.id, element);
    this.fileIds = new Set(fileIds);
  }

  join(socket: WebSocket, peer: Peer): void {
    for (const other of this.peers.keys()) send(other, { type: 'peer-joined', peer });
    send(socket, {
      type: 'init',
      you: peer,
      peers: [...this.peers.values()],
      elements: [...this.elements.values()],
      fileIds: [...this.fileIds],
    });
    this.peers.set(socket, peer);
  }

  leave(socket: WebSocket): void {
    const peer = this.peers.get(socket);
    if (!peer) return;
    this.peers.delete(socket);
    for (const other of this.peers.keys()) send(other, { type: 'peer-left', id: peer.id });
  }

  async receive(socket: WebSocket, message: ClientMessage): Promise<void> {
    const peer = this.peers.get(socket);
    if (!peer) return;
    switch (message.type) {
      case 'update':
        return this.update(socket, message.elements);
      case 'pointer':
        return this.relay(socket, {
          type: 'pointer',
          from: peer.id,
          pointer: { x: message.pointer.x, y: message.pointer.y, tool: message.pointer.tool },
          button: message.button,
          selectedElementIds: message.selectedElementIds,
        });
      case 'files':
        return this.addFiles(socket, message.files);
      case 'file-request': {
        const ids = message.ids.filter((id) => this.fileIds.has(id)).slice(0, LIMITS.filesPerRoom);
        // One frame per file keeps each under the frame limit.
        for (const file of await this.store.loadFiles(this.id, ids)) send(socket, { type: 'files', files: [file] });
      }
    }
  }

  private update(socket: WebSocket, elements: unknown[]): void {
    const accepted: SyncedElement[] = [];
    let rejected = 0;
    for (const element of elements) {
      if (!isSyncedElement(element) || !fitsLimit(element)) {
        rejected++;
        continue;
      }
      const current = this.elements.get(element.id);
      if (!current && this.elements.size >= LIMITS.elementsPerRoom) {
        rejected++;
        continue;
      }
      if (!wins(element, current)) continue;
      this.elements.set(element.id, element);
      this.dirty.set(element.id, element);
      accepted.push(element);
    }
    if (rejected > 0) send(socket, { type: 'error', message: `${rejected} element(s) were too large or over the room limit` });
    if (accepted.length === 0) return;
    this.relay(socket, { type: 'update', elements: accepted });
    this.scheduleFlush(FLUSH_DELAY_MS);
  }

  private async addFiles(socket: WebSocket, files: unknown[]): Promise<void> {
    for (const file of files) {
      if (!isSyncedFile(file)) continue;
      if (!this.fileIds.has(file.id)) {
        if (this.fileIds.size >= LIMITS.filesPerRoom) {
          send(socket, { type: 'error', message: 'This room has reached its image limit' });
          return;
        }
        await this.store.saveFile(this.id, file);
        this.fileIds.add(file.id);
      }
      this.relay(socket, { type: 'files', files: [file] });
    }
  }

  private relay(from: WebSocket, message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const socket of this.peers.keys()) {
      if (socket !== from && socket.readyState === socket.OPEN) socket.send(data);
    }
  }

  private scheduleFlush(delay: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, delay);
  }

  // Serialised, so batches reach the store in order.
  flush(): Promise<void> {
    this.flushing = this.flushing.then(async () => {
      if (this.dirty.size === 0) return;
      const batch = this.dirty;
      this.dirty = new Map();
      try {
        await this.store.saveElements(this.id, [...batch.values()]);
        if (this.peers.size === 0 && this.dirty.size === 0) this.onIdle(this);
      } catch (error) {
        console.error(`room ${this.id}: saving ${batch.size} element(s) failed, retrying`, error);
        // Put them back unless a newer edit has replaced them meanwhile.
        for (const [id, element] of batch) if (!this.dirty.has(id)) this.dirty.set(id, element);
        this.scheduleFlush(FLUSH_RETRY_MS);
      }
    });
    return this.flushing;
  }

}

function isSyncedFile(value: unknown): value is SyncedFile {
  if (typeof value !== 'object' || value === null) return false;
  const f = value as Record<string, unknown>;
  return (
    typeof f.id === 'string' &&
    f.id.length > 0 &&
    f.id.length <= 128 &&
    typeof f.mimeType === 'string' &&
    /^image\/[a-z0-9.+-]+$/.test(f.mimeType) &&
    typeof f.dataURL === 'string' &&
    f.dataURL.startsWith(`data:${f.mimeType};base64,`) &&
    f.dataURL.length <= LIMITS.fileBytes &&
    Number.isSafeInteger(f.created)
  );
}

export class Rooms {
  private open = new Map<string, Promise<Room>>();
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  async create(createdBy: string): Promise<string> {
    const id = newRoomId();
    await this.store.createRoom(id, createdBy);
    return id;
  }

  exists(id: string): Promise<boolean> {
    return this.open.has(id) ? Promise.resolve(true) : this.store.roomExists(id);
  }

  // Concurrent joins of a closed room share one load. There is never more
  // than one Room per id: a room that closed while this join waited is
  // reopened from the store, which by then has all of its edits.
  async join(id: string, socket: WebSocket, peer: Peer): Promise<Room> {
    for (;;) {
      const opening = this.open.get(id) ?? this.openRoom(id);
      const room = await opening;
      if (this.open.get(id) !== opening) continue;
      room.join(socket, peer);
      return room;
    }
  }

  private openRoom(id: string): Promise<Room> {
    const room = new Room(id, this.store, () => {
      if (this.open.get(id) === opening) this.open.delete(id);
    });
    const opening = room.load().then(() => room);
    this.open.set(id, opening);
    opening.catch(() => {
      if (this.open.get(id) === opening) this.open.delete(id);
    });
    return opening;
  }

  // The room closes (onIdle) once its last edits are saved.
  async leave(room: Room, socket: WebSocket): Promise<void> {
    room.leave(socket);
    if (room.peers.size === 0) await room.flush();
  }

  async flushAll(): Promise<void> {
    await Promise.allSettled([...this.open.values()].map(async (opening) => (await opening).flush()));
  }
}
