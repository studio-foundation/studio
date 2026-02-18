// cli/tests/output/formatters.test.ts
import { describe, it, expect } from 'vitest';
import {
  humanReadableStageName,
  summarizeToolCalls,
  summarizeOutput,
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
