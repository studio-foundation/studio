/**
 * STU-410: the path a newcomer takes must keep working — init the software
 * template with no network, drop in the documented example mock.yaml, and run
 * a pipeline with `--provider mock` to success. Guards the quickstart in the
 * README and the example under docs/examples/.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const CLI_BIN = resolve(import.meta.dirname, '../../dist/index.js');
const EXAMPLE = resolve(import.meta.dirname, '../../../docs/examples/mock.quick-edit.yaml');
const TMP = resolve('/tmp', '.studio-first-run-mock-test');

afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('first run with the mock provider', () => {
  it('inits offline, follows the documented mock.yaml, and succeeds', async () => {
    await mkdir(TMP, { recursive: true });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND')));

    const cwd = process.cwd();
    process.chdir(TMP);
    try {
      const { initCommand } = await import('../../src/commands/init.js');
      await initCommand('demo', { template: 'software', provider: 'later' });
    } finally {
      process.chdir(cwd);
    }
    await copyFile(EXAMPLE, join(TMP, '.studio', 'mock.yaml'));

    const child = spawn(
      process.execPath,
      [CLI_BIN, 'run', 'quick-edit', '--input', 'x', '--provider', 'mock'],
      { cwd: TMP, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (c: Buffer) => { out += c.toString('utf-8'); });
    child.stderr.on('data', (c: Buffer) => { out += c.toString('utf-8'); });
    const code = await new Promise<number | null>((res) => child.on('exit', res));

    expect(out).toContain('success');
    expect(code).toBe(0);
  }, 30_000);
});
