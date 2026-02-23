import type { ToolCallCompleteEvent } from '@studio/contracts';

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
}
