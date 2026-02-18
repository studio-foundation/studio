/**
 * Shell tool - command execution with basic safety checks
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import type { Tool } from '../tool-registry.js';

const execAsync = promisify(exec);

export function createShellTools(workingDir: string): Tool[] {
  return [
    {
      name: 'shell-run_command',
      description: 'Run a shell command in the repository directory',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to run'
          }
        },
        required: ['command']
      },
      execute: async ({ command }) => {
        try {
          const cmd = command as string;

          // Basic sanitization - block obviously dangerous commands
          const dangerous = ['rm -rf', 'sudo', 'mkfs', 'dd if=', '> /dev/', 'format'];
          const isDangerous = dangerous.some(pattern => cmd.toLowerCase().includes(pattern));

          if (isDangerous) {
            return {
              success: false,
              output: null,
              error: 'Dangerous command blocked for safety'
            };
          }

          // Execute with timeout of 30 seconds
          const { stdout, stderr } = await execAsync(cmd, {
            cwd: workingDir,
            timeout: 30000,
            maxBuffer: 1024 * 1024 * 10 // 10MB max output
          });

          return {
            success: true,
            output: {
              stdout: stdout.trim(),
              stderr: stderr.trim(),
              exitCode: 0
            }
          };
        } catch (error: unknown) {
          // Execution error (non-zero exit code or timeout)
          if (error && typeof error === 'object' && 'stdout' in error && 'stderr' in error) {
            const execError = error as { stdout: string; stderr: string; code?: number };
            return {
              success: false,
              output: {
                stdout: execError.stdout?.trim() || '',
                stderr: execError.stderr?.trim() || '',
                exitCode: execError.code || 1
              },
              error: execError.stderr?.trim() || 'Command execution failed'
            };
          }

          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            output: null,
            error: `Shell execution error: ${errorMessage}`
          };
        }
      }
    }
  ];
}
