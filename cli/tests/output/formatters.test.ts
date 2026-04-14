// cli/tests/output/formatters.test.ts
import { describe, it, expect } from 'vitest';
import {
  humanReadableStageName,
  summarizeToolCalls,
  getToolIcon,
  summarizeToolParams,
  summarizeToolResult,
  formatStageOutput,
  formatToolResult,
  formatTokens,
  formatStageLine,
  countWriteFiles,
} from '../../src/output/formatters.js';
import type { ToolCallSummary } from '@studio-foundation/engine';

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

  it('shows pattern for search tools', () => {
    expect(summarizeToolParams('search-search_codebase', { pattern: 'useState' }))
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

describe('formatStageOutput', () => {
  it('renders short strings inline', () => {
    const result = formatStageOutput({ status: 'approved' });
    expect(result).toBe('Status : approved');
  });

  it('renders numbers and booleans inline', () => {
    const result = formatStageOutput({ score: 42, passed: true });
    expect(result).toContain('Score  : 42');
    expect(result).toContain('Passed : true');
  });

  it('renders null as dash', () => {
    const result = formatStageOutput({ value: null });
    expect(result).toBe('Value : —');
  });

  it('renders undefined as dash', () => {
    const result = formatStageOutput({ value: undefined });
    expect(result).toBe('Value : —');
  });

  it('aligns keys to the longest key name', () => {
    const result = formatStageOutput({ status: 'ok', summary: 'done' });
    const lines = result.split('\n');
    // Both ':' should be at the same column
    const col0 = lines[0].indexOf(':');
    const col1 = lines[1].indexOf(':');
    expect(col0).toBe(col1);
  });

  it('renders long strings on a new line with indent', () => {
    const longStr = 'The implementation covers all the requested changes and follows the existing patterns in the codebase correctly.';
    const result = formatStageOutput({ summary: longStr });
    expect(result).toContain('Summary :');
    expect(result).toContain('\n');
    expect(result).toContain(`    ${longStr}`);
  });

  it('renders short primitive arrays inline', () => {
    const result = formatStageOutput({ tags: ['ui', 'css', 'dark-mode'] });
    expect(result).toBe('Tags : ui, css, dark-mode');
  });

  it('renders long primitive arrays vertically', () => {
    const items = Array.from({ length: 10 }, (_, i) => `very-long-tag-name-${i}`);
    const result = formatStageOutput({ tags: items });
    expect(result).toContain('Tags :');
    expect(result).toContain('    • very-long-tag-name-0');
    expect(result).toContain('    • very-long-tag-name-9');
  });

  it('renders arrays of objects with numbered indices', () => {
    const result = formatStageOutput({
      issues: [
        { title: 'Missing component', suggestion: 'Add it' },
        { title: 'Bad import', suggestion: 'Fix it' },
      ],
    });
    expect(result).toContain('Issues :');
    expect(result).toContain('    ① Missing component');
    expect(result).toContain('        Suggestion : Add it');
    expect(result).toContain('    ② Bad import');
    expect(result).toContain('        Suggestion : Fix it');
  });

  it('uses fallback numbering beyond 10 items', () => {
    const items = Array.from({ length: 11 }, (_, i) => ({ name: `item-${i}` }));
    const result = formatStageOutput({ list: items });
    expect(result).toContain('(11) item-10');
  });

  it('renders nested objects with indentation', () => {
    const result = formatStageOutput({
      details: { author: 'Alice', score: 95 },
    });
    expect(result).toContain('Details :');
    expect(result).toContain('    Author : Alice');
    expect(result).toContain('    Score  : 95');
  });

  it('falls back to compact JSON at depth > 4', () => {
    const deep = { a: { b: { c: { d: { e: 'deep' } } } } };
    const result = formatStageOutput(deep);
    // At depth 4, the innermost value should be JSON
    expect(result).toContain('{"e":"deep"}');
  });

  it('handles empty object', () => {
    expect(formatStageOutput({})).toBe('');
  });

  it('handles empty arrays', () => {
    const result = formatStageOutput({ items: [] });
    expect(result).toBe('Items : (empty)');
  });

  it('renders a realistic QA output', () => {
    const output = {
      status: 'approved_with_notes',
      summary: 'The implementation is mostly complete.',
      issues: [
        { title: 'ThemeToggle not in layout', suggestion: 'Add <ThemeToggle /> to header' },
        { title: 'localStorage not confirmed', suggestion: 'Implement retrieval logic' },
      ],
    };
    const result = formatStageOutput(output);
    expect(result).toContain('Status  : approved_with_notes');
    expect(result).toContain('Summary : The implementation is mostly complete.');
    expect(result).toContain('Issues  :');
    expect(result).toContain('    ① ThemeToggle not in layout');
    expect(result).toContain('    ② localStorage not confirmed');
  });

  it('renders arrays of objects that have a single string field as compact items', () => {
    const result = formatStageOutput({
      files_changed: [
        { path: 'src/app.ts' },
        { path: 'src/theme.ts' },
      ],
    });
    expect(result).toContain('① src/app.ts');
    expect(result).toContain('② src/theme.ts');
  });
});

describe('formatTokens', () => {
  it('returns raw number for values under 1000', () => {
    expect(formatTokens(450)).toBe('450');
  });

  it('formats thousands with one decimal', () => {
    expect(formatTokens(2100)).toBe('2.1k');
  });

  it('drops .0 for clean thousands', () => {
    expect(formatTokens(3000)).toBe('3k');
  });

  it('formats large token counts', () => {
    expect(formatTokens(17900)).toBe('17.9k');
  });

  it('formats millions', () => {
    expect(formatTokens(1234567)).toBe('1.2M');
  });

  it('returns 0 for zero', () => {
    expect(formatTokens(0)).toBe('0');
  });
});

describe('formatStageLine', () => {
  it('fills dots between name and suffix to fixed width', () => {
    const line = formatStageLine('[1/4]', 'brief-analysis', '✓ done');
    expect(line).toContain('[1/4] brief-analysis');
    expect(line).toContain('✓ done');
    expect(line).toMatch(/brief-analysis\s+\.{2,}\s+✓ done/);
  });

  it('produces consistent alignment regardless of name length', () => {
    const short = formatStageLine('[1/4]', 'qa-review', '✓');
    const long = formatStageLine('[2/4]', 'implementation-plan', '✓');
    const shortDotEnd = short.indexOf('✓');
    const longDotEnd = long.indexOf('✓');
    expect(shortDotEnd).toBe(longDotEnd);
  });

  it('handles very long stage names by using minimum dots', () => {
    const line = formatStageLine('[1/4]', 'a-very-long-stage-name-that-exceeds-normal', '✓');
    expect(line).toMatch(/\.{2,}/);
  });
});

describe('countWriteFiles', () => {
  it('returns 0 when no tool calls', () => {
    expect(countWriteFiles([])).toBe(0);
  });

  it('counts write_file tool calls', () => {
    const calls: ToolCallSummary[] = [
      { name: 'repo_manager-write_file', arguments_summary: 'a.ts' },
      { name: 'repo_manager-read_file', arguments_summary: 'b.ts' },
      { name: 'repo_manager-write_file', arguments_summary: 'c.ts' },
    ];
    expect(countWriteFiles(calls)).toBe(2);
  });

  it('counts apply_patch tool calls as file writes', () => {
    const calls: ToolCallSummary[] = [
      { name: 'repo_manager-apply_patch', arguments_summary: 'a.ts' },
    ];
    expect(countWriteFiles(calls)).toBe(1);
  });
});

describe('formatToolResult', () => {
  it('formats a plain string with indentation', () => {
    const result = formatToolResult('line1\nline2\nline3');
    expect(result).toBe('  line1\n  line2\n  line3');
  });

  it('formats a single-line string', () => {
    const result = formatToolResult('short result');
    expect(result).toBe('  short result');
  });

  it('extracts .content from read_file-style results', () => {
    const result = formatToolResult({ content: 'file content\nline 2' });
    expect(result).toBe('  file content\n  line 2');
  });

  it('formats arrays as JSON', () => {
    const result = formatToolResult(['a.ts', 'b.ts']);
    expect(result).toContain('a.ts');
    expect(result).toContain('b.ts');
  });

  it('formats objects without .content as indented JSON', () => {
    const result = formatToolResult({ written: true, path: 'src/app.ts' });
    expect(result).toContain('"written": true');
    expect(result).toContain('"path": "src/app.ts"');
  });

  it('returns "  (error)" for error strings', () => {
    const result = formatToolResult(undefined, 'file not found');
    expect(result).toBe('  (error) file not found');
  });

  it('returns "  (empty)" for null', () => {
    const result = formatToolResult(null);
    expect(result).toBe('  (empty)');
  });

  it('returns "  (empty)" for undefined without error', () => {
    const result = formatToolResult(undefined);
    expect(result).toBe('  (empty)');
  });

  it('formats object with .content as empty string', () => {
    const result = formatToolResult({ content: '' });
    expect(result).toBe('  (empty content)');
  });
});
