import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRunResult } from './runner.js';
import type { AgentContext } from './prompt-builder.js';

export interface ScriptExecutorConfig {
  scriptPath: string;
  runtime: 'python' | 'node' | 'shell';
  context: AgentContext;
  cwd?: string;
  timeoutMs?: number;
  /** Interpreters the project declared in `.studio/config.yaml`, keyed by runtime. */
  runtimes?: Record<string, string>;
}

const RUNTIME_COMMANDS: Record<string, string> = {
  python: 'python3',
  node: 'node',
  shell: 'sh',
};

/** `STUDIO_PYTHON_BIN`, `STUDIO_NODE_BIN`, `STUDIO_SHELL_BIN`. */
function overrideVar(runtime: string): string {
  return `STUDIO_${runtime.toUpperCase()}_BIN`;
}

/**
 * An activated virtualenv beats one sniffed at `cwd`: the operator chose it,
 * whereas a `.venv/` on disk may be a stale sibling of the one they meant.
 */
function resolvePythonVenv(env: Record<string, string>, cwd: string): string | null {
  if (env.VIRTUAL_ENV) return env.VIRTUAL_ENV;
  if (existsSync(join(cwd, 'venv'))) return join(cwd, 'venv');
  if (existsSync(join(cwd, '.venv'))) return join(cwd, '.venv');
  return null;
}

export function resolveRuntime(
  runtime: string,
  cwd: string,
  runtimes?: Record<string, string>,
): { command: string; env: Record<string, string> } {
  const env = { ...process.env } as Record<string, string>;

  // An unset `${VAR}` interpolates to '', which must fall through rather than
  // resolve to an empty command.
  const declared = runtimes?.[runtime];
  if (declared) return { command: declared, env };

  const override = env[overrideVar(runtime)];
  if (override) return { command: override, env };

  if (runtime === 'python') {
    const venvPath = resolvePythonVenv(env, cwd);
    if (venvPath) {
      const bin = join(venvPath, 'bin');
      env.VIRTUAL_ENV = venvPath;
      env.PATH = `${bin}:${env.PATH ?? ''}`;
      return { command: join(bin, 'python3'), env };
    }
  }

  return { command: RUNTIME_COMMANDS[runtime], env };
}

export async function runScript(config: ScriptExecutorConfig): Promise<AgentRunResult> {
  const startTime = Date.now();
  const cwd = config.cwd ?? process.cwd();
  const timeoutMs = config.timeoutMs ?? 30_000;
  const { command: cmd, env } = resolveRuntime(config.runtime, cwd, config.runtimes);
  const stdin = JSON.stringify(config.context);

  return new Promise((resolve) => {
    const proc = spawn(cmd, [config.scriptPath], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const settle = (result: Parameters<typeof resolve>[0]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 1000);
    }, timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    // A child that dies before reading its stdin (an ImportError, a syntax
    // error, a missing dependency, an OOM at import time) leaves the pipe
    // broken. Writing to it then emits an async 'error' (EPIPE) on the stdin
    // stream — and with no listener Node promotes that to an unhandled 'error'
    // event that crashes the whole CLI, burying the child's real stderr.
    // Swallow it: the child's exit code and captured stderr are the real
    // failure reason, and 'close' below carries them. (STU-568)
    proc.stdin.on('error', () => { /* child gone — reported via 'close' */ });

    try {
      proc.stdin.write(stdin);
      proc.stdin.end();
    } catch {
      // Synchronous throw on an already-destroyed stream — same story as the
      // 'error' handler above. Let 'close'/'error'/timeout settle the result.
    }

    proc.on('close', (exitCode) => {
      const duration_ms = Date.now() - startTime;

      if (timedOut) {
        settle({ output: null, tool_calls: [], tool_calls_count: 0, duration_ms, error: `Script timed out after ${timeoutMs}ms` });
        return;
      }

      if (exitCode !== 0) {
        settle({ output: null, tool_calls: [], tool_calls_count: 0, duration_ms, error: `Script exited with code ${exitCode}: ${stderr.trim()}` });
        return;
      }

      let output: unknown;
      try {
        output = JSON.parse(stdout.trim());
      } catch {
        settle({ output: null, tool_calls: [], tool_calls_count: 0, duration_ms, error: `Script output is not valid JSON: ${stdout.slice(0, 200)}` });
        return;
      }

      settle({ output, tool_calls: [], tool_calls_count: 0, duration_ms });
    });

    proc.on('error', (err) => {
      settle({ output: null, tool_calls: [], tool_calls_count: 0, duration_ms: Date.now() - startTime, error: `Script process error (interpreter: ${cmd}, override with ${overrideVar(config.runtime)}): ${err.message}` });
    });
  });
}
