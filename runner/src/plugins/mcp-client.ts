import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Tool } from '../tools/tool-registry.js';
import type { MCPServerDef } from './plugin-loader.js';
import { StudioOAuthProvider } from './oauth-provider.js';

export class MCPClient {
  private client: Client;
  private transport: StdioClientTransport | StreamableHTTPClientTransport;
  oauthProvider: StudioOAuthProvider | undefined;

  constructor(
    private pluginName: string,
    private serverName: string,
    private def: MCPServerDef
  ) {
    if (def.type === 'http') {
      if (def.auth?.type === 'oauth') {
        this.oauthProvider = new StudioOAuthProvider(def.url);
        this.transport = new StreamableHTTPClientTransport(new URL(def.url), {
          authProvider: this.oauthProvider,
        });
      } else {
        const headers = this.resolveEnv(def.headers ?? {});
        this.transport = new StreamableHTTPClientTransport(new URL(def.url), {
          requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
        });
      }
    } else {
      const env = this.resolveEnv(def.env ?? {});
      this.transport = new StdioClientTransport({
        command: def.command,
        args: def.args ?? [],
        env: { ...process.env, ...env } as Record<string, string>,
      });
    }
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
    // ... implementation here
    return env;
  }
}