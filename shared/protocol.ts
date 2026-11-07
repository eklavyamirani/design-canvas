// Messages between the editor and the collab server (server/), one JSON
// object per WebSocket frame. Imported by both sides, so it holds only types,
// limits and the merge rule.

// Excalidraw's own element fields that the server reads. Everything else is
// passed through as is.
export type SyncedElement = {
  id: string;
  version: number;
  versionNonce: number;
  [key: string]: unknown;
};

export type SyncedFile = {
  id: string;
  mimeType: string;
  dataURL: string;
  created: number;
};

export type Pointer = { x: number; y: number; tool: 'pointer' | 'laser' };

export type Peer = { id: string; name: string };

type Versioned = { version: number; versionNonce: number };

// The same rule as Excalidraw's reconcileElements: the higher version wins,
// and of two edits with the same version the one with the lower versionNonce
// wins. The server and every editor apply it, so all of them converge on the
// same element whatever order the edits arrive in.
export function wins(incoming: Versioned, current: Versioned | undefined): boolean {
  if (!current) return true;
  if (incoming.version !== current.version) return incoming.version > current.version;
  return incoming.versionNonce < current.versionNonce;
}

export type ClientMessage =
  | { type: 'update'; elements: SyncedElement[] }
  | { type: 'pointer'; pointer: Pointer; button: 'up' | 'down'; selectedElementIds: Record<string, true> }
  | { type: 'files'; files: SyncedFile[] }
  | { type: 'file-request'; ids: string[] };

export type ServerMessage =
  | { type: 'init'; you: Peer; peers: Peer[]; elements: SyncedElement[]; fileIds: string[] }
  | { type: 'update'; elements: SyncedElement[] }
  | {
      type: 'pointer';
      from: string;
      pointer: Pointer;
      button: 'up' | 'down';
      selectedElementIds: Record<string, true>;
    }
  | { type: 'files'; files: SyncedFile[] }
  | { type: 'peer-joined'; peer: Peer }
  | { type: 'peer-left'; id: string }
  | { type: 'error'; message: string };

// Room ids are 22 base64url characters (128 random bits).
export const ROOM_ID = /^[A-Za-z0-9_-]{22}$/;

export const LIMITS = {
  // One WebSocket frame; a pasted image is the largest thing sent.
  frameBytes: 6 * 1024 * 1024,
  // One image, as a data URL.
  fileBytes: 4 * 1024 * 1024,
  // Images per room, and elements per room (deleted ones included).
  filesPerRoom: 200,
  elementsPerRoom: 20_000,
  elementBytes: 256 * 1024,
};
