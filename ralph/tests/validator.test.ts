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
  it('passes when minimum met', () => {
    const result = validateToolCalls(3, { minimum: 2 });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('passes when exactly at minimum', () => {
    const result = validateToolCalls(2, { minimum: 2 });
    expect(result.valid).toBe(true);
  });

  it('fails when below minimum', () => {
    const result = validateToolCalls(0, { minimum: 1 });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Expected at least 1 tool call, got 0');
  });

  it('uses correct pluralization for singular', () => {
    const result = validateToolCalls(0, { minimum: 1 });
    expect(result.errors[0]).toContain('tool call'); // singular
  });

  it('uses correct pluralization for plural', () => {
    const result = validateToolCalls(0, { minimum: 3 });
    expect(result.errors[0]).toContain('tool calls'); // plural
  });

  it('passes when no requirements specified', () => {
    const result = validateToolCalls(0);
    expect(result.valid).toBe(true);
  });

  it('passes when requirements is empty object', () => {
    const result = validateToolCalls(0, {});
    expect(result.valid).toBe(true);
  });

  it('ANTI-THÉÂTRE: fails when tool_calls is 0 despite output claiming work done', () => {
    // This is THE critical test - detecting agent "theater"
    const toolCallCount = 0; // Agent made zero real tool calls

    const validation = validateToolCalls(toolCallCount, { minimum: 1 });

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain('Expected at least 1 tool call, got 0');
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
