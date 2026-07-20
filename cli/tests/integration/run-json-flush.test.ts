/**
 * Integration test for `studio run --json` stdout integrity (STU-594).
 *
 * `console.log` to a pipe is asynchronous; a `process.exit()` right after it
 * terminates before the flush and cuts stdout at the pipe buffer, so a large
 * `--json` payload never decoded for the caller (STU-533/561/564). The fix
 * drains stdout/stderr before exiting.
 *
 * The race only bites when the reader is not draining the pipe: the child fills
 * the kernel pipe buffer, the pre-fix `process.exit()` drops Node's internal
 * buffer, and the reader that starts later sees a truncated head. This test
 * reproduces that by stalling the read, then asserting the full payload decodes.
 * An eager reader would hide the bug (both builds pass), so the stall is
 * load-bearing — remove it and this stops guarding anything.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';

const CLI_BIN = resolve(import.meta.dirname, '../../dist/index.js');

// Far past any kernel pipe buffer (8 KiB seen in the field, 64 KiB here).
const BIG_LEN = 2_000_000;
const BIG_VALUE = 'x'.repeat(BIG_LEN);
const STALL_MS = 1500;

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

  writeFileSync(join(studioDir, 'contracts', 'needs-blob.contract.yaml'), [
    'name: needs-blob',
    'version: 1',
    'schema:',
    '  required_fields:',
    '    - blob',
  ].join('\n') + '\n');

  writeFileSync(join(studioDir, 'pipelines', 'big.pipeline.yaml'), [
    'name: big',
    'version: 1',
    'stages:',
    '  - name: emit',
    '    kind: work',
    '    agent: test-agent',
    '    contract: needs-blob',
    '    ralph:',
    '      max_attempts: 1',
    '      retry_strategy: none',
    '    context:',
    '      include:',
    '        - input',
  ].join('\n') + '\n');

  // MockProvider keys stages by contract name, not stage name.
  writeFileSync(join(studioDir, 'mock.yaml'), [
    'stages:',
    '  needs-blob:',
    '    output:',
    `      blob: "${BIG_VALUE}"`,
    '    tool_calls: []',
  ].join('\n') + '\n');
}

/** Read the child's stdout only after `stallMs`, so the pipe fills first. */
function runStalled(
  child: ChildProcess,
  stallMs: number,
  timeoutMs: number
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolvePromise, reject) => {
    const chunks: string[] = [];
    let code: number | null = null;
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      reject(new Error(`CLI process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    // A piped stdout stays paused until a 'data' listener is attached; delaying
    // that keeps the kernel pipe buffer full while the child tries to exit.
    setTimeout(() => {
      child.stdout?.on('data', (c) => chunks.push(c.toString()));
      child.stdout?.resume();
    }, stallMs);
    child.on('exit', (c) => { code = c; });
    child.on('close', () => { clearTimeout(timer); resolvePromise({ code, stdout: chunks.join('') }); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

describe('studio run --json stdout integrity', () => {
  let projectDir: string;

  afterEach(() => {
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  });

  it('emits a complete, parseable payload to a stalled pipe reader', async () => {
    projectDir = `/tmp/.studio-run-json-flush-test-${Date.now()}`;
    setupProject(projectDir);

    const child = spawn(
      process.execPath,
      [CLI_BIN, 'run', 'big', '--provider', 'mock', '--input', 'test', '--json'],
      { cwd: projectDir, stdio: ['ignore', 'pipe', 'ignore'] },
    );

    const { code, stdout } = await runStalled(child, STALL_MS, 20000);

    expect(code).toBe(0);
    expect(Buffer.byteLength(stdout, 'utf-8')).toBeGreaterThan(BIG_LEN);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe('success');
    const emitted = parsed.stages.find((s: { stage_name: string }) => s.stage_name === 'emit');
    expect(emitted?.output?.blob).toBe(BIG_VALUE);
  }, 25_000);
});
