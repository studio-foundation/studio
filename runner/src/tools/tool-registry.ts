/**
 * Tool registry - manages tool definitions and execution
 */

import { ToolDefinition } from '@studio/contracts';

/** Normalize tool name: dots → hyphens so both conventions work */
export function normalizeToolName(name: string): string {
  return name.replace(/\./g, '-');
}

export interface ToolResult {
  success: boolean;
  output: unknown;
  error?: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  /**
   * Register a tool
   */
  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Get tool by name
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * Check if tool exists
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * List all tools
   */
  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Convert tools to LLM tool definitions format
   */
  toToolDefinitions(): ToolDefinition[] {
    return this.list().map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }));
  }

  /**
   * Create a new registry filtered to specific tool names.
   * Normalizes dots to hyphens so both "repo_manager.write_file"
   * and "repo_manager-write_file" match the registered name.
   */
  filter(allowedTools: string[]): ToolRegistry {
    const filtered = new ToolRegistry();
    for (const toolName of allowedTools) {
      const tool = this.tools.get(toolName)
        ?? this.tools.get(normalizeToolName(toolName));
      if (tool) {
        filtered.register(tool);
      }
    }
    return filtered;
  }
}
