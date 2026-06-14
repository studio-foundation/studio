import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClaudeCodeMcpServer } from './claude-code-mcp-server.js';
import type { ToolCallOutcome } from './provider.js';

const TOOLS = [
  {
    name: 'repo_manager-read_file',
    description: 'Read a file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function jsonRpc(port: number, method: string, params: unknown, id: number | undefined = 1): Promise<any> {
  const body: Record<string, unknown> = { jsonrpc: '2.0', method, params };
  if (id !== undefined) body.id = id;
  const res = await fetch(`http://127.0.0.1:${port}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return res.json();
}

describe('ClaudeCodeMcpServer', () => {
  let server: ClaudeCodeMcpServer;
  let executeTool: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    executeTool = vi.fn();
    server = new ClaudeCodeMcpServer(
      TOOLS,
      executeTool as (name: string, args: Record<string, unknown>, callId: string) => Promise<ToolCallOutcome>
    );
  });

  afterEach(async () => {
    await server.stop();
  });

  it('starts and returns a port number', async () => {
    const port = await server.start();
    expect(port).toBeGreaterThan(1024);
    expect(port).toBeLessThan(65536);
  });

  it('responds to initialize with server capabilities', async () => {
    const port = await server.start();
    const res = await jsonRpc(port, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'claude', version: '1.0' },
    });
    expect(res.result.capabilities).toBeDefined();
    expect(res.result.serverInfo.name).toBe('studio');
  });

  it('responds to notifications/initialized (no id) with null', async () => {
    const port = await server.start();
    const res = await jsonRpc(port, 'notifications/initialized', {}, undefined);
    expect(res).toBeNull();
  });

  it('lists tools in MCP format', async () => {
    const port = await server.start();
    const res = await jsonRpc(port, 'tools/list', {});
    expect(res.result.tools).toHaveLength(1);
    expect(res.result.tools[0].name).toBe('repo_manager-read_file');
    expect(res.result.tools[0].inputSchema).toBeDefined();
  });

  it('calls executeTool and returns result on tools/call', async () => {
    const outcome: ToolCallOutcome = { result: 'file contents' };
    executeTool.mockResolvedValueOnce(outcome);
    const port = await server.start();
    const res = await jsonRpc(port, 'tools/call', {
      name: 'repo_manager-read_file',
      arguments: { path: 'src/foo.ts' },
    });
    expect(executeTool).toHaveBeenCalledWith(
      'repo_manager-read_file',
      { path: 'src/foo.ts' },
      expect.any(String)
    );
    expect(res.result.content[0].text).toBe(JSON.stringify('file contents'));
  });

  it('returns MCP error content when executeTool returns an error', async () => {
    const outcome: ToolCallOutcome = { error: 'file not found' };
    executeTool.mockResolvedValueOnce(outcome);
    const port = await server.start();
    const res = await jsonRpc(port, 'tools/call', {
      name: 'repo_manager-read_file',
      arguments: { path: 'missing.ts' },
    });
    expect(res.result.content[0].text).toContain('file not found');
    expect(res.result.isError).toBe(true);
  });

  it('returns JSON-RPC error for unknown method', async () => {
    const port = await server.start();
    const res = await jsonRpc(port, 'unknown/method', {});
    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(-32601);
  });

  it('accumulates tool calls in getToolCalls()', async () => {
    executeTool.mockResolvedValueOnce({ result: 'ok' });
    const port = await server.start();
    await jsonRpc(port, 'tools/call', { name: 'repo_manager-read_file', arguments: { path: 'f.ts' } });
    const calls = server.getToolCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('repo_manager-read_file');
    expect(calls[0].result).toBe('ok');
  });
});
