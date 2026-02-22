// Execute on_pipeline_start commands and collect their stdout

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { StartupCommand } from '@studio/contracts';

const execAsync = promisify(exec);
const COMMAND_TIMEOUT_MS = 10_000;

export async function executeStartupCommands(
  commands: StartupCommand[],
  cwd?: string
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};

  for (const cmd of commands) {
    try {
      const { stdout } = await execAsync(cmd.command, {
        cwd,
        timeout: COMMAND_TIMEOUT_MS,
      });
      result[cmd.inject_as] = stdout.trim();
    } catch (err) {
      console.warn(
        `[on_pipeline_start] command failed: "${cmd.command}" — ${(err as Error).message}`
      );
    }
  }

  return result;
}
