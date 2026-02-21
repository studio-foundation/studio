import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '../tools/tool-registry.js';
import type { MCPServerDef } from './plugin-loader.js';

export class MCPClient {
  private client: Client;
  private transport: StdioClientTransport;

  constructor(
    private pluginName: string,
    private serverName: string,
    private def: MCPServerDef
  ) {
    const env = this.resolveEnv(def.env ?? {});
    this.transport = new StdioClientTransport({
      command: def.command,
      args: def.args ?? [],
      env: { ...process.env, ...env } as Record<string, string>,
    });
    this.client = new Client(
      { name: 'studio', version: '1.0.0' },
      { capabilities: {} }
    );
  }

  toolPrefix(): string {
    return `${this.pluginName}-${this.serverName}`;
  }

  /** Resolves ${VAR_NAME} placeholders from process.env. */
  resolveEnv(env: Record<string, string>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, val] of Object.entries(env)) {
      result[key] = val.replace(/\$\{([^}]+)\}/g, (_, v: string) => {
        if (process.env[v] === undefined) {
          console.warn(`Warning: env var '${v}' not set (referenced in MCP server config for plugin '${this.pluginName}')`);
        }
        return process.env[v] ?? '';
      });
    }
    return result;
  }

  async start(): Promise<void> {
    await this.client.connect(this.transport);
  }

  async getTools(): Promise<Tool[]> {
    const { tools } = await this.client.listTools();
    const prefix = this.toolPrefix();

    return tools.map((t) => ({
      name: `${prefix}-${t.name}`,
      description: t.description ?? '',
      parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
      execute: async (args: Record<string, unknown>) => {
        try {
          const result = await this.client.callTool({ name: t.name, arguments: args });
          // Extract text content from MCP result (filter out images/resources for now)
          const rawContent = result.content as Array<{ type: string; text?: string }>;
          const text = (rawContent ?? [])
            .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
            .map((c) => c.text)
            .join('\n');
          return { success: true, output: text || JSON.stringify(result.content) };
        } catch (err) {
          return {
            success: false,
            output: null,
            error: (err as Error).message,
          };
        }
      },
    }));
  }

  async close(): Promise<void> {
    try {
      await this.client.close();
    } catch {
      // Ignore close errors — process may have already exited
    }
  }
}
