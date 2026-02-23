import { describe, it, expect } from 'vitest';
import { validateSchema, validateToolCalls, validateRequiredTools, validateCountedTools, compose } from '../src/validator.js';
import type { OutputContract, ToolCall } from '@studio/contracts';

describe('validateSchema', () => {
  it('passes when all required fields present', () => {
    const contract: OutputContract = {
      name: 'test',
      version: 1,
      schema: { required_fields: ['summary', 'status'] }
    };

    const output = { summary: 'Done', status: 'success' };
    const result = validateSchema(output, contract);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails when required field missing', () => {
    const contract: OutputContract = {
      name: 'test',
      version: 1,
      schema: { required_fields: ['summary', 'status'] }
    };

    const output = { summary: 'Done' }; // missing status
    const result = validateSchema(output, contract);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing required field: status');
  });

  it('fails when multiple required fields missing', () => {
    const contract: OutputContract = {
      name: 'test',
      version: 1,
      schema: { required_fields: ['summary', 'status', 'files'] }
    };

    const output = { summary: 'Done' }; // missing status and files
    const result = validateSchema(output, contract);

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(result.errors).toContain('Missing required field: status');
    expect(result.errors).toContain('Missing required field: files');
  });

  it('passes when no schema defined', () => {
    const contract: OutputContract = {
      name: 'test',
      version: 1
    };

    const output = { anything: 'goes' };
    const result = validateSchema(output, contract);

    expect(result.valid).toBe(true);
  });

  it('passes when schema has no required_fields', () => {
    const contract: OutputContract = {
      name: 'test',
      version: 1,
      schema: {}
    };

    const output = { anything: 'goes' };
    const result = validateSchema(output, contract);

    expect(result.valid).toBe(true);
  });

  it('passes when extra fields present', () => {
    const contract: OutputContract = {
      name: 'test',
      version: 1,
      schema: { required_fields: ['summary'] }
    };

    const output = { summary: 'Done', extra: 'field', another: 'one' };
    const result = validateSchema(output, contract);

    expect(result.valid).toBe(true);
  });
});

describe('validateToolCalls', () => {
  const success = (id: string): ToolCall => ({ id, name: 'some_tool', arguments: {} });
  const failed = (id: string): ToolCall => ({ id, name: 'some_tool', arguments: {}, error: 'ENOENT' });

  it('passes when successful calls meet minimum', () => {
    const result = validateToolCalls([success('1'), success('2'), success('3')], { minimum: 2 });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('passes when exactly at minimum', () => {
    const result = validateToolCalls([success('1'), success('2')], { minimum: 2 });
    expect(result.valid).toBe(true);
  });

  it('fails when below minimum', () => {
    const result = validateToolCalls([], { minimum: 1 });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Expected at least 1 successful tool call');
  });

  it('ANTI-THÉÂTRE: fails when all calls failed', () => {
    const result = validateToolCalls([failed('1'), failed('2'), failed('3')], { minimum: 1 });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('got 0 successful');
  });

  it('ANTI-THÉÂTRE: excludes failed calls from count', () => {
    // 1 successful + 2 failed → only 1 counts
    const result = validateToolCalls([success('1'), failed('2'), failed('3')], { minimum: 2 });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('got 1 successful');
  });

  it('ANTI-THÉÂTRE: passes when 1 successful + 2 failed and minimum is 1', () => {
    const result = validateToolCalls([success('1'), failed('2'), failed('3')], { minimum: 1 });
    expect(result.valid).toBe(true);
  });

  it('error message mentions failed count when calls were excluded', () => {
    const result = validateToolCalls([failed('1'), failed('2')], { minimum: 1 });
    expect(result.errors[0]).toContain('2 failed excluded');
  });

  it('error message omits excluded count when zero failed calls', () => {
    const result = validateToolCalls([], { minimum: 1 });
    expect(result.errors[0]).not.toContain('excluded');
  });

  it('uses correct pluralization for singular minimum', () => {
    const result = validateToolCalls([], { minimum: 1 });
    expect(result.errors[0]).toContain('tool call,'); // singular — "tool call, got"
  });

  it('uses correct pluralization for plural minimum', () => {
    const result = validateToolCalls([], { minimum: 3 });
    expect(result.errors[0]).toContain('tool calls,'); // plural
  });

  it('passes when no requirements specified', () => {
    const result = validateToolCalls([]);
    expect(result.valid).toBe(true);
  });

  it('passes when requirements is empty object', () => {
    const result = validateToolCalls([], {});
    expect(result.valid).toBe(true);
  });
});

describe('validateRequiredTools', () => {
  it('passes when all required tools called', () => {
    const toolCalls: ToolCall[] = [
      { id: '1', name: 'write_file', arguments: {} },
      { id: '2', name: 'read_file', arguments: {} }
    ];

    const result = validateRequiredTools(toolCalls, {
      required_tools: ['write_file', 'read_file']
    });

    expect(result.valid).toBe(true);
  });

  it('fails when required tool not called', () => {
    const toolCalls: ToolCall[] = [
      { id: '1', name: 'read_file', arguments: {} }
    ];

    const result = validateRequiredTools(toolCalls, {
      required_tools: ['write_file', 'read_file']
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Required tool 'write_file' was not called");
  });

  it('fails when multiple required tools not called', () => {
    const toolCalls: ToolCall[] = [
      { id: '1', name: 'other_tool', arguments: {} }
    ];

    const result = validateRequiredTools(toolCalls, {
      required_tools: ['write_file', 'read_file']
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(result.errors).toContain("Required tool 'write_file' was not called");
    expect(result.errors).toContain("Required tool 'read_file' was not called");
  });

  it('passes when extra tools called', () => {
    const toolCalls: ToolCall[] = [
      { id: '1', name: 'write_file', arguments: {} },
      { id: '2', name: 'read_file', arguments: {} },
      { id: '3', name: 'extra_tool', arguments: {} }
    ];

    const result = validateRequiredTools(toolCalls, {
      required_tools: ['write_file']
    });

    expect(result.valid).toBe(true);
  });

  it('passes when same tool called multiple times', () => {
    const toolCalls: ToolCall[] = [
      { id: '1', name: 'write_file', arguments: { file: 'a.txt' } },
      { id: '2', name: 'write_file', arguments: { file: 'b.txt' } }
    ];

    const result = validateRequiredTools(toolCalls, {
      required_tools: ['write_file']
    });

    expect(result.valid).toBe(true);
  });

  it('passes when no required tools specified', () => {
    const toolCalls: ToolCall[] = [];
    const result = validateRequiredTools(toolCalls);
    expect(result.valid).toBe(true);
  });

  it('passes when required_tools is empty array', () => {
    const toolCalls: ToolCall[] = [];
    const result = validateRequiredTools(toolCalls, { required_tools: [] });
    expect(result.valid).toBe(true);
  });

  it('ANTI-THÉÂTRE: fails when required tool called but all calls failed', () => {
    const toolCalls: ToolCall[] = [
      { id: '1', name: 'write_file', arguments: {}, error: 'permission denied' },
      { id: '2', name: 'write_file', arguments: {}, error: 'ENOENT' },
    ];
    const result = validateRequiredTools(toolCalls, { required_tools: ['write_file'] });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("'write_file'");
    expect(result.errors[0]).toContain('no successful calls');
  });

  it('ANTI-THÉÂTRE: passes when required tool has at least one successful call', () => {
    const toolCalls: ToolCall[] = [
      { id: '1', name: 'write_file', arguments: {}, error: 'ENOENT' },
      { id: '2', name: 'write_file', arguments: {} }, // success
    ];
    const result = validateRequiredTools(toolCalls, { required_tools: ['write_file'] });
    expect(result.valid).toBe(true);
  });

  it('ANTI-THÉÂTRE: error distinguishes never-called from all-failed', () => {
    const toolCalls: ToolCall[] = [
      { id: '1', name: 'write_file', arguments: {}, error: 'ENOENT' },
    ];
    // write_file was called but all failed — different error than "was not called"
    const result = validateRequiredTools(toolCalls, { required_tools: ['write_file', 'read_file'] });
    expect(result.errors).toHaveLength(2);
    // write_file: called but all failed
    expect(result.errors.some(e => e.includes('write_file') && e.includes('no successful calls'))).toBe(true);
    // read_file: never called
    expect(result.errors.some(e => e.includes('read_file') && e.includes('was not called'))).toBe(true);
  });
});

describe('validateCountedTools', () => {
  it('passes when enough counted tool calls are made', () => {
    const toolCalls: ToolCall[] = [
      { id: '1', name: 'repo_manager-apply_patch', arguments: {} },
    ];
    const result = validateCountedTools(toolCalls, {
      minimum: 1,
      counted_tools: ['repo_manager.write_file', 'repo_manager.apply_patch'],
    });
    expect(result.valid).toBe(true);
  });

  it('passes with mix of counted tools meeting minimum', () => {
    const toolCalls: ToolCall[] = [
      { id: '1', name: 'repo_manager-write_file', arguments: {} },
      { id: '2', name: 'repo_manager-apply_patch', arguments: {} },
    ];
    const result = validateCountedTools(toolCalls, {
      minimum: 1,
      counted_tools: ['repo_manager.write_file', 'repo_manager.apply_patch'],
    });
    expect(result.valid).toBe(true);
  });

  it('fails when no counted tools are called', () => {
    const toolCalls: ToolCall[] = [
      { id: '1', name: 'repo_manager-read_file', arguments: {} },
    ];
    const result = validateCountedTools(toolCalls, {
      minimum: 1,
      counted_tools: ['repo_manager.write_file', 'repo_manager.apply_patch'],
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Expected at least 1 call');
  });

  it('passes when no counted_tools specified', () => {
    const toolCalls: ToolCall[] = [];
    const result = validateCountedTools(toolCalls, {});
    expect(result.valid).toBe(true);
  });

  it('normalizes tool names (dots vs hyphens)', () => {
    const toolCalls: ToolCall[] = [
      { id: '1', name: 'repo_manager-apply_patch', arguments: {} },
    ];
    const result = validateCountedTools(toolCalls, {
      minimum: 1,
      counted_tools: ['repo_manager.apply_patch'],
    });
    expect(result.valid).toBe(true);
  });
});

describe('compose', () => {
  it('returns valid when all validators pass', async () => {
    const v1 = () => ({ valid: true, errors: [], warnings: [] });
    const v2 = () => ({ valid: true, errors: [], warnings: [] });

    const combined = compose(v1, v2);
    const result = await combined('anything');

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns invalid when any validator fails', async () => {
    const v1 = () => ({ valid: true, errors: [], warnings: [] });
    const v2 = () => ({ valid: false, errors: ['v2 failed'], warnings: [] });

    const combined = compose(v1, v2);
    const result = await combined('anything');

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('v2 failed');
  });

  it('returns invalid when all validators fail', async () => {
    const v1 = () => ({ valid: false, errors: ['v1 failed'], warnings: [] });
    const v2 = () => ({ valid: false, errors: ['v2 failed'], warnings: [] });

    const combined = compose(v1, v2);
    const result = await combined('anything');

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(result.errors).toContain('v1 failed');
    expect(result.errors).toContain('v2 failed');
  });

  it('concatenates all errors', async () => {
    const v1 = () => ({ valid: false, errors: ['error A', 'error B'], warnings: [] });
    const v2 = () => ({ valid: false, errors: ['error C'], warnings: [] });

    const combined = compose(v1, v2);
    const result = await combined('anything');

    expect(result.errors).toEqual(['error A', 'error B', 'error C']);
  });

  it('concatenates all warnings', async () => {
    const v1 = () => ({ valid: true, errors: [], warnings: ['warn A'] });
    const v2 = () => ({ valid: true, errors: [], warnings: ['warn B', 'warn C'] });

    const combined = compose(v1, v2);
    const result = await combined('anything');

    expect(result.warnings).toEqual(['warn A', 'warn B', 'warn C']);
  });

  it('supports async validators', async () => {
    const v1 = async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
      return { valid: true, errors: [], warnings: [] };
    };
    const v2 = () => ({ valid: true, errors: [], warnings: [] });

    const combined = compose(v1, v2);
    const result = await combined('anything');

    expect(result.valid).toBe(true);
  });

  it('works with single validator', async () => {
    const v1 = () => ({ valid: true, errors: [], warnings: [] });

    const combined = compose(v1);
    const result = await combined('anything');

    expect(result.valid).toBe(true);
  });

  it('works with three or more validators', async () => {
    const v1 = () => ({ valid: true, errors: [], warnings: [] });
    const v2 = () => ({ valid: false, errors: ['error 2'], warnings: [] });
    const v3 = () => ({ valid: true, errors: [], warnings: [] });

    const combined = compose(v1, v2, v3);
    const result = await combined('anything');

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(['error 2']);
  });
});
