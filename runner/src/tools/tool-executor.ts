/**
 * Tool executor - executes tool calls from LLM responses
 */

import { ToolCall } from '@studio/contracts';
import { ToolRegistry } from './tool-registry.js';

export class ToolExecutor {
  constructor(private registry: ToolRegistry) {}

  /**
   * Execute a single tool call and return a complete ToolCall with result
   */
  async execute(toolCall: { id: string; name: string; arguments: Record<string, unknown> }): Promise<ToolCall> {
    // Find tool in registry
    const tool = this.registry.get(toolCall.name);

    if (!tool) {
      return {
        id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
        error: `Tool not found: ${toolCall.name}`
      };
    }

    // Execute tool and handle errors
    try {
      const toolResult = await tool.execute(toolCall.arguments);

      if (!toolResult.success) {
        return {
          id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments,
          error: toolResult.error || 'Tool execution failed'
        };
      }

      return {
        id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
        result: toolResult.output
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
        error: errorMessage
      };
    }
  }
}
