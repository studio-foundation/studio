/**
 * STU-1538: `runs.retention.max_age_days` is applied at the end of `studio run`.
 * Deleting the applyRunRetention call in run.ts, or applying it without the key,
 * fails one of these.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const CLI_BIN = resolve(import.meta.dirname, '../../dist/index.js');
const DAY = 24 * 60 * 60 * 1000;
const OLD_LOG = '2026-01-01T10h00m-demo-aaaaaaaa.jsonl';
const OLD_KEYMAP = 'aaaaaaaa-0000-aaaa-bbbb-cccccccccccc.keymap.json';

function setupProject(dir: string, retention: string[]): void {
  const studioDir = join(dir, '.studio');
  for (const sub of ['pipelines', 'agents', 'contracts', 'tools', 'runs/anonymization']) {
    mkdirSync(join(studioDir, sub), { recursive: true });
  }
  writeFileSync(join(studioDir, 'config.yaml'), [
    'providers:',
    '  anthropic:',
    '    apiKey: test-key',
    'defaults:',
    '  provider: anthropic',
    '  model: claude-sonnet-4-20250514',
    ...retention,
  ].join('\n') + '\n');
  writeFileSync(join(studioDir, 'agents', 'test-agent.agent.yaml'),
    'name: test-agent\nprovider: anthropic\nmodel: claude-sonnet-4-20250514\ntools: []\n');
  writeFileSync(join(studioDir, 'contracts', 'ok.contract.yaml'),
    'name: ok\nversion: 1\nschema:\n  required_fields:\n    - result\n');
  writeFileSync(join(studioDir, 'pipelines', 'p.pipeline.yaml'), [
    'name: p',
    'version: 1',
    'stages:',
    '  - name: only',
    '    kind: work',
    '    agent: test-agent',
    '    contract: ok',
    '    ralph:',
    '      max_attempts: 1',
    '      retry_strategy: none',
    '    context:',
    '      include:',
    '        - input',
  ].join('\n') + '\n');
  writeFileSync(join(studioDir, 'mock.yaml'),
    'stages:\n  ok:\n    output:\n      result: done\n    tool_calls: []\n');

  const log = join(studioDir, 'runs', OLD_LOG);
  writeFileSync(log, '{"event":"pipeline_complete","status":"success","run_id":"aaaaaaaa"}\n');
  const when = new Date(Date.now() - 60 * DAY);
  utimesSync(log, when, when);
  writeFileSync(join(studioDir, 'runs', 'anonymization', OLD_KEYMAP), '{}');
}

async function runPipeline(cwd: string): Promise<number | null> {
  const child = spawn(process.execPath, [CLI_BIN, 'run', 'p', '--provider', 'mock', '--input', 'x'],
    { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
  return new Promise((res, rej) => {
    child.on('exit', res);
    child.on('error', rej);
  });
}

describe('runs.retention at the end of studio run', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const oldRunExists = () => existsSync(join(dir, '.studio', 'runs', OLD_LOG));
  const oldKeymapExists = () => existsSync(join(dir, '.studio', 'runs', 'anonymization', OLD_KEYMAP));

  it('removes an old run and its keymap when max_age_days is set', async () => {
    dir = `/tmp/.studio-retention-old-${Date.now()}`;
    setupProject(dir, ['runs:', '  retention:', '    max_age_days: 30']);
    expect(await runPipeline(dir)).toBe(0);
    expect(oldRunExists()).toBe(false);
    expect(oldKeymapExists()).toBe(false);
  }, 30_000);

  it('keeps runs newer than max_age_days', async () => {
    dir = `/tmp/.studio-retention-recent-${Date.now()}`;
    setupProject(dir, ['runs:', '  retention:', '    max_age_days: 90']);
    expect(await runPipeline(dir)).toBe(0);
    expect(oldRunExists()).toBe(true);
    expect(oldKeymapExists()).toBe(true);
  }, 30_000);

  it('removes nothing when the key is absent', async () => {
    dir = `/tmp/.studio-retention-absent-${Date.now()}`;
    setupProject(dir, []);
    expect(await runPipeline(dir)).toBe(0);
    expect(oldRunExists()).toBe(true);
    expect(oldKeymapExists()).toBe(true);
  }, 30_000);
});
