// cli/tests/output/formatters.test.ts
import { describe, it, expect } from 'vitest';
import {
  humanReadableStageName,
  summarizeToolCalls,
  summarizeOutput,
  getToolIcon,
  summarizeToolParams,
  summarizeToolResult,
} from '../../src/output/formatters.js';
import type { ToolCallSummary } from '@studio/engine';

describe('humanReadableStageName', () => {
  it('maps brief-analysis to Analyzing brief', () => {
    expect(humanReadableStageName('brief-analysis')).toBe('Analyzing brief');
  });

  it('maps implementation-plan to Planning implementation', () => {
    expect(humanReadableStageName('implementation-plan')).toBe('Planning implementation');
  });

  it('maps code-generation to Generating code', () => {
    expect(humanReadableStageName('code-generation')).toBe('Generating code');
  });

  it('maps qa-review to Reviewing', () => {
    expect(humanReadableStageName('qa-review')).toBe('Reviewing');
  });

  it('falls back to title-cased words for unknown names', () => {
    expect(humanReadableStageName('custom-stage')).toBe('Custom Stage');
  });

  it('handles single-word stage names', () => {
    expect(humanReadableStageName('analysis')).toBe('Analysis');
  });
});

describe('summarizeToolCalls', () => {
  it('returns empty string for empty array', () => {
    expect(summarizeToolCalls([])).toBe('');
  });

  it('groups read_file calls', () => {
    const calls: ToolCallSummary[] = [
      { name: 'repo_manager-read_file', arguments_summary: 'src/a.ts' },
      { name: 'repo_manager-read_file', arguments_summary: 'src/b.ts' },
      { name: 'repo_manager-read_file', arguments_summary: 'src/c.ts' },
    ];
    expect(summarizeToolCalls(calls)).toBe('Read 3 files');
  });

  it('groups write_file calls', () => {
    const calls: ToolCallSummary[] = [
      { name: 'repo_manager-write_file', arguments_summary: 'src/a.ts' },
    ];
    expect(summarizeToolCalls(calls)).toBe('Wrote 1 file');
  });

  it('groups mixed tool calls', () => {
    const calls: ToolCallSummary[] = [
      { name: 'repo_manager-read_file', arguments_summary: 'a' },
      { name: 'repo_manager-read_file', arguments_summary: 'b' },
      { name: 'repo_manager-write_file', arguments_summary: 'c' },
      { name: 'shell-run_command', arguments_summary: 'npm test' },
    ];
    expect(summarizeToolCalls(calls)).toBe('Read 2 files, wrote 1 file, ran 1 command');
  });

  it('groups list_files calls', () => {
    const calls: ToolCallSummary[] = [
      { name: 'repo_manager-list_files', arguments_summary: 'src/' },
      { name: 'repo_manager-list_files', arguments_summary: 'tests/' },
    ];
    expect(summarizeToolCalls(calls)).toBe('Listed 2 directories');
  });

  it('handles unknown tool names with a generic label', () => {
    const calls: ToolCallSummary[] = [
      { name: 'custom-do_something', arguments_summary: '' },
    ];
    expect(summarizeToolCalls(calls)).toBe('1 tool call');
  });

  it('groups search calls', () => {
    const calls: ToolCallSummary[] = [
      { name: 'search-search_codebase', arguments_summary: 'useState' },
    ];
    expect(summarizeToolCalls(calls)).toBe('Searched 1 time');
  });
});

describe('summarizeOutput', () => {
  it('returns null for null/undefined', () => {
    expect(summarizeOutput(null)).toBeNull();
    expect(summarizeOutput(undefined)).toBeNull();
  });

  it('returns null for non-object', () => {
    expect(summarizeOutput('hello')).toBeNull();
    expect(summarizeOutput(42)).toBeNull();
  });

  it('prefers the summary field when present', () => {
    const output = { summary: 'Added FAQ section with 3 questions', files_changed: ['src/about.tsx'] };
    expect(summarizeOutput(output)).toBe('Added FAQ section with 3 questions');
  });

  it('truncates long summary strings', () => {
    const long = 'x'.repeat(200);
    expect(summarizeOutput({ summary: long })).toHaveLength(153); // 150 + '...'
  });

  it('falls back to description field', () => {
    const output = { description: 'Some description', count: 3 };
    expect(summarizeOutput(output)).toBe('Some description');
  });

  it('falls back to field count when no summary or description', () => {
    const output = { files_changed: [], requirements: [], acceptance_criteria: [] };
    expect(summarizeOutput(output)).toBe('3 fields: files_changed, requirements, acceptance_criteria');
  });

  it('returns null for empty object', () => {
    expect(summarizeOutput({})).toBeNull();
  });
});

describe('getToolIcon', () => {
  it('returns 📖 for read_file tools', () => {
    expect(getToolIcon('repo_manager-read_file')).toBe('📖');
  });

  it('returns ✏️ for write_file tools', () => {
    expect(getToolIcon('repo_manager-write_file')).toBe('✏️');
  });

  it('returns 📁 for list_files tools', () => {
    expect(getToolIcon('repo_manager-list_files')).toBe('📁');
  });

  it('returns 🔍 for search tools', () => {
    expect(getToolIcon('search-search_codebase')).toBe('🔍');
  });

  it('returns ⚙️ for shell tools', () => {
    expect(getToolIcon('shell-run_command')).toBe('⚙️');
  });

  it('returns 🔀 for git tools', () => {
    expect(getToolIcon('git-commit')).toBe('🔀');
  });

  it('returns 🔧 for unknown tools', () => {
    expect(getToolIcon('custom-unknown_tool')).toBe('🔧');
  });
});

describe('summarizeToolParams', () => {
  it('shows path for read_file', () => {
    expect(summarizeToolParams('repo_manager-read_file', { path: 'src/app.ts' }))
      .toBe('(src/app.ts)');
  });

  it('shows path for write_file', () => {
    expect(summarizeToolParams('repo_manager-write_file', { path: 'src/new.ts', content: '...' }))
      .toBe('(src/new.ts)');
  });

  it('shows path for list_files when present', () => {
    expect(summarizeToolParams('repo_manager-list_files', { path: 'src/' }))
      .toBe('(src/)');
  });

  it('returns empty string for list_files without path', () => {
    expect(summarizeToolParams('repo_manager-list_files', {})).toBe('');
  });

  it('shows query for search tools', () => {
    expect(summarizeToolParams('search-search_codebase', { query: 'useState' }))
      .toBe('("useState")');
  });

  it('shows command for shell tools', () => {
    expect(summarizeToolParams('shell-run_command', { command: 'npm test' }))
      .toBe('("npm test")');
  });

  it('returns empty string for unknown tools', () => {
    expect(summarizeToolParams('custom-do_thing', { foo: 'bar' })).toBe('');
  });
});

describe('summarizeToolResult', () => {
  it('returns error message when error is set', () => {
    expect(summarizeToolResult(undefined, 'file not found')).toBe('file not found');
  });

  it('returns line count for multi-line strings', () => {
    expect(summarizeToolResult('line1\nline2\nline3')).toBe('3 lines');
  });

  it('returns the string itself for single-line string under 60 chars', () => {
    expect(summarizeToolResult('short result')).toBe('short result');
  });

  it('truncates long single-line strings to 60 chars', () => {
    expect(summarizeToolResult('x'.repeat(80))).toHaveLength(60);
  });

  it('returns item count for arrays', () => {
    expect(summarizeToolResult(['a', 'b', 'c'])).toBe('3 items');
  });

  it('returns Done for other types', () => {
    expect(summarizeToolResult({ key: 'value' })).toBe('Done');
  });

  it('returns Done for null', () => {
    expect(summarizeToolResult(null)).toBe('Done');
  });

  it('returns line count for read_file result object', () => {
    const content = 'line1\nline2\nline3\nline4';
    expect(summarizeToolResult({ path: 'src/app.ts', content })).toBe('4 lines');
  });

  it('returns file count for list_files result object', () => {
    expect(summarizeToolResult({ path: 'src/', files: ['a.ts', 'b.ts', 'c.ts'], count: 3 })).toBe('3 files');
  });

  it('returns "written" for write_file result object', () => {
    expect(summarizeToolResult({ path: 'src/new.ts', written: true })).toBe('written');
  });
});
