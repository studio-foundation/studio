import { readdir, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { keymapDir, purgeKeymaps } from '@studio-foundation/engine';
import type { StudioConfig } from './config.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const LOG_NAME = /^.+-([a-f0-9]{8})\.jsonl$/i;

export interface PruneOptions {
  keepLast?: number;
  maxAgeMs?: number;
  keepStatus?: string[];
  dryRun?: boolean;
  now?: number;
}

export interface PrunedRun {
  file: string;
  status: string;
  ageDays: number;
}

export interface PruneResult {
  runs: PrunedRun[];
  keymaps: number;
}

export function parseDuration(text: string): number {
  const match = /^(\d+)([dh])$/.exec(text.trim());
  if (!match) throw new Error(`Invalid duration "${text}": use a number of days or hours, e.g. 30d or 12h`);
  return Number(match[1]) * (match[2] === 'd' ? DAY_MS : DAY_MS / 24);
}

async function readStatus(file: string): Promise<string> {
  const content = await readFile(file, 'utf-8');
  let status = 'running';
  for (const line of content.split('\n')) {
    if (!line.includes('"pipeline_complete"')) continue;
    try {
      const record = JSON.parse(line) as { event?: string; status?: string; depth?: number };
      if (record.event === 'pipeline_complete' && !record.depth) status = record.status ?? status;
    } catch {
      continue;
    }
  }
  return status;
}

/**
 * Delete run logs (and each run's anonymization keymap) that no rule protects.
 * A run is kept when it is among the `keepLast` newest or its status is in
 * `keepStatus`; of the rest, `maxAgeMs` (when set) removes only the older ones.
 * A run with no `pipeline_complete` yet is treated as live for a day.
 */
export async function pruneRuns(studioDir: string, options: PruneOptions): Promise<PruneResult> {
  const { keepLast, maxAgeMs, keepStatus = [], dryRun = false, now = Date.now() } = options;
  if (keepLast === undefined && maxAgeMs === undefined) {
    throw new Error('Nothing to prune by: pass --keep-last and/or --max-age');
  }
  const runsDir = join(studioDir, 'runs');
  let names: string[];
  try {
    names = (await readdir(runsDir)).filter((n) => LOG_NAME.test(n));
  } catch {
    return { runs: [], keymaps: 0 };
  }

  const logs = await Promise.all(
    names.map(async (name) => {
      const file = join(runsDir, name);
      return { name, file, mtimeMs: (await stat(file)).mtimeMs, status: await readStatus(file) };
    }),
  );
  logs.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const doomed = logs.filter((log, index) => {
    const age = now - log.mtimeMs;
    if (keepLast !== undefined && index < keepLast) return false;
    if (keepStatus.includes(log.status)) return false;
    if (log.status === 'running' && age < DAY_MS) return false;
    return maxAgeMs === undefined || age > maxAgeMs;
  });

  const shortIds = new Set(doomed.map((log) => LOG_NAME.exec(log.name)![1].toLowerCase()));
  if (!dryRun) await Promise.all(doomed.map((log) => rm(log.file, { force: true })));
  const keymaps = await purgeKeymaps(
    keymapDir(studioDir),
    (runId) => shortIds.has(runId.replace(/-/g, '').slice(0, 8).toLowerCase()),
    dryRun,
  );

  return {
    runs: doomed.map((log) => ({ file: log.name, status: log.status, ageDays: Math.floor((now - log.mtimeMs) / DAY_MS) })),
    keymaps: keymaps.length,
  };
}

/** Applies `runs.retention` after a run; never throws, a failed prune must not change the run's outcome. */
export async function applyRunRetention(config: StudioConfig): Promise<void> {
  const days = config.runs?.retention?.max_age_days;
  if (!days || !config.resolvedStudioDir) return;
  try {
    await pruneRuns(config.resolvedStudioDir, { maxAgeMs: days * DAY_MS });
  } catch {
    return;
  }
}
