/**
 * Tool registry - manages tool definitions and execution
 */

import { ToolDefinition } from '@studio-foundation/contracts';

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
   * All tools belonging to a plugin (by its registered plugin name).
   */
  private toolsForPlugin(pluginName: string): Tool[] {
    const result: Tool[] = [];
    for (const tool of this.tools.values()) {
      if (this.toolToPlugin.get(normalizeToolName(tool.name)) === pluginName) {
        result.push(tool);
      }
    }
    return result;
  }

  /** Copy a tool plus its plugin snippet metadata into `target`. */
  private copyTool(tool: Tool, target: ToolRegistry): void {
    target.register(tool);
    const pluginName = this.toolToPlugin.get(normalizeToolName(tool.name));
    if (pluginName) {
      target.toolToPlugin.set(normalizeToolName(tool.name), pluginName);
      const snippet = this.pluginSnippets.get(pluginName);
      if (snippet) target.pluginSnippets.set(pluginName, snippet);
    }
  }

  /**
   * Create a new registry filtered to specific tool names.
   *
   * A whitelist entry resolves in this order:
   *  1. an exact tool name — dots normalized to hyphens, so both
   *     "repo_manager.write_file" and "repo_manager-write_file" match;
   *  2. a plugin name — expands to every command of that plugin, so an
   *     agent can whitelist "repo_manager" to get all "repo_manager-*" tools.
   *
   * An entry that matches neither is a hard error, never a silent drop: a
   * dropped whitelist entry leaves the agent quietly missing a tool it was
   * meant to have. An empty whitelist yields an empty registry (no error).
   */
  filter(allowedTools: string[], opts?: { agentName?: string }): ToolRegistry {
    const filtered = new ToolRegistry();
    for (const name of allowedTools) {
      const exact = this.tools.get(name) ?? this.tools.get(normalizeToolName(name));
      if (exact) {
        this.copyTool(exact, filtered);
        continue;
      }

      const pluginTools = this.toolsForPlugin(name);
      if (pluginTools.length > 0) {
        for (const tool of pluginTools) this.copyTool(tool, filtered);
        continue;
      }

      const where = opts?.agentName ? ` for agent '${opts.agentName}'` : '';
      throw new Error(
        `Unknown tool or plugin '${name}'${where}. ` +
        `Available: ${this.availableNames().join(', ') || '(none registered)'}.`
      );
    }
    return filtered;
  }

  /** Full tool names plus distinct plugin names, for error messages. */
  private availableNames(): string[] {
    const names = new Set<string>(this.tools.keys());
    for (const plugin of this.toolToPlugin.values()) names.add(plugin);
    return Array.from(names).sort();
  }

  /**
   * Create a full copy of this registry (all tools + plugin metadata).
   */
  clone(): ToolRegistry {
    return this.filter(Array.from(this.tools.keys()));
  }
}
