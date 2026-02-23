import { createWriteStream, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const RUNS_DIR = '.studio/runs';

function runIdShort(runId: string): string {
  return runId.slice(0, 8);
}

function dateForFilename(): string {
  const iso = new Date().toISOString();
  return iso.slice(0, 16).replace(/(\d{2}):(\d{2})$/, '$1h$2m');
}

export interface RunLogger {
  start(runId: string, pipeline: string): void;
  log(payload: Record<string, unknown>): void;
  close(): Promise<void>;
  getLogPath(): string;
}

export function createRunLogger(cwd: string = process.cwd()): RunLogger {
  let logPath = '';
  let stream: ReturnType<typeof createWriteStream> | null = null;
  let shortRunId = '';

  return {
    start(runId: string, pipeline: string): void {
      shortRunId = runIdShort(runId);
      const date = dateForFilename();
      const base = resolve(cwd, RUNS_DIR);
      logPath = resolve(base, `${date}-${pipeline}-${shortRunId}.jsonl`);
      mkdirSync(base, { recursive: true });
      stream = createWriteStream(logPath, { flags: 'a' });
    },

    log(payload: Record<string, unknown>): void {
      const line: Record<string, unknown> = {
        ts: new Date().toISOString(),
        ...payload,
        run_id: payload.run_id !== undefined ? runIdShort(String(payload.run_id)) : shortRunId,
      };
      const out = JSON.stringify(line) + '\n';
      if (stream?.writable) {
        stream.write(out);
      }
    },

    close(): Promise<void> {
      return new Promise((resolve) => {
        if (stream) {
          stream.end(() => {
            stream = null;
            resolve();
          });
        } else {
          resolve();
        }
      });
    },

    getLogPath(): string {
      return logPath;
    },
  };
}
