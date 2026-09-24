/**
 * `studio run` in a directory that is not a Studio project must fail without
 * leaving a `.studio/` behind (STU-1699).
 *
 * The run store used to be created before the pipeline was loaded, so the
 * ENOENT for a missing pipeline came after `.studio/runs/runs.db` was already
 * written into the current directory — which, run from inside a repo, showed up
 * as an untracked `.studio/` next to the agent's own changes.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const CLI_BIN = resolve(import.meta.dirname, '../../dist/index.js');

describe('studio run outside a project', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('exits non-zero and creates no .studio/', () => {
    dir = mkdtempSync(join(tmpdir(), 'studio-no-project-'));

    const result = spawnSync(process.execPath, [CLI_BIN, 'run', 'code', '--input', 'x'], {
      cwd: dir,
      stdio: 'ignore',
      timeout: 15_000,
    });

    expect(result.status).not.toBe(0);
    expect(existsSync(join(dir, '.studio'))).toBe(false);
  }, 20_000);
});
