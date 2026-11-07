import pg from 'pg';
import type { SyncedElement, SyncedFile } from '../../shared/protocol.ts';
import { wins } from './merge.ts';

// Where rooms live between sessions. Postgres in the platform (DATABASE_URL);
// memory for local development and tests.
export interface Store {
  // Where rooms are kept, for the startup log; throws if unreachable.
  describe(): Promise<string>;
  createRoom(id: string, createdBy: string): Promise<void>;
  roomExists(id: string): Promise<boolean>;
  loadElements(roomId: string): Promise<SyncedElement[]>;
  // Keeps, per element, whichever of the stored and the given one wins.
  saveElements(roomId: string, elements: SyncedElement[]): Promise<void>;
  fileIds(roomId: string): Promise<string[]>;
  loadFiles(roomId: string, ids: string[]): Promise<SyncedFile[]>;
  saveFile(roomId: string, file: SyncedFile): Promise<void>;
  close(): Promise<void>;
}

export class MemoryStore implements Store {
  private rooms = new Map<string, { elements: Map<string, SyncedElement>; files: Map<string, SyncedFile> }>();

  async describe(): Promise<string> {
    return 'memory';
  }

  async createRoom(id: string): Promise<void> {
    if (!this.rooms.has(id)) this.rooms.set(id, { elements: new Map(), files: new Map() });
  }

  async roomExists(id: string): Promise<boolean> {
    return this.rooms.has(id);
  }

  async loadElements(roomId: string): Promise<SyncedElement[]> {
    return [...(this.rooms.get(roomId)?.elements.values() ?? [])];
  }

  async saveElements(roomId: string, elements: SyncedElement[]): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`no room ${roomId}`);
    for (const element of elements) {
      if (wins(element, room.elements.get(element.id))) room.elements.set(element.id, element);
    }
  }

  async fileIds(roomId: string): Promise<string[]> {
    return [...(this.rooms.get(roomId)?.files.keys() ?? [])];
  }

  async loadFiles(roomId: string, ids: string[]): Promise<SyncedFile[]> {
    const files = this.rooms.get(roomId)?.files;
    return ids.flatMap((id) => files?.get(id) ?? []);
  }

  async saveFile(roomId: string, file: SyncedFile): Promise<void> {
    this.rooms.get(roomId)?.files.set(file.id, file);
  }

  async close(): Promise<void> {}
}

export class PgStore implements Store {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    // Idle connections stay open: no reconnect on the next edit, and the
    // platform's verify sees which role the app connects as.
    this.pool = new pg.Pool({ connectionString, max: 5, idleTimeoutMillis: 0 });
  }

  async describe(): Promise<string> {
    const { rows } = await this.pool.query<{ db: string; role: string }>(
      'select current_database() as db, current_user as role',
    );
    return `postgres database ${rows[0].db} as ${rows[0].role}`;
  }

  async createRoom(id: string, createdBy: string): Promise<void> {
    await this.pool.query('insert into rooms (id, created_by) values ($1, $2)', [id, createdBy]);
  }

  async roomExists(id: string): Promise<boolean> {
    const result = await this.pool.query('select 1 from rooms where id = $1', [id]);
    return result.rowCount === 1;
  }

  async loadElements(roomId: string): Promise<SyncedElement[]> {
    const result = await this.pool.query<{ data: SyncedElement }>(
      'select data from room_elements where room_id = $1',
      [roomId],
    );
    return result.rows.map((row) => row.data);
  }

  async saveElements(roomId: string, elements: SyncedElement[]): Promise<void> {
    if (elements.length === 0) return;
    // One statement per flush. The WHERE is wins() in SQL, so a slow flush
    // can never overwrite a newer element saved in between. Callers pass each
    // id at most once (ON CONFLICT can't update a row twice).
    await this.pool.query(
      `insert into room_elements (room_id, id, version, version_nonce, data)
       select $1, e->>'id', (e->>'version')::bigint, (e->>'versionNonce')::bigint, e
       from jsonb_array_elements($2::jsonb) as e
       on conflict (room_id, id) do update
         set version = excluded.version, version_nonce = excluded.version_nonce, data = excluded.data
         where excluded.version > room_elements.version
            or (excluded.version = room_elements.version
                and excluded.version_nonce < room_elements.version_nonce)`,
      [roomId, JSON.stringify(elements)],
    );
    await this.pool.query('update rooms set updated_at = now() where id = $1', [roomId]);
  }

  async fileIds(roomId: string): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>('select id from room_files where room_id = $1', [roomId]);
    return result.rows.map((row) => row.id);
  }

  async loadFiles(roomId: string, ids: string[]): Promise<SyncedFile[]> {
    if (ids.length === 0) return [];
    const result = await this.pool.query<{ id: string; mime_type: string; data_url: string; created: string }>(
      'select id, mime_type, data_url, created from room_files where room_id = $1 and id = any($2)',
      [roomId, ids],
    );
    return result.rows.map((row) => ({
      id: row.id,
      mimeType: row.mime_type,
      dataURL: row.data_url,
      created: Number(row.created),
    }));
  }

  async saveFile(roomId: string, file: SyncedFile): Promise<void> {
    // A file id is a hash of its content, so a second copy is the same file.
    await this.pool.query(
      `insert into room_files (room_id, id, mime_type, data_url, created)
       values ($1, $2, $3, $4, $5) on conflict do nothing`,
      [roomId, file.id, file.mimeType, file.dataURL, file.created],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
