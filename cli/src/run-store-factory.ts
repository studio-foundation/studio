import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { StudioConfig } from './config.js';
import { SQLiteRunStore } from '@studio/engine';
import type { RunStore } from '@studio/engine';

/**
 * Create the production RunStore from config.
 * Derives the SQLite path from config.resolvedStudioDir.
 * Future: read config.db.adapter to return PostgreSQL/Supabase store instead.
 */
export function createRunStore(config: StudioConfig): RunStore {
  const studioDir = config.resolvedStudioDir ?? join(process.cwd(), '.studio');
  mkdirSync(studioDir, { recursive: true });
  const dbPath = join(studioDir, 'runs.db');
  return new SQLiteRunStore(dbPath);
}
