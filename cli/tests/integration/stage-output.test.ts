import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const CLI_BIN = resolve(import.meta.dirname, '../../dist/index.js');
const BIG_LEN = 200_000;

function setupProject(dir: string, blob: string, second: string): void {
  const studioDir = join(dir, '.studio');
  for (const d of ['pipelines', 'agents', 'contracts', 'tools']) {
    mkdirSync(join(studioDir, d), { recursive: true });
  }
  writeFileSync(join(studioDir, 'config.yaml'), [
    'providers:', '  anthropic:', '    apiKey: test-key',
    'defaults:', '  provider: anthropic', '  model: claude-sonnet-4-20250514',
  ].join('\n') + '\n');
  writeFileSync(join(studioDir, 'agents', 'a.agent.yaml'), [
    'name: a', 'provider: anthropic', 'model: claude-sonnet-4-20250514', 'tools: []',
  ].join('\n') + '\n');
  for (const c of ['first-out', 'second-out']) {
    writeFileSync(join(studioDir, 'contracts', `${c}.contract.yaml`), [
      `name: ${c}`, 'version: 1', 'schema:', '  required_fields:', '    - blob',
    ].join('\n') + '\n');
  }
  const stage = (name: string, contract: string) => [
    `  - name: ${name}`, '    kind: work', '    agent: a', `    contract: ${contract}`,
    '    ralph:', '      max_attempts: 1', '      retry_strategy: none',
    '    context:', '      include:', '        - input',
  ];
  writeFileSync(join(studioDir, 'pipelines', 'two.pipeline.yaml'), [
    'name: two', 'version: 1', 'stages:',
    ...stage('first', 'first-out'), ...stage('second', 'second-out'),
  ].join('\n') + '\n');
  writeFileSync(join(studioDir, 'mock.yaml'), [
    'stages:',
    '  first-out:', '    output:', `      blob: "${blob}"`, '    tool_calls: []',
    '  second-out:', '    output:', `      blob: "${second}"`, '    tool_calls: []',
  ].join('\n') + '\n');
}

describe('studio run --output-file / --stage-output, studio runs show', () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  const mk = (tag: string, blob: string, second: string): string => {
    const dir = `/tmp/.studio-stage-output-test-${tag}-${Date.now()}`;
    dirs.push(dir);
    setupProject(dir, blob, second);
    return dir;
  };
  const cli = (cwd: string, args: string[]) =>
    spawnSync(process.execPath, [CLI_BIN, ...args], { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });

  it('writes the whole last-stage and named-stage outputs, past 64 KiB', () => {
    const big = 'x'.repeat(BIG_LEN);
    const dir = mk('big', big, 'last');
    const res = cli(dir, [
      'run', 'two', '--provider', 'mock', '--input', 't', '--json',
      '--output-file', join(dir, 'out/last.json'),
      '--stage-output', `first=${join(dir, 'out/first.json')}`,
    ]);
    expect(res.status).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'out/last.json'), 'utf-8'))).toEqual({ blob: 'last' });
    const first = readFileSync(join(dir, 'out/first.json'), 'utf-8');
    expect(first.length).toBeGreaterThan(BIG_LEN);
    expect(JSON.parse(first).blob).toBe(big);

    const runId = JSON.parse(res.stdout).id as string;
    const shown = cli(dir, ['runs', 'show', runId, '--stage', 'first', '--json']);
    expect(shown.status).toBe(0);
    expect(JSON.parse(shown.stdout).blob).toBe(big);
  }, 30_000);

  it('keeps concurrent runs apart', async () => {
    const a = mk('a', 'AAA', 'A-last');
    const b = mk('b', 'BBB', 'B-last');
    const run = (dir: string) =>
      new Promise<number | null>((done) => {
        
        const c = spawn(process.execPath, [CLI_BIN, 'run', 'two', '--provider', 'mock', '--input', 't', '--output-file', join(dir, 'o.json')], { cwd: dir, stdio: 'ignore' });
        c.on('close', done);
      });
    await Promise.all([run(a), run(b)]);
    expect(JSON.parse(readFileSync(join(a, 'o.json'), 'utf-8')).blob).toBe('A-last');
    expect(JSON.parse(readFileSync(join(b, 'o.json'), 'utf-8')).blob).toBe('B-last');
  }, 30_000);

  it('rejects a malformed --stage-output before running and warns on an unknown stage', () => {
    const dir = mk('bad', 'x', 'y');
    const bad = cli(dir, ['run', 'two', '--provider', 'mock', '--input', 't', '--stage-output', 'nopath']);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('expected <stage>=<path>');
    const unknown = cli(dir, ['run', 'two', '--provider', 'mock', '--input', 't', '--stage-output', `ghost=${join(dir, 'g.json')}`]);
    expect(unknown.status).toBe(0);
    expect(existsSync(join(dir, 'g.json'))).toBe(false);
    expect(unknown.stderr).toContain("No output to write for stage 'ghost'");
  }, 30_000);
});
