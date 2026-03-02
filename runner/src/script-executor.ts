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
}

const RUNTIME_COMMANDS: Record<string, string> = {
  python: 'python3',
  node: 'node',
  shell: 'sh',
};

function buildEnv(runtime: string, cwd: string): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;

  if (runtime === 'python') {
    const venvPath = existsSync(join(cwd, 'venv'))
      ? join(cwd, 'venv')
      : existsSync(join(cwd, '.venv'))
        ? join(cwd, '.venv')
        : null;

    if (venvPath) {
      env.VIRTUAL_ENV = venvPath;
      env.PATH = `${join(venvPath, 'bin')}:${env.PATH ?? ''}`;
    }
  }

  return env;
}

export async function runScript(config: ScriptExecutorConfig): Promise<AgentRunResult> {
  const startTime = Date.now();
  const cwd = config.cwd ?? process.cwd();
  const timeoutMs = config.timeoutMs ?? 30_000;
  const cmd = RUNTIME_COMMANDS[config.runtime];
  const env = buildEnv(config.runtime, cwd);
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

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 1000);
    }, timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.stdin.write(stdin);
    proc.stdin.end();

    proc.on('close', (exitCode) => {
      clearTimeout(timer);
      const duration_ms = Date.now() - startTime;

      if (timedOut) {
        resolve({ output: null, tool_calls: [], tool_calls_count: 0, duration_ms, error: `Script timed out after ${timeoutMs}ms` });
        return;
      }

      if (exitCode !== 0) {
        resolve({ output: null, tool_calls: [], tool_calls_count: 0, duration_ms, error: `Script exited with code ${exitCode}: ${stderr.trim()}` });
        return;
      }

      let output: unknown;
      try {
        output = JSON.parse(stdout.trim());
      } catch {
        resolve({ output: null, tool_calls: [], tool_calls_count: 0, duration_ms, error: `Script output is not valid JSON: ${stdout.slice(0, 200)}` });
        return;
      }

      resolve({ output, tool_calls: [], tool_calls_count: 0, duration_ms });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ output: null, tool_calls: [], tool_calls_count: 0, duration_ms: Date.now() - startTime, error: `Script process error: ${err.message}` });
    });
  });
}
