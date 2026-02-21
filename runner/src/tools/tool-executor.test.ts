import { describe, it, expect, vi } from 'vitest';
import { ToolExecutor } from './tool-executor.js';
import { ToolRegistry } from './tool-registry.js';

function makeRegistry(paramSchema: Record<string, unknown>): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: 'test-tool',
    description: 'A test tool',
    parameters: paramSchema,
    execute: vi.fn().mockResolvedValue({ success: true, output: 'ok' }),
  });
  return registry;
}

const SCHEMA_WITH_REQUIRED = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Search query' },
  },
  required: ['query'],
};

const SCHEMA_NO_REQUIRED = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Search query' },
  },
};

describe('ToolExecutor — argument validation', () => {
  it('returns error for missing required parameter', async () => {
    const executor = new ToolExecutor(makeRegistry(SCHEMA_WITH_REQUIRED));
    const result = await executor.execute({
      id: '1',
      name: 'test-tool',
      arguments: {},
    });
    expect(result.error).toMatch(/missing required parameter.*query/);
    expect(result.result).toBeUndefined();
  });

  it('returns error for unknown parameter', async () => {
    const executor = new ToolExecutor(makeRegistry(SCHEMA_WITH_REQUIRED));
    const result = await executor.execute({
      id: '2',
      name: 'test-tool',
      arguments: { query: 'hello', pattern: 'oops' },
    });
    expect(result.error).toMatch(/unknown parameter.*pattern/);
    expect(result.error).toMatch(/declared: query/);
    expect(result.result).toBeUndefined();
  });

  it('executes successfully with correct required parameters', async () => {
    const registry = makeRegistry(SCHEMA_WITH_REQUIRED);
    const executor = new ToolExecutor(registry);
    const result = await executor.execute({
      id: '3',
      name: 'test-tool',
      arguments: { query: 'ramen' },
    });
    expect(result.error).toBeUndefined();
    expect(result.result).toBe('ok');
  });

  it('executes successfully with no required parameters and empty args', async () => {
    const executor = new ToolExecutor(makeRegistry(SCHEMA_NO_REQUIRED));
    const result = await executor.execute({
      id: '4',
      name: 'test-tool',
      arguments: {},
    });
    expect(result.error).toBeUndefined();
    expect(result.result).toBe('ok');
  });

  it('executes successfully with optional parameter provided', async () => {
    const executor = new ToolExecutor(makeRegistry(SCHEMA_NO_REQUIRED));
    const result = await executor.execute({
      id: '5',
      name: 'test-tool',
      arguments: { query: 'ramen' },
    });
    expect(result.error).toBeUndefined();
    expect(result.result).toBe('ok');
  });
});
