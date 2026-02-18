/**
 * Search tool - codebase search using grep
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import type { Tool } from '../tool-registry.js';

const execAsync = promisify(exec);

export function createSearchTools(repoPath: string): Tool[] {
  return [
    {
      name: 'search-search_codebase',
      description: 'Search for a pattern in the codebase (like grep)',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Search pattern (string or regex)'
          },
          file_pattern: {
            type: 'string',
            description: 'File glob pattern to filter (e.g., "*.ts", "*.js")',
          }
        },
        required: ['pattern']
      },
      execute: async ({ pattern, file_pattern }) => {
        try {
          const pat = pattern as string;
          const filePat = file_pattern as string | undefined;

          // Try ripgrep first, fallback to grep
          let command: string;

          // Check if ripgrep is available
          try {
            await execAsync('which rg', { cwd: repoPath });
            // Use ripgrep
            command = filePat
              ? `rg -n --glob "${filePat}" "${pat}" .`
              : `rg -n "${pat}" .`;
          } catch {
            // Fallback to standard grep
            command = filePat
              ? `grep -r -n --include="${filePat}" "${pat}" .`
              : `grep -r -n "${pat}" .`;
          }

          const { stdout } = await execAsync(command, {
            cwd: repoPath,
            maxBuffer: 1024 * 1024 * 10, // 10MB
            timeout: 30000
          });

          // Parse results - format is "file:line:content"
          const lines = stdout.trim().split('\n').filter(l => l.length > 0);
          const matches = lines.slice(0, 50).map(line => {
            const parts = line.split(':');
            if (parts.length >= 3) {
              const [file, lineNum, ...rest] = parts;
              return {
                file,
                line: parseInt(lineNum, 10),
                content: rest.join(':').trim()
              };
            }
            return null;
          }).filter(m => m !== null);

          return {
            success: true,
            output: {
              pattern,
              matches,
              count: matches.length,
              total_found: lines.length,
              truncated: lines.length > 50
            }
          };
        } catch (error: unknown) {
          // Exit code 1 typically means no matches found
          if (error && typeof error === 'object' && 'code' in error && error.code === 1) {
            return {
              success: true,
              output: {
                pattern,
                matches: [],
                count: 0,
                total_found: 0,
                truncated: false
              }
            };
          }

          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            output: null,
            error: `Search failed: ${errorMessage}`
          };
        }
      }
    }
  ];
}
