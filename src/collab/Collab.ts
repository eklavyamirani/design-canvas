import { CaptureUpdateAction, reconcileElements, restoreElements } from '@excalidraw/excalidraw';
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { RemoteExcalidrawElement } from '@excalidraw/excalidraw/data/reconcile';
import type {
  BinaryFileData,
  BinaryFiles,
  Collaborator,
  ExcalidrawImperativeAPI,
  ExcalidrawProps,
  SocketId,
} from '@excalidraw/excalidraw/types';
import {
  LIMITS,
  type ClientMessage,
  type Peer,
  type ServerMessage,
  type SyncedElement,
  type SyncedFile,
  wins,
} from '../../shared/protocol';

export type Status = 'connecting' | 'online' | 'offline' | 'signed-out' | 'not-found';

type PointerPayload = Parameters<NonNullable<ExcalidrawProps['onPointerUpdate']>>[0];

const SEND_INTERVAL_MS = 50;
const POINTER_INTERVAL_MS = 40;
const RETRY_MAX_MS = 15_000;

export function roomUrl(roomId: string): string {
  return new URL(`r/${roomId}`, new URL(import.meta.env.BASE_URL, location.origin)).href;
}

function apiUrl(path: string): string {
  return new URL(`collab/${path}`, new URL(import.meta.env.BASE_URL, location.origin)).href;
}

// Fractional indices sort as plain strings; elements without one go last.
function indexOrder(a: unknown, b: unknown): number {
  if (typeof a !== 'string') return typeof b === 'string' ? 1 : 0;
  if (typeof b !== 'string') return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export async function createRoom(): Promise<string> {
  const response = await fetch(apiUrl('rooms'), { method: 'POST', redirect: 'manual' });
  if (!response.ok) throw new Error(`could not create a room (${response.status || 'signed out'})`);
  const { id } = (await response.json()) as { id: string };
  return id;
}

// Keeps one Excalidraw scene in sync with a room on the collab server
// (server/src/rooms.ts). Both ends merge with the same rule (the higher
// version wins, then the lower versionNonce), so every peer converges.
export class Collab {
  private ws: WebSocket | null = null;
  private stopped = false;
  private retryMs = 1_000;
  private retryTimer: number | undefined;
  // Newest version of each element the server is known to have, by id: what
  // we sent, or what it sent us. Only newer local versions are sent.
  private synced = new Map<string, OrderedExcalidrawElement>();
  private sendTimer: number | undefined;
  private knownFiles = new Set<string>();
  private requestedFiles = new Set<string>();
  private collaborators = new Map<SocketId, Collaborator>();
  private lastPointerSent = 0;

  constructor(
    readonly roomId: string,
    private api: ExcalidrawImperativeAPI,
    private onStatus: (status: Status) => void,
  ) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    window.clearTimeout(this.retryTimer);
    window.clearTimeout(this.sendTimer);
    this.ws?.close(1000);
    this.ws = null;
  }

  // Excalidraw's onChange: local edits, and also our own updateScene calls.
  onChange(files: BinaryFiles): void {
    if (this.sendTimer === undefined) {
      this.sendTimer = window.setTimeout(() => {
        this.sendTimer = undefined;
        this.sendElements();
      }, SEND_INTERVAL_MS);
    }
    this.sendNewFiles(files);
  }

  onPointerUpdate(payload: PointerPayload): void {
    const now = Date.now();
    if (now - this.lastPointerSent < POINTER_INTERVAL_MS) return;
    this.lastPointerSent = now;
    this.send({
      type: 'pointer',
      pointer: { x: payload.pointer.x, y: payload.pointer.y, tool: payload.pointer.tool },
      button: payload.button,
      selectedElementIds: this.api.getAppState().selectedElementIds,
    });
  }

  private connect(): void {
    if (this.stopped) return;
    this.onStatus('connecting');
    const url = new URL(apiUrl(`rooms/${this.roomId}/ws`));
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onmessage = (event) => this.receive(JSON.parse(event.data as string) as ServerMessage);
    ws.onopen = () => {
      this.retryMs = 1_000;
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearCollaborators();
      if (!this.stopped) void this.retry();
    };
  }

  // A refused WebSocket says nothing about why, so ask over HTTP.
  private async retry(): Promise<void> {
    const response = await fetch(apiUrl(`rooms/${this.roomId}`), { redirect: 'manual' }).catch(() => null);
    if (this.stopped) return;
    if (response && (response.type === 'opaqueredirect' || response.status === 401)) {
      // The platform sign-in expired; reconnecting can't work until a reload.
      return this.onStatus('signed-out');
    }
    if (response?.status === 404) return this.onStatus('not-found');
    this.onStatus('offline');
    this.retryTimer = window.setTimeout(() => this.connect(), this.retryMs);
    this.retryMs = Math.min(RETRY_MAX_MS, this.retryMs * 2);
  }

  private send(message: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  private receive(message: ServerMessage): void {
    switch (message.type) {
      case 'init':
        // A fresh connection: the server's scene is the new baseline, and any
        // local edits it lacks (made offline, or the drawing that started the
        // room) are sent right after.
        this.synced.clear();
        this.requestedFiles.clear();
        this.knownFiles = new Set(message.fileIds);
        this.applyRemote(message.elements);
        for (const peer of message.peers) this.setCollaborator(peer.id, { username: peer.name });
        this.updateCollaborators();
        this.onStatus('online');
        this.sendElements();
        this.sendNewFiles(this.api.getFiles());
        return;
      case 'update':
        return this.applyRemote(message.elements);
      case 'pointer':
        this.setCollaborator(message.from, {
          pointer: message.pointer,
          button: message.button,
          selectedElementIds: message.selectedElementIds,
        });
        return this.updateCollaborators();
      case 'peer-joined':
        this.setCollaborator(message.peer.id, { username: message.peer.name });
        return this.updateCollaborators();
      case 'peer-left':
        this.collaborators.delete(message.id as SocketId);
        return this.updateCollaborators();
      case 'files':
        for (const file of message.files) this.knownFiles.add(file.id);
        this.api.addFiles(message.files as BinaryFileData[]);
        return;
      case 'error':
        this.api.setToast({ message: message.message, closable: true });
    }
  }

  private applyRemote(remote: SyncedElement[]): void {
    const local = this.api.getSceneElementsIncludingDeleted();
    // restoreElements repairs what another editor version might send. Not
    // given the local scene: it would bump a stale remote element above the
    // local version and let it win. Sorted by fractional index, as it
    // re-indexes (and so re-versions) elements it finds out of order.
    const sorted = [...remote].sort((a, b) => indexOrder(a.index, b.index));
    const restored = restoreElements(sorted as never, null) as unknown as RemoteExcalidrawElement[];
    // Only elements that survived restore count: one this editor can't load
    // must not later look deleted to it.
    for (const element of restored) {
      if (wins(element, this.synced.get(element.id))) this.synced.set(element.id, element);
    }
    const elements = reconcileElements(local, restored, this.api.getAppState());
    this.api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
    this.requestMissingFiles();
  }

  private sendElements(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const scene = this.api.getSceneElementsIncludingDeleted();
    // Not just newer versions: an edit with the same version as the server's
    // but a lower versionNonce also wins there.
    const changed: OrderedExcalidrawElement[] = scene.filter((element) =>
      wins(element, this.synced.get(element.id)),
    );
    // Opening a file replaces the scene, so elements can vanish instead of
    // being marked deleted. Tell the others they are gone.
    const present = new Set(scene.map((element) => element.id));
    for (const [id, known] of this.synced) {
      if (present.has(id) || known.isDeleted) continue;
      changed.push({
        ...known,
        isDeleted: true,
        version: known.version + 1,
        versionNonce: Math.floor(Math.random() * 2 ** 31),
        updated: Date.now(),
      });
    }
    if (changed.length === 0) return;
    // Batches stay well under the server's frame limit.
    for (let start = 0; start < changed.length; start += 500) {
      const batch = changed.slice(start, start + 500);
      if (!this.send({ type: 'update', elements: batch as unknown as SyncedElement[] })) return;
      for (const element of batch) this.synced.set(element.id, element);
    }
  }

  private sendNewFiles(files: BinaryFiles): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    for (const file of Object.values(files)) {
      if (this.knownFiles.has(file.id)) continue;
      if (file.dataURL.length > LIMITS.fileBytes) {
        this.knownFiles.add(file.id);
        this.api.setToast({ message: 'An image is too large to share (over 4 MB)', closable: true });
        continue;
      }
      const synced: SyncedFile = { id: file.id, mimeType: file.mimeType, dataURL: file.dataURL, created: file.created };
      if (this.send({ type: 'files', files: [synced] })) this.knownFiles.add(file.id);
    }
  }

  private requestMissingFiles(): void {
    const have = this.api.getFiles();
    const missing: string[] = [];
    for (const element of this.api.getSceneElements()) {
      if (element.type !== 'image' || !element.fileId) continue;
      if (have[element.fileId] || this.requestedFiles.has(element.fileId)) continue;
      this.requestedFiles.add(element.fileId);
      missing.push(element.fileId);
    }
    if (missing.length > 0) this.send({ type: 'file-request', ids: missing });
  }

  private setCollaborator(id: string, update: Partial<Collaborator>): void {
    const socketId = id as SocketId;
    this.collaborators.set(socketId, { ...this.collaborators.get(socketId), ...update, socketId });
  }

  private updateCollaborators(): void {
    this.api.updateScene({ collaborators: new Map(this.collaborators) });
  }

  private clearCollaborators(): void {
    this.collaborators.clear();
    this.updateCollaborators();
  }
}

export type { Peer };
