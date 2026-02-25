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
  private toolToPlugin: Map<string, string> = new Map();   // normalized name → plugin name
  private pluginSnippets: Map<string, string> = new Map(); // plugin name → snippet

  /**
   * Register a single tool (no plugin metadata).
   */
  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Register all tools belonging to a plugin.
   * If promptSnippet is provided it will be returned by getActiveSnippets()
   * whenever any tool from this plugin is in the registry.
   */
  registerPlugin(pluginName: string, tools: Tool[], promptSnippet?: string): void {
    for (const tool of tools) {
      this.register(tool);
      this.toolToPlugin.set(normalizeToolName(tool.name), pluginName);
    }
    if (promptSnippet) {
      this.pluginSnippets.set(pluginName, promptSnippet);
    }
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
   * Return prompt snippets for all plugins that have at least one tool
   * currently in this registry.
   */
  getActiveSnippets(): string[] {
    const activePlugins = new Set<string>();
    for (const toolName of this.tools.keys()) {
      const plugin = this.toolToPlugin.get(normalizeToolName(toolName));
      if (plugin) activePlugins.add(plugin);
    }
    return Array.from(activePlugins)
      .map(p => this.pluginSnippets.get(p))
      .filter((s): s is string => s !== undefined);
  }

  /**
   * Create a new registry filtered to specific tool names.
   * Normalizes dots to hyphens so both "repo_manager.write_file"
   * and "repo_manager-write_file" match the registered name.
   * Plugin snippet metadata is carried over for included tools.
   */
  filter(allowedTools: string[]): ToolRegistry {
    const filtered = new ToolRegistry();
    for (const toolName of allowedTools) {
      const tool = this.tools.get(toolName)
        ?? this.tools.get(normalizeToolName(toolName));
      if (tool) {
        filtered.register(tool);
        // Carry over plugin metadata so getActiveSnippets() works on filtered registry
        const pluginName = this.toolToPlugin.get(normalizeToolName(tool.name));
        if (pluginName) {
          filtered.toolToPlugin.set(normalizeToolName(tool.name), pluginName);
          const snippet = this.pluginSnippets.get(pluginName);
          if (snippet) filtered.pluginSnippets.set(pluginName, snippet);
        }
      }
    }
    return filtered;
  }

  /**
   * Create a full copy of this registry (all tools + plugin metadata).
   */
  clone(): ToolRegistry {
    return this.filter(Array.from(this.tools.keys()));
  }
}
