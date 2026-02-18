/**
 * Git tools - branch, commit, push, pull, status, diff
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import type { Tool } from '../tool-registry.js';

const execAsync = promisify(exec);

const PROTECTED_BRANCHES = ['main', 'master', 'develop', 'production'];

async function isGitRepo(workingDir: string): Promise<boolean> {
  try {
    await execAsync('git rev-parse --git-dir', { cwd: workingDir });
    return true;
  } catch {
    return false;
  }
}

async function runGit(args: string, workingDir: string): Promise<{ stdout: string; stderr: string }> {
  return execAsync(`git ${args}`, { cwd: workingDir, timeout: 30000 });
}

export function createGitTools(workingDir: string): Tool[] {
  return [
    {
      name: 'git-checkout',
      description: 'Checkout or create a branch',
      parameters: {
        type: 'object',
        properties: {
          branch: {
            type: 'string',
            description: 'Branch name to checkout or create'
          },
          create: {
            type: 'boolean',
            description: 'Create the branch if it does not exist (-b flag). Default: false'
          }
        },
        required: ['branch']
      },
      execute: async ({ branch, create }) => {
        const branchName = branch as string;
        const shouldCreate = create as boolean | undefined ?? false;

        if (!(await isGitRepo(workingDir))) {
          return { success: false, output: null, error: 'Not a git repository' };
        }

        if (shouldCreate && PROTECTED_BRANCHES.includes(branchName)) {
          return {
            success: false,
            output: null,
            error: `Cannot create protected branch: ${branchName}`
          };
        }

        try {
          const flag = shouldCreate ? '-b ' : '';
          const { stdout, stderr } = await runGit(`checkout ${flag}${branchName}`, workingDir);
          return {
            success: true,
            output: { branch: branchName, created: shouldCreate, stdout: stdout.trim(), stderr: stderr.trim() }
          };
        } catch (error: unknown) {
          const e = error as { stderr?: string; message?: string };
          return {
            success: false,
            output: null,
            error: e.stderr?.trim() || e.message || 'git checkout failed'
          };
        }
      }
    },

    {
      name: 'git-commit',
      description: 'Stage files and commit changes',
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'Commit message'
          },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Files to stage. If empty or omitted, stages all changes (git add -A)'
          }
        },
        required: ['message']
      },
      execute: async ({ message, files }) => {
        const commitMessage = message as string;
        const filesToStage = files as string[] | undefined;

        if (!(await isGitRepo(workingDir))) {
          return { success: false, output: null, error: 'Not a git repository' };
        }

        try {
          // Check for merge conflicts
          const { stdout: statusOut } = await runGit('status --porcelain', workingDir);
          const hasConflicts = statusOut.split('\n').some(line => line.startsWith('UU') || line.startsWith('AA') || line.startsWith('DD'));
          if (hasConflicts) {
            return { success: false, output: null, error: 'Cannot commit: merge conflicts detected' };
          }

          // Stage files
          if (filesToStage && filesToStage.length > 0) {
            await runGit(`add -- ${filesToStage.map(f => `"${f}"`).join(' ')}`, workingDir);
          } else {
            await runGit('add -A', workingDir);
          }

          // Commit
          const { stdout } = await runGit(`commit -m ${JSON.stringify(commitMessage)}`, workingDir);
          return {
            success: true,
            output: { message: commitMessage, stdout: stdout.trim() }
          };
        } catch (error: unknown) {
          const e = error as { stderr?: string; stdout?: string; message?: string };
          return {
            success: false,
            output: null,
            error: e.stderr?.trim() || e.stdout?.trim() || e.message || 'git commit failed'
          };
        }
      }
    },

    {
      name: 'git-push',
      description: 'Push current branch to remote',
      parameters: {
        type: 'object',
        properties: {
          remote: {
            type: 'string',
            description: 'Remote name. Default: origin'
          },
          set_upstream: {
            type: 'boolean',
            description: 'Set upstream tracking (-u flag). Default: true'
          }
        },
        required: []
      },
      execute: async ({ remote, set_upstream }) => {
        const remoteName = (remote as string | undefined) ?? 'origin';
        const setUpstream = (set_upstream as boolean | undefined) ?? true;

        if (!(await isGitRepo(workingDir))) {
          return { success: false, output: null, error: 'Not a git repository' };
        }

        try {
          const { stdout: branchOut } = await runGit('rev-parse --abbrev-ref HEAD', workingDir);
          const currentBranch = branchOut.trim();

          const upstreamFlag = setUpstream ? `-u ` : '';
          const { stdout, stderr } = await runGit(`push ${upstreamFlag}${remoteName} ${currentBranch}`, workingDir);
          return {
            success: true,
            output: { remote: remoteName, branch: currentBranch, stdout: stdout.trim(), stderr: stderr.trim() }
          };
        } catch (error: unknown) {
          const e = error as { stderr?: string; message?: string };
          return {
            success: false,
            output: null,
            error: e.stderr?.trim() || e.message || 'git push failed'
          };
        }
      }
    },

    {
      name: 'git-pull',
      description: 'Pull latest changes from remote',
      parameters: {
        type: 'object',
        properties: {
          remote: {
            type: 'string',
            description: 'Remote name. Default: origin'
          },
          branch: {
            type: 'string',
            description: 'Branch to pull. If omitted, pulls current branch'
          }
        },
        required: []
      },
      execute: async ({ remote, branch }) => {
        const remoteName = (remote as string | undefined) ?? 'origin';
        const branchName = branch as string | undefined;

        if (!(await isGitRepo(workingDir))) {
          return { success: false, output: null, error: 'Not a git repository' };
        }

        try {
          const branchArg = branchName ? ` ${branchName}` : '';
          const { stdout, stderr } = await runGit(`pull ${remoteName}${branchArg}`, workingDir);
          return {
            success: true,
            output: { remote: remoteName, branch: branchName ?? 'current', stdout: stdout.trim(), stderr: stderr.trim() }
          };
        } catch (error: unknown) {
          const e = error as { stderr?: string; stdout?: string; message?: string };
          return {
            success: false,
            output: null,
            error: e.stderr?.trim() || e.stdout?.trim() || e.message || 'git pull failed'
          };
        }
      }
    },

    {
      name: 'git-status',
      description: 'Show working tree status (modified, added, deleted files)',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      },
      execute: async () => {
        if (!(await isGitRepo(workingDir))) {
          return { success: false, output: null, error: 'Not a git repository' };
        }

        try {
          const { stdout: porcelain } = await runGit('status --porcelain', workingDir);
          const { stdout: branch } = await runGit('rev-parse --abbrev-ref HEAD', workingDir);

          const files = porcelain
            .split('\n')
            .filter(line => line.trim())
            .map(line => ({ status: line.slice(0, 2).trim(), file: line.slice(3) }));

          return {
            success: true,
            output: {
              branch: branch.trim(),
              clean: files.length === 0,
              files
            }
          };
        } catch (error: unknown) {
          const e = error as { stderr?: string; message?: string };
          return {
            success: false,
            output: null,
            error: e.stderr?.trim() || e.message || 'git status failed'
          };
        }
      }
    },

    {
      name: 'git-diff',
      description: 'Show changes in working tree or staged files',
      parameters: {
        type: 'object',
        properties: {
          staged: {
            type: 'boolean',
            description: 'Show staged changes (--cached). Default: false'
          },
          file: {
            type: 'string',
            description: 'Diff a specific file. If omitted, shows all changes'
          }
        },
        required: []
      },
      execute: async ({ staged, file }) => {
        const showStaged = (staged as boolean | undefined) ?? false;
        const filePath = file as string | undefined;

        if (!(await isGitRepo(workingDir))) {
          return { success: false, output: null, error: 'Not a git repository' };
        }

        try {
          const stagedFlag = showStaged ? '--cached ' : '';
          const fileArg = filePath ? `-- "${filePath}"` : '';
          const { stdout } = await runGit(`diff ${stagedFlag}${fileArg}`.trim(), workingDir);
          return {
            success: true,
            output: { diff: stdout, staged: showStaged, file: filePath ?? null }
          };
        } catch (error: unknown) {
          const e = error as { stderr?: string; message?: string };
          return {
            success: false,
            output: null,
            error: e.stderr?.trim() || e.message || 'git diff failed'
          };
        }
      }
    }
  ];
}
