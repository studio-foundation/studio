import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { StudioConfig } from './config.js';
import { SQLiteRunStore, InMemoryRunStore, PgRunStore } from '@studio-foundation/engine';
import type { AnyRunStore } from '@studio-foundation/engine';

/**
 * Create the production RunStore from config.
 * Returns AnyRunStore (sync RunStore or async AsyncRunStore) based on config.db.type.
 * Defaults to SQLite when no db config is present.
 */
export async function createRunStore(config: StudioConfig): Promise<AnyRunStore> {
  const dbType = config.db?.type ?? 'sqlite';

  if (dbType === 'inmemory') {
    return new InMemoryRunStore();
  }

  if (dbType === 'postgres') {
    const url = config.db?.url;
    if (!url) throw new Error('db.url is required when db.type is postgres');
    return new PgRunStore(url);
  }

  // Default: sqlite
  const studioDir = config.resolvedStudioDir ?? join(process.cwd(), '.studio');
  mkdirSync(join(studioDir, 'runs'), { recursive: true });
  const dbPath = join(studioDir, 'runs', 'runs.db');
  return new SQLiteRunStore(dbPath);
}
