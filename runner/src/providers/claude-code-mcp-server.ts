import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@studio-foundation/contracts';
import type { AgentLoopResult, ToolCallOutcome } from './provider.js';

export class ClaudeCodeMcpServer {
  private server: Server | null = null;
  private readonly completedToolCalls: AgentLoopResult['tool_calls'] = [];

  constructor(
    private readonly tools: ToolDefinition[],
    private readonly executeTool: (
      name: string,
      args: Record<string, unknown>,
      callId: string
    ) => Promise<ToolCallOutcome>
  ) {}

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res).catch(err => {
          res.writeHead(500);
          res.end(JSON.stringify({ error: String(err) }));
        });
      });
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (!addr || typeof addr === 'string') return reject(new Error('Bad address'));
        resolve(addr.port);
      });
      this.server.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  getToolCalls(): AgentLoopResult['tool_calls'] {
    return this.completedToolCalls;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }

    const body = await readBody(req);
    const rpc = JSON.parse(body) as {
      jsonrpc: string;
      id?: number | string;
      method: string;
      params?: unknown;
    };

    // Notifications: no id OR method starts with "notifications/" — respond with null
    if (rpc.id === undefined || rpc.method.startsWith('notifications/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('null');
      return;
    }

    const result = await this.dispatch(rpc.method, rpc.params);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, ...result }));
  }

  private async dispatch(
    method: string,
    params: unknown
  ): Promise<{ result: unknown } | { error: { code: number; message: string } }> {
    if (method === 'initialize') {
      return {
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'studio', version: '1.0' },
        },
      };
    }

    if (method === 'tools/list') {
      return {
        result: {
          tools: this.tools.map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.parameters,
          })),
        },
      };
    }

    if (method === 'tools/call') {
      const p = params as { name: string; arguments: Record<string, unknown> };
      const callId = randomUUID();
      const outcome = await this.executeTool(p.name, p.arguments, callId);

      this.completedToolCalls.push({
        id: callId,
        name: p.name,
        arguments: p.arguments,
        ...(outcome.error ? { error: outcome.error } : { result: outcome.result }),
      });

      if (outcome.error) {
        return {
          result: {
            content: [{ type: 'text', text: `Error: ${outcome.error}` }],
            isError: true,
          },
        };
      }
      return {
        result: {
          content: [{ type: 'text', text: JSON.stringify(outcome.result) }],
        },
      };
    }

    return { error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}
