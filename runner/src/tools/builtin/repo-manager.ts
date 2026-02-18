/**
 * Repository manager tools - file operations
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { Tool } from '../tool-registry.js';

export function createRepoManagerTools(repoPath: string): Tool[] {
  return [
    {
      name: 'repo_manager-read_file',
      description: 'Read the contents of a file in the repository',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path to the file from repository root'
          }
        },
        required: ['path']
      },
      execute: async ({ path: filePath }) => {
        try {
          const fullPath = path.join(repoPath, filePath as string);
          const content = await fs.readFile(fullPath, 'utf-8');
          return {
            success: true,
            output: { path: filePath, content }
          };
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            output: null,
            error: `Failed to read file: ${errorMessage}`
          };
        }
      }
    },
    {
      name: 'repo_manager-write_file',
      description: 'Write content to a file in the repository (creates or overwrites)',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path to the file from repository root'
          },
          content: {
            type: 'string',
            description: 'Complete file content to write'
          }
        },
        required: ['path', 'content']
      },
      execute: async ({ path: filePath, content }) => {
        try {
          const fullPath = path.join(repoPath, filePath as string);
          const dir = path.dirname(fullPath);

          // Create parent directories if needed
          await fs.mkdir(dir, { recursive: true });

          // Write file
          await fs.writeFile(fullPath, content as string, 'utf-8');

          return {
            success: true,
            output: { path: filePath, written: true }
          };
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            output: null,
            error: `Failed to write file: ${errorMessage}`
          };
        }
      }
    },
    {
      name: 'repo_manager-list_files',
      description: 'List files in a directory of the repository',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path to the directory (default: root)',
            default: '.'
          },
          recursive: {
            type: 'boolean',
            description: 'List files recursively (default: false)',
            default: false
          }
        }
      },
      execute: async ({ path: dirPath = '.', recursive = false }) => {
        try {
          const fullPath = path.join(repoPath, dirPath as string);

          const files: string[] = [];
          const ignoredDirs = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage'];

          const listDir = async (currentPath: string, relativeBase: string) => {
            const entries = await fs.readdir(currentPath, { withFileTypes: true });

            for (const entry of entries) {
              const relativePath = path.join(relativeBase, entry.name);

              if (entry.isDirectory()) {
                if (recursive && !ignoredDirs.includes(entry.name)) {
                  await listDir(path.join(currentPath, entry.name), relativePath);
                }
              } else if (entry.isFile()) {
                files.push(relativePath);
              }
            }
          };

          await listDir(fullPath, '');

          return {
            success: true,
            output: { path: dirPath, files, count: files.length }
          };
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            output: null,
            error: `Failed to list files: ${errorMessage}`
          };
        }
      }
    }
  ];
}
