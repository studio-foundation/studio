import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveRuntime } from '../src/script-executor.js';

const TMP = join('/tmp', '.studio-resolve-runtime-test-' + Date.now());

// Resolution reads process.env directly, so every test states the whole
// environment it means rather than inheriting the developer's.
const SAVED = { ...process.env };
function env(vars: Record<string, string | undefined>): void {
  for (const key of ['STUDIO_PYTHON_BIN', 'STUDIO_NODE_BIN', 'VIRTUAL_ENV']) delete process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value !== undefined) process.env[key] = value;
  }
}

describe('resolveRuntime', () => {
  beforeAll(async () => {
    await mkdir(join(TMP, 'with-venv', '.venv', 'bin'), { recursive: true });
    await mkdir(join(TMP, 'bare'), { recursive: true });
  });
  afterAll(async () => { await rm(TMP, { recursive: true, force: true }); });

  beforeEach(() => env({}));
  afterEach(() => { process.env = { ...SAVED }; });

  describe('the declared interpreter (STU-898)', () => {
    it('wins over STUDIO_<RUNTIME>_BIN', () => {
      env({ STUDIO_PYTHON_BIN: '/from/env/python3' });
      const { command } = resolveRuntime('python', join(TMP, 'bare'), {
        python: '/from/config/python3',
      });
      expect(command).toBe('/from/config/python3');
    });

    it('wins over an activated VIRTUAL_ENV', () => {
      env({ VIRTUAL_ENV: '/activated/venv' });
      const { command } = resolveRuntime('python', join(TMP, 'bare'), {
        python: '/from/config/python3',
      });
      expect(command).toBe('/from/config/python3');
    });

    it('wins over a .venv/ sitting at cwd', () => {
      const { command } = resolveRuntime('python', join(TMP, 'with-venv'), {
        python: '/from/config/python3',
      });
      expect(command).toBe('/from/config/python3');
    });

    it('falls through when an unset ${VAR} interpolated to an empty string', () => {
      env({ STUDIO_PYTHON_BIN: '/from/env/python3' });
      const { command } = resolveRuntime('python', join(TMP, 'bare'), { python: '' });
      expect(command).toBe('/from/env/python3');
    });

    it('only claims the runtime it names', () => {
      const { command } = resolveRuntime('node', join(TMP, 'bare'), {
        python: '/from/config/python3',
      });
      expect(command).toBe('node');
    });
  });

  describe('the STU-866 order, unchanged when nothing is declared', () => {
    it('takes STUDIO_<RUNTIME>_BIN first', () => {
      env({ STUDIO_PYTHON_BIN: '/from/env/python3', VIRTUAL_ENV: '/activated/venv' });
      expect(resolveRuntime('python', join(TMP, 'with-venv')).command).toBe('/from/env/python3');
    });

    it('then an activated VIRTUAL_ENV, over a .venv/ at cwd', () => {
      env({ VIRTUAL_ENV: '/activated/venv' });
      const { command, env: spawnEnv } = resolveRuntime('python', join(TMP, 'with-venv'));
      expect(command).toBe('/activated/venv/bin/python3');
      expect(spawnEnv.VIRTUAL_ENV).toBe('/activated/venv');
    });

    it('then a .venv/ at cwd, putting its bin on PATH', () => {
      const { command, env: spawnEnv } = resolveRuntime('python', join(TMP, 'with-venv'));
      expect(command).toBe(join(TMP, 'with-venv', '.venv', 'bin', 'python3'));
      expect(spawnEnv.PATH?.startsWith(join(TMP, 'with-venv', '.venv', 'bin'))).toBe(true);
    });

    it('then the runtime default', () => {
      expect(resolveRuntime('python', join(TMP, 'bare')).command).toBe('python3');
      expect(resolveRuntime('node', join(TMP, 'bare')).command).toBe('node');
      expect(resolveRuntime('shell', join(TMP, 'bare')).command).toBe('sh');
    });

    it('never applies venv resolution to a non-python runtime', () => {
      env({ VIRTUAL_ENV: '/activated/venv' });
      expect(resolveRuntime('node', join(TMP, 'with-venv')).command).toBe('node');
    });
  });
});
