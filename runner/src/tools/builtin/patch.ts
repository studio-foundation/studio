/**
 * Patch tool - apply unified diffs to files
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { Tool, ToolResult } from '../tool-registry.js';

interface Hunk {
  oldStart: number;
  oldCount: number;
  lines: HunkLine[];
}

interface HunkLine {
  type: 'context' | 'add' | 'remove';
  content: string;
}

interface PatchResult {
  success: boolean;
  path: string;
  hunks_applied: number;
  hunks_total: number;
  lines_added: number;
  lines_removed: number;
}

/**
 * Parse a unified diff string into hunks.
 */
function parseHunks(patch: string): Hunk[] {
  const rawLines = patch.split('\n');
  // Filter out --- / +++ headers
  const lines = rawLines.filter(
    (l) => !l.startsWith('---') && !l.startsWith('+++')
  );

  const hunks: Hunk[] = [];
  let current: Hunk | null = null;

  for (const line of lines) {
    const hunkHeader = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+\d+(?:,\d+)?\s*@@/);
    if (hunkHeader) {
      current = {
        oldStart: parseInt(hunkHeader[1], 10),
        oldCount: parseInt(hunkHeader[2] ?? '1', 10),
        lines: [],
      };
      hunks.push(current);
      continue;
    }

    if (!current) continue;

    if (line.startsWith('+')) {
      current.lines.push({ type: 'add', content: line.slice(1) });
    } else if (line.startsWith('-')) {
      current.lines.push({ type: 'remove', content: line.slice(1) });
    } else if (line.startsWith(' ') || line === '') {
      // Context line — space prefix or empty line
      const content = line.startsWith(' ') ? line.slice(1) : line;
      current.lines.push({ type: 'context', content });
    }
    // Ignore lines like "\ No newline at end of file"
  }

  return hunks;
}

/**
 * Build the "old block" — context + removed lines that must match the file.
 */
function getOldBlock(hunk: Hunk): string[] {
  return hunk.lines
    .filter((l) => l.type === 'context' || l.type === 'remove')
    .map((l) => l.content);
}

/**
 * Build the "new block" — context + added lines that replace the old block.
 */
function getNewBlock(hunk: Hunk): string[] {
  return hunk.lines
    .filter((l) => l.type === 'context' || l.type === 'add')
    .map((l) => l.content);
}

/**
 * Compare two strings with trailing whitespace tolerance.
 */
function fuzzyMatch(a: string, b: string): boolean {
  return a.trimEnd() === b.trimEnd();
}

/**
 * Check if oldBlock matches fileLines starting at position `start`.
 */
function blockMatchesAt(fileLines: string[], oldBlock: string[], start: number): boolean {
  if (start + oldBlock.length > fileLines.length) return false;
  return oldBlock.every((line, i) => fuzzyMatch(fileLines[start + i], line));
}

/**
 * Find where the old block matches in the file.
 * Tries the hinted line first, then scans the full file.
 * Returns the 0-based start index.
 */
function findMatch(
  fileLines: string[],
  oldBlock: string[],
  hintLine: number,
  hunkIndex: number
): number {
  // Convert 1-based hint to 0-based
  const hint = hintLine - 1;

  // Fast path: try at the hinted position
  if (hint >= 0 && blockMatchesAt(fileLines, oldBlock, hint)) {
    return hint;
  }

  // Slow path: scan the whole file
  const matches: number[] = [];
  for (let i = 0; i < fileLines.length; i++) {
    if (blockMatchesAt(fileLines, oldBlock, i)) {
      matches.push(i);
    }
  }

  if (matches.length === 1) return matches[0];

  if (matches.length === 0) {
    const expected = oldBlock[0] ?? '(empty)';
    throw new Error(
      `Context mismatch at hunk ${hunkIndex + 1}: could not find context "${expected}" in file`
    );
  }

  throw new Error(
    `Ambiguous match at hunk ${hunkIndex + 1}: context found at lines ${matches.map((m) => m + 1).join(', ')}. Add more context lines.`
  );
}

export function createPatchTools(repoPath: string): Tool[] {
  return [
    {
      name: 'repo_manager-apply_patch',
      description:
        'Apply a unified diff patch to a file. The patch must include enough context lines for unambiguous matching. Fails loudly if context doesn\'t match the file content.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path to the file to patch (from workspace root)',
          },
          patch: {
            type: 'string',
            description:
              'Unified diff format patch. Must start with @@ hunk headers. Use - for removed lines, + for added lines, space for context lines. Include at least 3 context lines before and after changes.',
          },
        },
        required: ['path', 'patch'],
      },
      execute: async ({ path: filePath, patch: patchStr }): Promise<ToolResult> => {
        try {
          const fullPath = path.join(repoPath, filePath as string);

          // Read file
          let fileContent: string;
          try {
            fileContent = await fs.readFile(fullPath, 'utf-8');
          } catch {
            return {
              success: false,
              output: null,
              error: `File not found: ${filePath}`,
            };
          }

          // Parse hunks
          const hunks = parseHunks(patchStr as string);
          if (hunks.length === 0) {
            return {
              success: false,
              output: null,
              error: 'Invalid patch format: no hunks found (expected @@ headers)',
            };
          }

          const fileLines = fileContent.split('\n');
          let totalAdded = 0;
          let totalRemoved = 0;

          // Find all match positions first (before any modifications)
          const matchPositions: number[] = [];
          for (let i = 0; i < hunks.length; i++) {
            const oldBlock = getOldBlock(hunks[i]);
            const pos = findMatch(fileLines, oldBlock, hunks[i].oldStart, i);
            matchPositions.push(pos);
          }

          // Apply hunks in reverse order to preserve line numbers
          const indices = hunks.map((_, i) => i);
          indices.sort((a, b) => matchPositions[b] - matchPositions[a]);

          for (const i of indices) {
            const hunk = hunks[i];
            const pos = matchPositions[i];
            const oldBlock = getOldBlock(hunk);
            const newBlock = getNewBlock(hunk);

            fileLines.splice(pos, oldBlock.length, ...newBlock);
            totalAdded += hunk.lines.filter((l) => l.type === 'add').length;
            totalRemoved += hunk.lines.filter((l) => l.type === 'remove').length;
          }

          // Write file back
          await fs.writeFile(fullPath, fileLines.join('\n'), 'utf-8');

          const result: PatchResult = {
            success: true,
            path: filePath as string,
            hunks_applied: hunks.length,
            hunks_total: hunks.length,
            lines_added: totalAdded,
            lines_removed: totalRemoved,
          };

          return { success: true, output: result };
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            output: null,
            error: errorMessage,
          };
        }
      },
    },
  ];
}
