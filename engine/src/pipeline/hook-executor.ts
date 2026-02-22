// Hook executor — runs shell commands at lifecycle points within a stage
// Mirrors startup-executor.ts but with on_failure semantics and tool arg templates

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { StageHookDef, ToolHookDef } from '@studio/contracts';

const execAsync = promisify(exec);
const HOOK_TIMEOUT_MS = 30_000;

export interface HookResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Renders {{tool.argName}} placeholders from tool call arguments.
 * Only substitutes {{tool.<word>}} patterns — other placeholders are left unchanged.
 * Unknown args → empty string.
 */
export function renderHookCommand(
  command: string,
  toolArgs: Record<string, unknown>
): string {
  return command.replace(
    /\{\{tool\.(\w+)\}\}/g,
    (_, key: string) => (toolArgs[key] !== undefined ? String(toolArgs[key]) : '')
  );
}

/**
 * Run a stage-level hook command (on_stage_start, on_stage_complete).
 */
export async function runStageHook(
  hook: StageHookDef,
  cwd: string
): Promise<HookResult> {
  return execHook(hook.command, cwd);
}

/**
 * Run a tool-level hook command (pre_tool_use, post_tool_use).
 * The command may reference tool arguments via {{tool.argName}}.
 */
export async function runToolHook(
  hook: ToolHookDef,
  toolArgs: Record<string, unknown>,
  cwd: string
): Promise<HookResult> {
  const command = renderHookCommand(hook.command, toolArgs);
  return execHook(command, cwd);
}

async function execHook(command: string, cwd: string): Promise<HookResult> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
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
