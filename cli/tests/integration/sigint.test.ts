/**
 * Integration test for SIGINT handling in the CLI.
 *
 * Strategy:
 *  - 2-stage pipeline where stage 1 calls `sleep 60` via the shell tool.
 *  - After startup, send SIGINT to the process GROUP (kills node + sleep together).
 *  - SIGINT arrives during sleep: shell tool error → MockProvider returns valid output →
 *    stage 1 succeeds → engine checks signal.aborted before stage 2 → 'cancelled'.
 *  - CLI detects status='cancelled' → process.exit(130).
 *
 * Regression guard: if the SIGINT handler or AbortController wiring is removed, the
 * process would exit with 0 or 1 instead of 130.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  cpSync,
  existsSync,
} from 'node:fs';
import { resolve, join } from 'node:path';

const CLI_BIN = resolve(import.meta.dirname, '../../dist/index.js');

// Both budgets exist to catch a hung CLI, not to measure speed: a loaded machine
// may be an order of magnitude slower than an idle one without anything being wrong.
const STARTUP_TIMEOUT_MS = 20_000;
const EXIT_TIMEOUT_MS = 20_000;

const SHELL_TOOL_SRC = resolve(
  import.meta.dirname,
  '../../../runner/templates/tools/shell.tool.yaml',
);

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
    'tools:',
    '  - shell-run_command',
  ].join('\n') + '\n');

  // Two contracts — one per stage
  writeFileSync(join(studioDir, 'contracts', 'slow-stage.contract.yaml'), [
    'name: slow-stage',
    'version: 1',
    'schema:',
    '  required_fields:',
    '    - done',
  ].join('\n') + '\n');

  writeFileSync(join(studioDir, 'contracts', 'fast-stage.contract.yaml'), [
    'name: fast-stage',
    'version: 1',
    'schema:',
    '  required_fields:',
    '    - done',
  ].join('\n') + '\n');

  // Two-stage pipeline: slow (sleep 60 via tool) then fast (instant)
  writeFileSync(join(studioDir, 'pipelines', 'two-stage.pipeline.yaml'), [
    'name: two-stage',
    'version: 2',
    'stages:',
    '  - name: slow-stage',
    '    kind: work',
    '    agent: test-agent',
    '    contract: slow-stage',
    '    ralph:',
    '      max_attempts: 1',
    '      retry_strategy: none',
    '    context:',
    '      include:',
    '        - input',
    '  - name: fast-stage',
    '    kind: work',
    '    agent: test-agent',
    '    contract: fast-stage',
    '    ralph:',
    '      max_attempts: 1',
    '      retry_strategy: none',
    '    context:',
    '      include:',
    '        - input',
  ].join('\n') + '\n');

  // Mock: slow-stage calls sleep 60, fast-stage is instant (never reached)
  writeFileSync(join(studioDir, 'mock.yaml'), [
    'stages:',
    '  slow-stage:',
    '    output:',
    '      done: true',
    '    tool_calls:',
    '      - name: shell-run_command',
    '        arguments:',
    '          command: "sleep 60"',
    '  fast-stage:',
    '    output:',
    '      done: true',
    '    tool_calls: []',
  ].join('\n') + '\n');

  if (existsSync(SHELL_TOOL_SRC)) {
    cpSync(SHELL_TOOL_SRC, join(studioDir, 'tools', 'shell.tool.yaml'));
  }
}

function spawnCli(cwd: string): ChildProcess {
  return spawn(
    process.execPath,
    [CLI_BIN, 'run', 'two-stage', '--provider', 'mock', '--input', 'test'],
    {
      cwd,
      // New process group so the parent test runner is NOT affected by SIGINT
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

/**
 * Resolve once `marker` appears on the child's stdout. Waiting on what the CLI
 * actually printed — rather than on a constant chosen from one machine's timings —
 * is what makes this test survive vitest's parallel pool on a loaded machine.
 */
function waitForStdout(child: ChildProcess, marker: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let seen = '';

    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
    };

    const timer = setTimeout(() => {
      cleanup();
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      reject(new Error(`CLI did not print "${marker}" within ${timeoutMs}ms. stdout: ${seen}`));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      seen += chunk.toString();
      if (seen.includes(marker)) {
        cleanup();
        resolve();
      }
    };

    const onExit = () => {
      cleanup();
      reject(new Error(`CLI exited before printing "${marker}". stdout: ${seen}`));
    };

    child.stdout?.on('data', onData);
    child.on('exit', onExit);
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      reject(new Error(`CLI process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('CLI SIGINT handling', () => {
  let projectDir: string;

  afterEach(() => {
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  });

  it('exits with code 130 on SIGINT during a run', async () => {
    projectDir = `/tmp/.studio-sigint-test-${Date.now()}`;
    setupProject(projectDir);

    const child = spawnCli(projectDir);

    // The CLI registers its SIGINT handler immediately before engine.run(), and
    // this line is printed from inside that call — so the marker is proof the
    // handler is installed.
    await waitForStdout(child, 'Running pipeline: two-stage', STARTUP_TIMEOUT_MS);

    // The marker fires just before the first tool call is dispatched; let the
    // `sleep 60` grandchild exist so the group SIGINT below reaches it too.
    await new Promise((r) => setTimeout(r, 500));

    // Send SIGINT to the entire process group (negative PID = PGID when detached: true).
    // This kills both node and the sleep subprocess. Node's SIGINT handler fires,
    // aborts the engine, and the pipeline returns 'cancelled' → process.exit(130).
    try {
      process.kill(-(child.pid!), 'SIGINT');
    } catch {
      // Process already exited — captured below
    }

    const { code } = await waitForExit(child, EXIT_TIMEOUT_MS);

    expect(code).toBe(130);
  }, 60_000);
});
