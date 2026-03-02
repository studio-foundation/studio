import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';

// Mock child_process and fs before importing the module under test
vi.mock('node:child_process');
vi.mock('node:fs');

import { runScript } from '../script-executor.js';
import type { AgentContext } from '../prompt-builder.js';

function makeContext(overrides?: Partial<AgentContext>): AgentContext {
  return {
    input: 'test input',
    ...overrides,
  } as AgentContext;
}

function makeSpawnMock(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  errorEvent?: Error;
}) {
  const proc = new EventEmitter() as ReturnType<typeof cp.spawn>;
  (proc as any).stdout = new EventEmitter();
  (proc as any).stderr = new EventEmitter();
  (proc as any).stdin = { write: vi.fn(), end: vi.fn() };
  (proc as any).kill = vi.fn();

  vi.mocked(cp.spawn).mockReturnValue(proc as any);

  // Simulate async process lifecycle
  setTimeout(() => {
    if (opts.errorEvent) {
      proc.emit('error', opts.errorEvent);
      return;
    }
    if (opts.stdout) (proc as any).stdout.emit('data', Buffer.from(opts.stdout));
    if (opts.stderr) (proc as any).stderr.emit('data', Buffer.from(opts.stderr));
    proc.emit('close', opts.exitCode ?? 0);
  }, 10);

  return proc;
}

beforeEach(() => {
  vi.mocked(fs.existsSync).mockReturnValue(false);
  vi.clearAllMocks();
});

describe('runScript', () => {
  it('parses stdout JSON and returns output on exit 0', async () => {
    const output = { result: 'ok', count: 42 };
    makeSpawnMock({ stdout: JSON.stringify(output), exitCode: 0 });

    const result = await runScript({
      scriptPath: 'scripts/parse.py',
      runtime: 'python',
      context: makeContext(),
    });

    expect(result.output).toEqual(output);
    expect(result.tool_calls).toEqual([]);
    expect(result.tool_calls_count).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('sets error when script exits with non-zero code', async () => {
    makeSpawnMock({ stdout: '', stderr: 'FileNotFoundError', exitCode: 1 });

    const result = await runScript({
      scriptPath: 'scripts/parse.py',
      runtime: 'python',
      context: makeContext(),
    });

    expect(result.output).toBeNull();
    expect(result.error).toMatch(/exited with code 1/);
    expect(result.error).toMatch(/FileNotFoundError/);
  });

  it('sets error when stdout is not valid JSON', async () => {
    makeSpawnMock({ stdout: 'not json at all', exitCode: 0 });

    const result = await runScript({
      scriptPath: 'scripts/parse.py',
      runtime: 'python',
      context: makeContext(),
    });

    expect(result.output).toBeNull();
    expect(result.error).toMatch(/not valid JSON/);
    expect(result.error).toMatch(/not json at all/);
  });

  it('sets error on process spawn error', async () => {
    const proc = new EventEmitter() as ReturnType<typeof cp.spawn>;
    (proc as any).stdout = new EventEmitter();
    (proc as any).stderr = new EventEmitter();
    (proc as any).stdin = { write: vi.fn(), end: vi.fn() };
    vi.mocked(cp.spawn).mockReturnValue(proc as any);
    setTimeout(() => proc.emit('error', new Error('ENOENT: python3 not found')), 10);

    const result = await runScript({
      scriptPath: 'scripts/parse.py',
      runtime: 'python',
      context: makeContext(),
    });

    expect(result.error).toMatch(/process error/);
    expect(result.error).toMatch(/ENOENT/);
  });

  it('uses python3 command for python runtime', async () => {
    makeSpawnMock({ stdout: '{}', exitCode: 0 });

    await runScript({ scriptPath: 'scripts/parse.py', runtime: 'python', context: makeContext() });

    expect(vi.mocked(cp.spawn)).toHaveBeenCalledWith(
      'python3',
      ['scripts/parse.py'],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    );
  });

  it('uses node command for node runtime', async () => {
    makeSpawnMock({ stdout: '{}', exitCode: 0 });

    await runScript({ scriptPath: 'scripts/parse.js', runtime: 'node', context: makeContext() });

    expect(vi.mocked(cp.spawn)).toHaveBeenCalledWith('node', ['scripts/parse.js'], expect.anything());
  });

  it('uses sh command for shell runtime', async () => {
    makeSpawnMock({ stdout: '{}', exitCode: 0 });

    await runScript({ scriptPath: 'scripts/run.sh', runtime: 'shell', context: makeContext() });

    expect(vi.mocked(cp.spawn)).toHaveBeenCalledWith('sh', ['scripts/run.sh'], expect.anything());
  });

  it('activates venv when venv/ directory exists', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => String(p).endsWith('venv'));
    makeSpawnMock({ stdout: '{}', exitCode: 0 });

    await runScript({
      scriptPath: 'scripts/parse.py',
      runtime: 'python',
      context: makeContext(),
      cwd: '/project',
    });

    const spawnCall = vi.mocked(cp.spawn).mock.calls[0];
    const spawnEnv = (spawnCall[2] as any).env;
    expect(spawnEnv.VIRTUAL_ENV).toBe('/project/venv');
    expect(spawnEnv.PATH).toContain('/project/venv/bin');
  });

  it('writes context JSON to stdin', async () => {
    const stdinMock = { write: vi.fn(), end: vi.fn() };
    const proc = new EventEmitter() as ReturnType<typeof cp.spawn>;
    (proc as any).stdout = new EventEmitter();
    (proc as any).stderr = new EventEmitter();
    (proc as any).stdin = stdinMock;
    vi.mocked(cp.spawn).mockReturnValue(proc as any);
    setTimeout(() => {
      (proc as any).stdout.emit('data', Buffer.from('{"ok":true}'));
      proc.emit('close', 0);
    }, 10);

    const ctx = makeContext({ additional_context: 'hello world' });
    await runScript({ scriptPath: 'scripts/parse.py', runtime: 'python', context: ctx });

    expect(stdinMock.write).toHaveBeenCalledWith(JSON.stringify(ctx));
    expect(stdinMock.end).toHaveBeenCalled();
  });
});
