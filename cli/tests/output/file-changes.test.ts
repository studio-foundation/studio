import { describe, it, expect } from 'vitest';
import { FileChangeCollector } from '../../src/output/file-changes.js';

describe('FileChangeCollector', () => {
  it('collects unique file paths from tool call events', () => {
    const collector = new FileChangeCollector();

    collector.onToolCallComplete({
      tool: 'repo_manager-write_file',
      result: { path: 'src/app.ts', written: true },
      duration_ms: 10,
      timestamp: Date.now(),
    });
    collector.onToolCallComplete({
      tool: 'repo_manager-read_file',
      result: { content: '...' },
      duration_ms: 5,
      timestamp: Date.now(),
    });
    collector.onToolCallComplete({
      tool: 'repo_manager-write_file',
      result: { path: 'src/app.ts', written: true },
      duration_ms: 8,
      timestamp: Date.now(),
    });

    expect(collector.getWrittenPaths()).toEqual(['src/app.ts']);
  });

  it('returns empty array when no write calls', () => {
    const collector = new FileChangeCollector();
    expect(collector.getWrittenPaths()).toEqual([]);
  });

  it('ignores failed tool calls', () => {
    const collector = new FileChangeCollector();

    collector.onToolCallComplete({
      tool: 'repo_manager-write_file',
      result: undefined,
      error: 'Permission denied',
      duration_ms: 10,
      timestamp: Date.now(),
    });

    expect(collector.getWrittenPaths()).toEqual([]);
  });

  it('collects multiple distinct paths in order', () => {
    const collector = new FileChangeCollector();

    collector.onToolCallComplete({
      tool: 'repo_manager-write_file',
      result: { path: 'src/b.ts', written: true },
      duration_ms: 10,
      timestamp: Date.now(),
    });
    collector.onToolCallComplete({
      tool: 'repo_manager-write_file',
      result: { path: 'src/a.ts', written: true },
      duration_ms: 10,
      timestamp: Date.now(),
    });

    expect(collector.getWrittenPaths()).toEqual(['src/b.ts', 'src/a.ts']);
  });
});
