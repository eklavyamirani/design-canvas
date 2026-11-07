import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';

// Applies migrations/NNN-*.sql in order, each once, in its own transaction.
// The platform runs this (`--migrate`) as the database owner before each
// deploy; the server itself connects as the runtime role, which may only
// read and write the tables granted below.
const DIR = new URL('../migrations/', import.meta.url);
const TABLES = ['rooms', 'room_elements', 'room_files'];

export async function migrate(connectionString: string, runtimeRole: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    // Two deploys must not migrate at the same time.
    await client.query("select pg_advisory_lock(hashtext('design-canvas migrations'))");
    await client.query(`create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`);
    const done = new Set(
      (await client.query<{ name: string }>('select name from schema_migrations')).rows.map((row) => row.name),
    );
    const files = readdirSync(DIR)
      .filter((name) => /^\d{3}-.*\.sql$/.test(name))
      .sort();
    for (const name of files) {
      if (done.has(name)) continue;
      console.log(`migrating: ${name}`);
      await client.query('begin');
      try {
        await client.query(readFileSync(new URL(name, DIR), 'utf8'));
        await client.query('insert into schema_migrations (name) values ($1)', [name]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    }
    // Every time, not in a migration: the runtime role differs per
    // environment (a preview's clone drops the grants it was copied with).
    const role = (await client.query<{ q: string }>('select quote_ident($1) as q', [runtimeRole])).rows[0].q;
    await client.query(`grant select, insert, update, delete on ${TABLES.join(', ')} to ${role}`);
    console.log(`migrations up to date (${files.length}); ${runtimeRole} may read and write ${TABLES.join(', ')}`);
  } finally {
    await client.end();
  }
}
