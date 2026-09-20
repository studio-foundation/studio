/**
 * STU-410 / STU-1529: the path a newcomer takes must keep working. Init the
 * software template with no network and run a pipeline with `--provider mock`
 * to success on the mock.yaml that init generated. Guards the README quickstart.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const CLI_BIN = resolve(import.meta.dirname, '../../dist/index.js');
const TMP = resolve('/tmp', '.studio-first-run-mock-test');

afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('first run with the mock provider', () => {
  it('inits offline, runs on the generated mock.yaml, and succeeds', async () => {
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
    // The search plugin requires ripgrep on PATH; the mock run never invokes it.
    await mkdir(join(TMP, 'bin'), { recursive: true });
    await writeFile(join(TMP, 'bin', 'rg'), '#!/bin/sh\n');
    await chmod(join(TMP, 'bin', 'rg'), 0o755);

    const child = spawn(
      process.execPath,
      [CLI_BIN, 'run', 'quick-edit', '--input', 'x', '--provider', 'mock'],
      { cwd: TMP, env: { ...process.env, PATH: `${join(TMP, 'bin')}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (c: Buffer) => { out += c.toString('utf-8'); });
    child.stderr.on('data', (c: Buffer) => { out += c.toString('utf-8'); });
    const code = await new Promise<number | null>((res) => child.on('exit', res));

    expect(out).toContain('success');
    expect(code).toBe(0);
  }, 30_000);
});
