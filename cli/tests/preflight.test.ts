import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { collectChecks, unsetEnvRefs } from '../src/preflight.js';
import type { PreflightCheck } from '../src/preflight.js';
import { STUDIO_VERSION } from '../src/version-guard.js';

const STUDIO_DIR = resolve('/tmp', '.studio-preflight-test');

beforeEach(async () => {
  await mkdir(STUDIO_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(STUDIO_DIR, { recursive: true, force: true });
});

const write = (name: string, content: string) =>
  writeFile(join(STUDIO_DIR, name), content, 'utf-8');

const byName = (checks: PreflightCheck[], name: string): PreflightCheck =>
  checks.find((c) => c.name === name)!;

describe('the script-interpreter check (STU-898)', () => {
  it('passes when nothing is declared', async () => {
    const check = byName(await collectChecks(STUDIO_DIR, {}), 'Script interpreters');
    expect(check.status).toBe('ok');
    expect(check.detail).toBe('none declared');
  });

  it('fails and names the runtime when a declared interpreter is not on disk', async () => {
    const check = byName(
      await collectChecks(STUDIO_DIR, { runtimes: { python: '/nope/not/a/python3' } }),
      'Script interpreters'
    );
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('python');
    expect(check.fix).toContain('/nope/not/a/python3');
  });

  it('fails on a bare command name that is not on PATH', async () => {
    const check = byName(
      await collectChecks(STUDIO_DIR, { runtimes: { python: 'definitely-not-a-real-binary' } }),
      'Script interpreters'
    );
    expect(check.status).toBe('fail');
  });

  it('passes on an interpreter that resolves', async () => {
    const check = byName(
      await collectChecks(STUDIO_DIR, { runtimes: { node: process.execPath } }),
      'Script interpreters'
    );
    expect(check.status).toBe('ok');
    expect(check.detail).toBe('node');
  });

  it('skips an entry whose ${VAR} resolved to nothing rather than failing on it', async () => {
    const check = byName(
      await collectChecks(STUDIO_DIR, { runtimes: { python: '' } }),
      'Script interpreters'
    );
    expect(check.status).toBe('ok');
    expect(check.detail).toBe('none declared');
  });
});

describe('unsetEnvRefs', () => {
  it('reports references with no value in the environment', () => {
    expect(unsetEnvRefs('apiKey: ${MISSING_KEY}', {})).toEqual(['MISSING_KEY']);
  });

  it('treats an empty value as unset', () => {
    expect(unsetEnvRefs('apiKey: ${KEY}', { KEY: '' })).toEqual(['KEY']);
  });

  it('ignores references that declare a fallback', () => {
    expect(unsetEnvRefs('url: ${BASE_URL:-http://localhost}', {})).toEqual([]);
  });

  it('deduplicates repeated references', () => {
    expect(unsetEnvRefs('a: ${K}\nb: ${K}', {})).toEqual(['K']);
  });

  it('returns nothing when every reference resolves', () => {
    expect(unsetEnvRefs('apiKey: ${KEY}', { KEY: 'sk-1' })).toEqual([]);
  });
});

describe('collectChecks', () => {
  it('passes every check on a project that declares nothing', async () => {
    const checks = await collectChecks(STUDIO_DIR, {});
    expect(checks.map((c) => c.name)).toEqual([
      'Studio version',
      'Config',
      'Required binaries',
      'Script interpreters',
      'Env vars',
      'Contracts',
    ]);
    expect(checks.every((c) => c.status === 'ok')).toBe(true);
  });

  it('fails the version check when the project requires a range Studio does not satisfy', async () => {
    const checks = await collectChecks(STUDIO_DIR, { studio_version: '>=99.0.0' });
    const check = byName(checks, 'Studio version');
    expect(check.status).toBe('fail');
    expect(check.detail).toContain(STUDIO_VERSION);
    expect(check.fix).toContain('requires Studio >=99.0.0');
  });

  it('fails the config check and names the missing keys', async () => {
    await write('config.example.yaml', 'providers:\n  anthropic:\n    apiKey: ""\n');
    await write('config.yaml', 'defaults:\n  provider: anthropic\n');

    const check = byName(await collectChecks(STUDIO_DIR, {}), 'Config');
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('providers.anthropic.apiKey');
    expect(check.fix).toContain('missing required key');
  });

  it('fails the binary check when a declared binary is absent from PATH', async () => {
    const check = byName(
      await collectChecks(STUDIO_DIR, { requires_binaries: ['definitely-not-a-real-binary'] }),
      'Required binaries'
    );
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('definitely-not-a-real-binary');
    expect(check.fix).toContain('not found in PATH');
  });

  it('lists declared binaries when they are all present', async () => {
    const check = byName(await collectChecks(STUDIO_DIR, { requires_binaries: ['node'] }), 'Required binaries');
    expect(check.status).toBe('ok');
    expect(check.detail).toBe('node');
  });

  it('warns — never fails — on an unset env var referenced by config.yaml', async () => {
    await write('config.yaml', 'providers:\n  anthropic:\n    apiKey: ${STUDIO_PREFLIGHT_UNSET_KEY}\n');

    const check = byName(await collectChecks(STUDIO_DIR, {}), 'Env vars');
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('STUDIO_PREFLIGHT_UNSET_KEY');
  });

  it('ignores env-var-looking text inside comments (STU-756)', async () => {
    await write(
      'config.yaml',
      '# Optional overrides: ANTHROPIC_API_KEY, ${STUDIO_SMART_PROVIDER}\n' +
        'defaults:\n' +
        '  model: ${STUDIO_PREFLIGHT_UNSET_KEY:-claude-haiku-4-5}\n'
    );

    const check = byName(await collectChecks(STUDIO_DIR, {}), 'Env vars');
    expect(check.status).toBe('ok');
    expect(check.detail).not.toContain('STUDIO_SMART_PROVIDER');
  });
});
