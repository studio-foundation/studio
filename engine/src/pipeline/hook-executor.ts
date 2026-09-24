// Hook executor — runs shell commands at lifecycle points within a stage
// Mirrors startup-executor.ts but with on_failure semantics and tool arg templates

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { StageHookDef, ToolHookDef } from '@studio-foundation/contracts';

const execAsync = promisify(exec);
const HOOK_TIMEOUT_MS = 30_000;

export interface HookResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Renders {{tool.argName}} and {{output.field}} placeholders.
 * Arrays in outputContext are space-joined for CLI argument passing.
 * Unknown keys → empty string.
 *
 * Note: values are substituted verbatim into the command string, so a value
 * the agent controls (a shell command, a path) runs as part of the hook's own
 * command line. Tool hooks should read `$STUDIO_TOOL_ARG_<argName>` instead
 * (see toolArgEnv); {{tool.argName}} remains for trusted values only.
 */
export function renderHookCommand(
  command: string,
  toolArgs: Record<string, unknown>,
  outputContext: Record<string, unknown> = {}
): string {
  return command
    .replace(
      /\{\{tool\.(\w+)\}\}/g,
      (_, key: string) => (toolArgs[key] !== undefined ? String(toolArgs[key]) : '')
    )
    .replace(/\{\{output\.(\w+)\}\}/g, (_, key: string) => {
      const val = outputContext[key];
      if (val === undefined) return '';
      if (Array.isArray(val)) return val.join(' ');
      return String(val);
    });
}

/**
 * Tool arguments as STUDIO_TOOL_ARG_<name> environment variables, the channel
 * a hook can read without the value being parsed as shell.
 */
export function toolArgEnv(toolArgs: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(toolArgs)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [
        `STUDIO_TOOL_ARG_${key}`,
        typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value),
      ])
  );
}

/**
 * Run a stage-level hook command (on_stage_start, on_stage_complete).
 * outputContext provides {{output.<field>}} substitution values.
 * on_stage_start hooks omit outputContext (no output available before the stage runs).
 */
export async function runStageHook(
  hook: StageHookDef,
  cwd: string,
  outputContext: Record<string, unknown> = {},
  env: Record<string, string> = {}
): Promise<HookResult> {
  const command = renderHookCommand(hook.command, {}, outputContext);
  return execHook(command, cwd, env);
}

/**
 * Run a tool-level hook command (pre_tool_use, post_tool_use).
 * The arguments reach the command as $STUDIO_TOOL_ARG_<argName> (safe for agent-controlled
 * values) and, for trusted values only, as {{tool.argName}} spliced into the text.
 */
export async function runToolHook(
  hook: ToolHookDef,
  toolArgs: Record<string, unknown>,
  cwd: string,
  env: Record<string, string> = {}
): Promise<HookResult> {
  const command = renderHookCommand(hook.command, toolArgs);
  return execHook(command, cwd, { ...env, ...toolArgEnv(toolArgs) });
}

export interface PreToolDecision {
  blocked: boolean;
  error?: string;
}

/**
 * Run the pre_tool_use hooks matching one tool call. Fail-fast: the first blocking failure
 * stops the call and the rest are skipped. `on_failure: warn` (the default) logs and lets the
 * call through. `reject` blocks it. `ask` puts the message to the human instead: yes lets the
 * call through to the next hook, no blocks it, and no one to ask (askHuman absent, a
 * non-interactive run) blocks it like a plain failure.
 */
export async function runPreToolHooks(
  hooks: ToolHookDef[],
  event: { params: Record<string, unknown> },
  cwd: string,
  opts: {
    env?: Record<string, string>;
    askHuman?: (question: string) => Promise<boolean>;
    onAsk?: (ask: { question: string; answer: 'yes' | 'no' | 'unavailable' }) => void;
  } = {}
): Promise<PreToolDecision> {
  for (const hook of hooks) {
    const hookResult = await runToolHook(hook, event.params, cwd, opts.env);
    if (hookResult.success) continue;
    const message = hookResult.stderr || hookResult.stdout;
    const onFailure = hook.on_failure ?? 'warn';
    if (onFailure === 'warn') {
      console.warn(`[pre_tool_use] hook failed for "${hook.matcher}": ${message}`);
      continue;
    }
    if (onFailure !== 'ask') return { blocked: true, error: `Pre-hook failed: ${message}` };
    const yes = opts.askHuman ? await opts.askHuman(message) : undefined;
    opts.onAsk?.({ question: message, answer: yes === undefined ? 'unavailable' : yes ? 'yes' : 'no' });
    if (yes) continue;
    return { blocked: true, error: `Pre-hook failed: ${yes === undefined ? message : `denied by the human: ${message}`}` };
  }
  return { blocked: false };
}

async function execHook(
  command: string,
  cwd: string,
  env: Record<string, string> = {}
): Promise<HookResult> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      env: { ...process.env, ...env },
      timeout: HOOK_TIMEOUT_MS,
      maxBuffer: 1024 * 1024 * 10,
    });
    return { success: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    return {
      success: false,
      stdout: e.stdout?.trim() ?? '',
      stderr: e.stderr?.trim() ?? String(err),
    };
  }
}
