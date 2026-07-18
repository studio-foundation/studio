import { describe, it, expect } from 'vitest';
import { validateSchema, validateToolCalls, validateRequiredTools, validateCountedTools, validateToolGroups, compose } from '../src/validator.js';
import type { OutputContract, ToolCall } from '@studio-foundation/contracts';

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

  it('fails when array output given but object expected', () => {
    const contract: OutputContract = {
      name: 'test',
      version: 1,
      schema: { required_fields: ['summary'] }
    };

    const result = validateSchema(['not', 'an', 'object'], contract);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Expected object output, got array');
  });
});

describe('validateSchema — field-level (types, enums, nested)', () => {
  it('passes when a field matches its declared type', () => {
    const contract: OutputContract = {
      name: 'test',
      version: 1,
      schema: { fields: { count: { type: 'number' }, name: { type: 'string' } } }
    };

    const result = validateSchema({ count: 3, name: 'x' }, contract);
    expect(result.valid).toBe(true);
  });

  it('fails when a field has the wrong type', () => {
    const contract: OutputContract = {
      name: 'test',
      version: 1,
      schema: { fields: { count: { type: 'number' } } }
    };

    const result = validateSchema({ count: 'three' }, contract);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Field 'count' must be number, got string");
  });

  it('enforces integer separately from number', () => {
    const contract: OutputContract = {
      name: 'test',
      version: 1,
      schema: { fields: { n: { type: 'integer' } } }
    };

    expect(validateSchema({ n: 4 }, contract).valid).toBe(true);
    expect(validateSchema({ n: 4.5 }, contract).valid).toBe(false);
  });

  it('accepts a value in the enum', () => {
    const contract: OutputContract = {
      name: 'test',
      version: 1,
      schema: { fields: { importance: { type: 'string', enum: ['principal', 'secondary', 'figurant'] } } }
    };

    expect(validateSchema({ importance: 'secondary' }, contract).valid).toBe(true);
  });

  it('rejects a value outside the enum with the allowed set in the message', () => {
    const contract: OutputContract = {
      name: 'test',
      version: 1,
      schema: { fields: { importance: { type: 'string', enum: ['principal', 'secondary', 'figurant'] } } }
    };

    const result = validateSchema({ importance: 'lead' }, contract);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'Field \'importance\' must be one of [principal, secondary, figurant], got "lead"'
    );
  });

  it('does not check a field spec for an absent field (presence is required_fields\' job)', () => {
    const contract: OutputContract = {
      name: 'test',
      version: 1,
      schema: { fields: { importance: { type: 'string', enum: ['principal'] } } }
    };

    // importance absent → no error from fields; nothing requires it.
    expect(validateSchema({ other: 1 }, contract).valid).toBe(true);
  });

  it('validates nested required fields inside an object', () => {
    const contract: OutputContract = {
      name: 'test',
      version: 1,
      schema: { fields: { meta: { type: 'object', required_fields: ['author'] } } }
    };

    const result = validateSchema({ meta: { title: 't' } }, contract);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing required field: meta.author');
  });

  it('validates each element of an array via items, pointing at the index', () => {
    const contract: OutputContract = {
      name: 'test',
      version: 1,
      schema: {
        required_fields: ['pages'],
        fields: {
          pages: {
            type: 'array',
            items: {
              type: 'object',
              required_fields: ['title', 'importance'],
              fields: { importance: { type: 'string', enum: ['principal', 'secondary', 'figurant'] } }
            }
          }
        }
      }
    };

    const output = {
      pages: [
        { title: 'A', importance: 'principal' },
        { title: 'B', importance: 'lead' },     // bad enum
        { importance: 'secondary' }               // missing title
      ]
    };
    const result = validateSchema(output, contract);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'Field \'pages[1].importance\' must be one of [principal, secondary, figurant], got "lead"'
    );
    expect(result.errors).toContain('Missing required field: pages[2].title');
  });

  it('reports a type error at the array-field level when the value is not an array', () => {
    const contract: OutputContract = {
      name: 'test',
      version: 1,
      schema: { fields: { pages: { type: 'array', items: { type: 'object' } } } }
    };

    const result = validateSchema({ pages: 'nope' }, contract);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Field 'pages' must be array, got string");
  });

  it('combines required_fields (presence) and fields (shape)', () => {
    const contract: OutputContract = {
      name: 'test',
      version: 1,
      schema: {
        required_fields: ['status'],
        fields: { status: { type: 'string', enum: ['approved', 'rejected'] } }
      }
    };

    // present but bad value
    expect(validateSchema({ status: 'maybe' }, contract).valid).toBe(false);
    // absent → presence error
    expect(validateSchema({}, contract).errors).toContain('Missing required field: status');
    // valid
    expect(validateSchema({ status: 'approved' }, contract).valid).toBe(true);
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

  // --- maximum ---

  it('passes when successful calls are below maximum', () => {
    const result = validateToolCalls([success('1'), success('2')], { maximum: 5 });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('passes when successful calls equal maximum', () => {
    const result = validateToolCalls([success('1'), success('2'), success('3')], { maximum: 3 });
    expect(result.valid).toBe(true);
  });

  it('fails when successful calls exceed maximum', () => {
    const calls = Array.from({ length: 11 }, (_, i) => success(String(i)));
    const result = validateToolCalls(calls, { maximum: 10 });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it('error message includes actual count and maximum', () => {
    const calls = Array.from({ length: 17 }, (_, i) => success(String(i)));
    const result = validateToolCalls(calls, { maximum: 10 });
    expect(result.errors[0]).toContain('17');
    expect(result.errors[0]).toContain('10');
  });

  it('error message mentions loop', () => {
    const calls = Array.from({ length: 11 }, (_, i) => success(String(i)));
    const result = validateToolCalls(calls, { maximum: 10 });
    expect(result.errors[0]).toContain('loop');
  });

  it('maximum counts only successful calls (failed excluded)', () => {
    // 8 successful + 5 failed = 13 total, but only 8 count against maximum
    const calls = [
      ...Array.from({ length: 8 }, (_, i) => success(String(i))),
      ...Array.from({ length: 5 }, (_, i) => failed(String(i + 100))),
    ];
    const result = validateToolCalls(calls, { maximum: 9 });
    expect(result.valid).toBe(true);
  });

  it('maximum works independently of minimum', () => {
    const calls = Array.from({ length: 15 }, (_, i) => success(String(i)));
    const result = validateToolCalls(calls, { maximum: 10 });
    expect(result.valid).toBe(false);
    // minimum not set — only maximum error
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('loop');
  });

  it('minimum and maximum can both fail simultaneously', () => {
    // 5 calls, minimum=10, maximum=3 → both fail
    const calls = Array.from({ length: 5 }, (_, i) => success(String(i)));
    const result = validateToolCalls(calls, { minimum: 10, maximum: 3 });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
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
    expect(result.errors[0]).toContain('Expected at least 1 successful call');
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

  it('ANTI-THÉÂTRE: fails when counted tool calls all failed', () => {
    const toolCalls: ToolCall[] = [
      { id: '1', name: 'repo_manager-write_file', arguments: {}, error: 'permission denied' },
      { id: '2', name: 'repo_manager-write_file', arguments: {}, error: 'ENOENT' },
    ];
    const result = validateCountedTools(toolCalls, {
      minimum: 1,
      counted_tools: ['repo_manager.write_file'],
    });
    expect(result.valid).toBe(false);
  });

  it('ANTI-THÉÂTRE: excludes failed calls from counted tool count', () => {
    const toolCalls: ToolCall[] = [
      { id: '1', name: 'repo_manager-write_file', arguments: {} },          // success
      { id: '2', name: 'repo_manager-apply_patch', arguments: {}, error: 'ENOENT' }, // failed
    ];
    // 1 successful counted, 1 failed counted → total counted successful = 1
    const result = validateCountedTools(toolCalls, {
      minimum: 2,
      counted_tools: ['repo_manager.write_file', 'repo_manager.apply_patch'],
    });
    expect(result.valid).toBe(false);
  });

  it('ANTI-THÉÂTRE: passes when enough successful counted calls', () => {
    const toolCalls: ToolCall[] = [
      { id: '1', name: 'repo_manager-write_file', arguments: {} },          // success
      { id: '2', name: 'repo_manager-apply_patch', arguments: {} },          // success
      { id: '3', name: 'repo_manager-read_file', arguments: {}, error: 'ENOENT' }, // failed, not counted
    ];
    const result = validateCountedTools(toolCalls, {
      minimum: 2,
      counted_tools: ['repo_manager.write_file', 'repo_manager.apply_patch'],
    });
    expect(result.valid).toBe(true);
  });
});

describe('validateToolGroups', () => {
  const success = (id: string, name: string): ToolCall => ({ id, name, arguments: {} });
  const failed = (id: string, name: string): ToolCall => ({ id, name, arguments: {}, error: 'ENOENT' });

  it('passes when required_tool_groups is absent', () => {
    const result = validateToolGroups([], undefined);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('passes when required_tool_groups is empty array', () => {
    const result = validateToolGroups([], { required_tool_groups: [] });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('passes when a group is empty', () => {
    const result = validateToolGroups([], { required_tool_groups: [[]] });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('passes when at least one tool from the group is called successfully', () => {
    const toolCalls = [success('1', 'repo_manager-write_file')];
    const result = validateToolGroups(toolCalls, {
      required_tool_groups: [['repo_manager-write_file', 'repo_manager-apply_patch']]
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails when no tool from the group is called', () => {
    const toolCalls = [success('1', 'repo_manager-read_file')];
    const result = validateToolGroups(toolCalls, {
      required_tool_groups: [['repo_manager-write_file', 'repo_manager-apply_patch']]
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('repo_manager-write_file');
    expect(result.errors[0]).toContain('repo_manager-apply_patch');
  });

  it('ANTI-THÉÂTRE: fails when group tool called but all calls failed', () => {
    const toolCalls = [
      failed('1', 'repo_manager-write_file'),
      failed('2', 'repo_manager-apply_patch'),
    ];
    const result = validateToolGroups(toolCalls, {
      required_tool_groups: [['repo_manager-write_file', 'repo_manager-apply_patch']]
    });
    expect(result.valid).toBe(false);
  });

  it('passes when second tool from group is called successfully (OR semantics)', () => {
    const toolCalls = [success('1', 'repo_manager-apply_patch')];
    const result = validateToolGroups(toolCalls, {
      required_tool_groups: [['repo_manager-write_file', 'repo_manager-apply_patch']]
    });
    expect(result.valid).toBe(true);
  });

  it('each group is independent: all must be satisfied', () => {
    // Group 1 satisfied, group 2 not
    const toolCalls = [success('1', 'repo_manager-write_file')];
    const result = validateToolGroups(toolCalls, {
      required_tool_groups: [
        ['repo_manager-write_file', 'repo_manager-apply_patch'],
        ['shell-run_command']
      ]
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('shell-run_command');
  });

  it('passes when all groups are satisfied', () => {
    const toolCalls = [
      success('1', 'repo_manager-write_file'),
      success('2', 'shell-run_command'),
    ];
    const result = validateToolGroups(toolCalls, {
      required_tool_groups: [
        ['repo_manager-write_file', 'repo_manager-apply_patch'],
        ['shell-run_command']
      ]
    });
    expect(result.valid).toBe(true);
  });

  it('fails when multiple groups are not satisfied', () => {
    const toolCalls = [success('1', 'repo_manager-read_file')];
    const result = validateToolGroups(toolCalls, {
      required_tool_groups: [
        ['repo_manager-write_file'],
        ['shell-run_command']
      ]
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
  });

  it('normalizes tool names (dots vs hyphens)', () => {
    const toolCalls = [success('1', 'repo_manager-write_file')];
    const result = validateToolGroups(toolCalls, {
      required_tool_groups: [['repo_manager.write_file']]
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
