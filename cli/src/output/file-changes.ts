import { execSync } from 'node:child_process';
import { join } from 'node:path';
import chalk from 'chalk';
import type { ToolCallCompleteEvent } from '@studio-foundation/contracts';

export interface FileChange {
  path: string;
  status: 'M' | 'A';
  added: number;
  removed: number;
}

export class FileChangeCollector {
  private paths = new Set<string>();

  onToolCallComplete(event: ToolCallCompleteEvent): void {
    if (event.tool !== 'repo_manager-write_file') return;
    if (event.error) return;

    const result = event.result as { path?: string } | undefined;
    if (result?.path) {
      this.paths.add(result.path);
    }
  }

  getWrittenPaths(): string[] {
    return [...this.paths];
  }

  computeSummary(repoPath: string): FileChange[] | null {
    const written = this.getWrittenPaths();
    if (written.length === 0) return null;

    try {
      const diffOutput = execSync(
        `git diff --numstat -- ${written.map((p) => JSON.stringify(p)).join(' ')}`,
        { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();

      const diffMap = new Map<string, { added: number; removed: number }>();
      if (diffOutput) {
        for (const line of diffOutput.split('\n')) {
          const [addedStr, removedStr, ...pathParts] = line.split('\t');
          const filePath = pathParts.join('\t');
          diffMap.set(filePath, {
            added: parseInt(addedStr, 10) || 0,
            removed: parseInt(removedStr, 10) || 0,
          });
        }
      }

      const changes: FileChange[] = [];
      for (const filePath of written) {
        const diff = diffMap.get(filePath);
        if (diff) {
          changes.push({ path: filePath, status: 'M', added: diff.added, removed: diff.removed });
        } else {
          let lineCount = 0;
          try {
            const wcOutput = execSync(
              `wc -l < ${JSON.stringify(join(repoPath, filePath))}`,
              { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
            ).trim();
            lineCount = parseInt(wcOutput, 10) || 0;
          } catch {
            // File might have been deleted or moved — skip line count
          }
          changes.push({ path: filePath, status: 'A', added: lineCount, removed: 0 });
        }
      }

      return changes;
    } catch {
      // git not available or not a git repo — graceful degradation
      return null;
    }
  }
}

export function formatFileChanges(changes: FileChange[]): string {
  if (changes.length === 0) return '';

  const lines: string[] = ['', 'Changes:'];
  for (const change of changes) {
    const tag = change.status === 'A'
      ? chalk.green('A')
      : chalk.yellow('M');

    const detail = change.status === 'A'
      ? chalk.gray(`(new file, ${change.added} lines)`)
      : chalk.gray(`(+${change.added} -${change.removed})`);

    lines.push(`  ${tag} ${change.path}  ${detail}`);
  }

  return lines.join('\n');
}
