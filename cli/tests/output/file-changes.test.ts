import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FileChangeCollector, formatFileChanges, type FileChange } from '../../src/output/file-changes.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'node:child_process';
const mockExecSync = vi.mocked(execSync);

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

describe('FileChangeCollector.computeSummary', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it('returns null when no files were written', () => {
    const collector = new FileChangeCollector();
    const result = collector.computeSummary('/fake/repo');
    expect(result).toBeNull();
  });

  it('parses git diff --numstat for modified files', () => {
    mockExecSync.mockReturnValue('15\t3\tsrc/app.ts\n');

    const collector = new FileChangeCollector();
    collector.onToolCallComplete({
      tool: 'repo_manager-write_file',
      result: { path: 'src/app.ts', written: true },
      duration_ms: 10,
      timestamp: Date.now(),
    });

    const summary = collector.computeSummary('/fake/repo');
    expect(summary).toEqual([
      { path: 'src/app.ts', status: 'M', added: 15, removed: 3 },
    ]);
  });

  it('marks files not in git diff as Added with line count', () => {
    mockExecSync
      .mockReturnValueOnce('')           // git diff --numstat returns nothing
      .mockReturnValueOnce('42\n');      // wc -l for the new file

    const collector = new FileChangeCollector();
    collector.onToolCallComplete({
      tool: 'repo_manager-write_file',
      result: { path: 'src/new.ts', written: true },
      duration_ms: 10,
      timestamp: Date.now(),
    });

    const summary = collector.computeSummary('/fake/repo');
    expect(summary).toEqual([
      { path: 'src/new.ts', status: 'A', added: 42, removed: 0 },
    ]);
  });

  it('returns null when git is not available', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('git not found');
    });

    const collector = new FileChangeCollector();
    collector.onToolCallComplete({
      tool: 'repo_manager-write_file',
      result: { path: 'src/app.ts', written: true },
      duration_ms: 10,
      timestamp: Date.now(),
    });

    const summary = collector.computeSummary('/fake/repo');
    expect(summary).toBeNull();
  });
});

describe('formatFileChanges', () => {
  it('formats modified files with +/- counts', () => {
    const changes: FileChange[] = [
      { path: 'src/app.ts', status: 'M', added: 15, removed: 3 },
    ];
    const lines = formatFileChanges(changes);
    expect(lines).toContain('Changes:');
    expect(lines).toContain('M');
    expect(lines).toContain('src/app.ts');
    expect(lines).toContain('+15');
    expect(lines).toContain('-3');
  });

  it('formats added files with line count', () => {
    const changes: FileChange[] = [
      { path: 'src/new.ts', status: 'A', added: 42, removed: 0 },
    ];
    const lines = formatFileChanges(changes);
    expect(lines).toContain('A');
    expect(lines).toContain('src/new.ts');
    expect(lines).toContain('new file');
    expect(lines).toContain('42');
  });

  it('formats mixed M and A files', () => {
    const changes: FileChange[] = [
      { path: 'src/app.ts', status: 'M', added: 15, removed: 3 },
      { path: 'src/new.ts', status: 'A', added: 42, removed: 0 },
    ];
    const lines = formatFileChanges(changes);
    expect(lines).toContain('M');
    expect(lines).toContain('A');
  });

  it('returns empty string for empty array', () => {
    expect(formatFileChanges([])).toBe('');
  });
});
