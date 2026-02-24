// JSONL logger for API runs
// Writes to <runsDir>/<date>-<pipeline>-<runId>.jsonl

import { createWriteStream, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

function runIdShort(runId: string): string {
  return runId.slice(0, 8);
}

function dateForFilename(): string {
  const iso = new Date().toISOString();
  return iso.slice(0, 16).replace(/(\d{2}):(\d{2})$/, '$1h$2m');
}

export interface ApiRunLogger {
  logPath: string;
  log(payload: Record<string, unknown>): void;
  close(): Promise<void>;
}

export function createApiLogger(runsDir: string, runId: string, pipeline: string): ApiRunLogger {
  const shortId = runIdShort(runId);
  const date = dateForFilename();
  const logPath = resolve(runsDir, `${date}-${pipeline}-${shortId}.jsonl`);

  mkdirSync(runsDir, { recursive: true });
  const stream = createWriteStream(logPath, { flags: 'a' });

  return {
    logPath,

    log(payload: Record<string, unknown>): void {
      const line = {
        ts: new Date().toISOString(),
        run_id: shortId,
        ...payload,
      };
      if (stream.writable) {
        stream.write(JSON.stringify(line) + '\n');
      }
    },

    close(): Promise<void> {
      return new Promise((resolve) => {
        stream.end(() => resolve());
      });
    },
  };
}
