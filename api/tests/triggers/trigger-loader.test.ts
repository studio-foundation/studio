import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { loadProjectTriggers } from '../../src/triggers/trigger-loader.js';

let dir: string;

beforeEach(() => {
  dir = resolve('/tmp', `.studio-trigger-loader-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env['TEST_TRIGGER_SECRET'];
});

function write(name: string, body: string): void {
  writeFileSync(resolve(dir, name), body, 'utf-8');
}

describe('loadProjectTriggers', () => {
  test('returns an empty array when the directory does not exist', async () => {
    expect(await loadProjectTriggers(resolve(dir, 'nope'))).toEqual([]);
  });

  test('loads only .trigger.yaml files, sorted by filename', async () => {
    write('b.trigger.yaml', 'name: beta\nversion: 1\npipeline: p\nwebhook: {}\n');
    write('a.trigger.yaml', 'name: alpha\nversion: 1\npipeline: p\nwebhook: {}\n');
    write('notes.md', 'ignored');

    expect((await loadProjectTriggers(dir)).map(t => t.name)).toEqual(['alpha', 'beta']);
  });

  test('resolves ${VAR} so the HMAC secret comes from the environment', async () => {
    process.env['TEST_TRIGGER_SECRET'] = 'from-env';
    write('a.trigger.yaml',
      'name: a\nversion: 1\npipeline: p\nwebhook:\n  hmac:\n    header: x-sig\n    secret: ${TEST_TRIGGER_SECRET}\n');

    const [trigger] = await loadProjectTriggers(dir);
    expect(trigger.webhook.hmac?.secret).toBe('from-env');
  });

  test('refuses an hmac block whose secret resolved to nothing', async () => {
    write('a.trigger.yaml',
      'name: a\nversion: 1\npipeline: p\nwebhook:\n  hmac:\n    header: x-sig\n    secret: ${TEST_TRIGGER_SECRET}\n');

    await expect(loadProjectTriggers(dir)).rejects.toThrow(/secret resolved to nothing/);
  });

  test('accepts a trigger with no webhook block', async () => {
    write('a.trigger.yaml', 'name: a\nversion: 1\npipeline: p\n');
    const [trigger] = await loadProjectTriggers(dir);
    expect(trigger.webhook).toBeUndefined();
  });

  test('rejects a trigger with no name', async () => {
    write('a.trigger.yaml', 'version: 1\npipeline: p\nwebhook: {}\n');
    await expect(loadProjectTriggers(dir)).rejects.toThrow(/missing 'name'/);
  });

  test('rejects a trigger with no pipeline', async () => {
    write('a.trigger.yaml', 'name: a\nversion: 1\nwebhook: {}\n');
    await expect(loadProjectTriggers(dir)).rejects.toThrow(/missing 'pipeline'/);
  });
});
