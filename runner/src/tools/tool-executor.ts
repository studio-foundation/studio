import { ToolCall } from '@studio-foundation/contracts';
import { ToolRegistry } from './tool-registry.js';

/**
 * Validate LLM-provided arguments against the tool's JSON Schema.
 * Returns an error string if invalid, null if OK.
 */
function validateArgs(
  toolName: string,
  schema: Record<string, unknown>,
  args: Record<string, unknown>
): string | null {
  const properties = (schema.properties as Record<string, unknown> | undefined) ?? {};
  const required = (schema.required as string[] | undefined) ?? [];
  const declared = new Set(Object.keys(properties));

  const missing = required.filter(p => !(p in args));
  if (missing.length > 0) {
    return `Tool ${toolName}: missing required parameter${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`;
  }

  const unknown = Object.keys(args).filter(p => !declared.has(p));
  if (unknown.length > 0) {
    return `Tool ${toolName}: unknown parameter${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')} (declared: ${[...declared].join(', ')})`;
  }

  return null;
}

export class ToolExecutor {
  constructor(private registry: ToolRegistry) {}

  async execute(toolCall: { id: string; name: string; arguments: Record<string, unknown> }): Promise<ToolCall> {
    const tool = this.registry.get(toolCall.name);

    if (!tool) {
      return {
        id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
        error: `Tool not found: ${toolCall.name}`
      };
    }

    // Validate arguments against the tool's parameter schema
    const validationError = validateArgs(toolCall.name, tool.parameters, toolCall.arguments);
    if (validationError) {
      return {
        id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
        error: validationError,
      };
    }

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
