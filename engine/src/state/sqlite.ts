import { createRequire } from 'node:module';

/** The synchronous SQLite surface the stores use — the intersection of `node:sqlite` and `bun:sqlite`. */
export interface SyncDatabase {
  exec(sql: string): void;
  prepare(sql: string): SyncStatement;
  close(): void;
}

export interface SyncStatement {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

type DatabaseCtor = new (path: string) => SyncDatabase;

/**
 * Open a SQLite database on whichever runtime is hosting Studio.
 *
 * The standalone binary is compiled with Bun, which ships `bun:sqlite` and no
 * `node:sqlite` — same synchronous API, different module name.
 */
export function openDatabase(path: string): SyncDatabase {
  const _require = createRequire(import.meta.url);
  const moduleName = process.versions.bun ? 'bun:sqlite' : 'node:sqlite';
  const mod = _require(moduleName) as { Database?: DatabaseCtor; DatabaseSync?: DatabaseCtor };
  const Ctor = mod.Database ?? mod.DatabaseSync;
  if (!Ctor) throw new Error(`${moduleName} exposes no database constructor`);
  return new Ctor(path);
}
