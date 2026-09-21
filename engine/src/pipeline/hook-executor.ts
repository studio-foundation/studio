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
  outputContext: Record<string, unknown> = {}
): Promise<HookResult> {
  const command = renderHookCommand(hook.command, {}, outputContext);
  return execHook(command, cwd);
}

/**
 * Run a tool-level hook command (pre_tool_use, post_tool_use).
 * The arguments reach the command as $STUDIO_TOOL_ARG_<argName> (safe for agent-controlled
 * values) and, for trusted values only, as {{tool.argName}} spliced into the text.
 */
export async function runToolHook(
  hook: ToolHookDef,
  toolArgs: Record<string, unknown>,
  cwd: string
): Promise<HookResult> {
  const command = renderHookCommand(hook.command, toolArgs);
  return execHook(command, cwd, toolArgEnv(toolArgs));
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
