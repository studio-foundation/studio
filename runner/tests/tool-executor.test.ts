/**
 * Tool executor tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ToolExecutor } from '../src/tools/tool-executor.js';
import { ToolRegistry, type Tool } from '../src/tools/tool-registry.js';

describe('ToolExecutor', () => {
  let registry: ToolRegistry;
  let executor: ToolExecutor;

  beforeEach(() => {
    registry = new ToolRegistry();
    executor = new ToolExecutor(registry);
  });

  it('should execute a successful tool call', async () => {
    // Register a test tool
    const testTool: Tool = {
      name: 'test_tool',
      description: 'A test tool',
      parameters: {
        type: 'object',
        properties: { foo: { type: 'string' } },
      },
      execute: async (args) => ({
        success: true,
        output: { result: 'hello world', args }
      })
    };
    registry.register(testTool);

    // Execute the tool
    const result = await executor.execute({
      id: 'test-1',
      name: 'test_tool',
      arguments: { foo: 'bar' }
    });

    expect(result).toEqual({
      id: 'test-1',
      name: 'test_tool',
      arguments: { foo: 'bar' },
      result: { result: 'hello world', args: { foo: 'bar' } }
    });
  });

  it('should handle tool not found', async () => {
    const result = await executor.execute({
      id: 'test-1',
      name: 'unknown_tool',
      arguments: {}
    });

    expect(result).toEqual({
      id: 'test-1',
      name: 'unknown_tool',
      arguments: {},
      error: 'Tool not found: unknown_tool'
    });
  });

  it('should handle tool execution failure', async () => {
    const failingTool: Tool = {
      name: 'failing_tool',
      description: 'A tool that fails',
      parameters: {},
      execute: async () => ({
        success: false,
        output: null,
        error: 'Something went wrong'
      })
    };
    registry.register(failingTool);

    const result = await executor.execute({
      id: 'test-1',
      name: 'failing_tool',
      arguments: {}
    });

    expect(result).toEqual({
      id: 'test-1',
      name: 'failing_tool',
      arguments: {},
      error: 'Something went wrong'
    });
  });

  it('should handle tool that throws exception', async () => {
    const throwingTool: Tool = {
      name: 'throwing_tool',
      description: 'A tool that throws',
      parameters: {},
      execute: async () => {
        throw new Error('Unexpected error');
      }
    };
    registry.register(throwingTool);

    const result = await executor.execute({
      id: 'test-1',
      name: 'throwing_tool',
      arguments: {}
    });

    expect(result).toEqual({
      id: 'test-1',
      name: 'throwing_tool',
      arguments: {},
      error: 'Unexpected error'
    });
  });
});
