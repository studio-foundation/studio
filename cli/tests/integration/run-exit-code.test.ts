/**
 * Integration test for `studio run` exit codes (STU-409).
 *
 * Strategy:
 *  - Single-stage pipeline whose contract requires a field the mock output omits.
 *  - Schema validation fails → RALPH exhausts max_attempts:1 → stage 'failed' →
 *    pipeline 'failed' → CLI must exit non-zero.
 *
 * Regression guard: `studio run` returning exit 0 on a failed pipeline is
 * unusable in CI. If run.ts's exit-code mapping regresses to always-0, this
 * test fails.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';

const CLI_BIN = resolve(import.meta.dirname, '../../dist/index.js');

function setupProject(dir: string): void {
  const studioDir = join(dir, '.studio');
  mkdirSync(join(studioDir, 'pipelines'), { recursive: true });
  mkdirSync(join(studioDir, 'agents'), { recursive: true });
  mkdirSync(join(studioDir, 'contracts'), { recursive: true });
  mkdirSync(join(studioDir, 'tools'), { recursive: true });

  writeFileSync(join(studioDir, 'config.yaml'), [
    'providers:',
    '  anthropic:',
    '    apiKey: test-key',
    'defaults:',
    '  provider: anthropic',
    '  model: claude-sonnet-4-20250514',
  ].join('\n') + '\n');

  writeFileSync(join(studioDir, 'agents', 'test-agent.agent.yaml'), [
    'name: test-agent',
    'provider: anthropic',
    'model: claude-sonnet-4-20250514',
    'tools: []',
  ].join('\n') + '\n');

  // Contract requires 'result' — the mock output below never provides it.
  writeFileSync(join(studioDir, 'contracts', 'needs-result.contract.yaml'), [
    'name: needs-result',
    'version: 1',
    'schema:',
    '  required_fields:',
    '    - result',
  ].join('\n') + '\n');

  writeFileSync(join(studioDir, 'pipelines', 'failing.pipeline.yaml'), [
    'name: failing',
    'version: 1',
    'stages:',
    '  - name: doomed',
    '    kind: work',
    '    agent: test-agent',
    '    contract: needs-result',
    '    ralph:',
    '      max_attempts: 1',
    '      retry_strategy: none',
    '    context:',
    '      include:',
    '        - input',
  ].join('\n') + '\n');

  // Mock output omits the required 'result' field → schema validation fails.
  writeFileSync(join(studioDir, 'mock.yaml'), [
    'stages:',
    '  doomed:',
    '    output:',
    '      something_else: true',
    '    tool_calls: []',
  ].join('\n') + '\n');
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      reject(new Error(`CLI process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('exit', (code) => { clearTimeout(timer); resolvePromise(code); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

describe('studio run exit codes', () => {
  let projectDir: string;

  afterEach(() => {
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  });

  it('exits non-zero when the pipeline fails', async () => {
    projectDir = `/tmp/.studio-run-fail-test-${Date.now()}`;
    setupProject(projectDir);

    const child = spawn(
      process.execPath,
      [CLI_BIN, 'run', 'failing', '--provider', 'mock', '--input', 'test', '--json'],
      { cwd: projectDir, stdio: ['ignore', 'ignore', 'ignore'] },
    );

    const code = await waitForExit(child, 15000);
    expect(code).not.toBe(0);
  }, 20_000);
});
