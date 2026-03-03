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

    // Wait long enough for:
    //   • Node.js startup + ESM module loading (~500ms)
    //   • runCommand async setup: loadConfig, createRunStore, loadPipelineByName,
    //     resolveRepoPath, loadProjectTools, loadPlugins, engine init (~500ms)
    //   • SIGINT handler registration + engine.run() start (~1ms)
    //   • sleep 60 tool call to begin executing (a few ms)
    // 2500ms is 2.5× the measured worst-case setup time → reliable without being slow.
    await new Promise((r) => setTimeout(r, 2500));

    // Send SIGINT to the entire process group (negative PID = PGID when detached: true).
    // This kills both node and the sleep subprocess. Node's SIGINT handler fires,
    // aborts the engine, and the pipeline returns 'cancelled' → process.exit(130).
    try {
      process.kill(-(child.pid!), 'SIGINT');
    } catch {
      // Process already exited — captured below
    }

    const { code } = await waitForExit(child, 8000);

    expect(code).toBe(130);
  }, 15_000);
});
