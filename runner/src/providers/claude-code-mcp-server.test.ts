import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ClaudeCodeMcpServer } from './claude-code-mcp-server.js';
import { createRepoManagerTools } from '../tools/builtin/repo-manager.js';
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
    expect(res.result.content[0].text).toBe('file contents');
  });

  it('renders file content raw so escape sequences are not doubled', async () => {
    const content = 'const a = `x\\ny\\t`;';
    executeTool.mockResolvedValueOnce({ result: { path: 'a.ts', content } });
    const port = await server.start();
    const res = await jsonRpc(port, 'tools/call', {
      name: 'repo_manager-read_file',
      arguments: { path: 'a.ts' },
    });
    expect(res.result.content[0].text).toBe(`{"path":"a.ts"}\n${content}`);
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

  it('returns JSON-RPC error -32602 when tools/call params are missing', async () => {
    const port = await server.start();
    const res = await jsonRpc(port, 'tools/call', { name: 'repo_manager-read_file' });
    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(-32602);
  });

  it('records tool call with error when executeTool throws', async () => {
    executeTool.mockRejectedValueOnce(new Error('unexpected crash'));
    const port = await server.start();
    const res = await jsonRpc(port, 'tools/call', {
      name: 'repo_manager-read_file',
      arguments: { path: 'f.ts' },
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('unexpected crash');
    const calls = server.getToolCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].error).toBe('unexpected crash');
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

describe('ClaudeCodeMcpServer with the repo_manager builtin', () => {
  // Source text holding escape sequences, as in the bin/chat.mjs repro.
  const ORIGINAL = [
    "  .map((t, i) => `Turn ${i + 1} user: ${t.user}\\nTurn ${i + 1} you: ${t.assistant}`)",
    "  .join('\\n');",
    "const tab = 'a\\tb';",
    "const path = 'C:\\\\dir';",
    "const re = /\\d+\\.\\d+/;",
    "const json = '{\"a\":\"x\\ny\"}';",
    '',
  ].join('\n');

  let dir: string;
  let server: ClaudeCodeMcpServer;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'studio-mcp-roundtrip-'));
    await writeFile(join(dir, 'chat.mjs'), ORIGINAL, 'utf-8');
    const tools = createRepoManagerTools(dir);
    server = new ClaudeCodeMcpServer(tools, async (name, args) => {
      const tool = tools.find((t) => t.name === name)!;
      const r = await tool.execute(args);
      return r.success ? { result: r.output } : { error: r.error };
    });
  });

  afterEach(async () => {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a file with escape sequences byte for byte through read_file and write_file', async () => {
    const port = await server.start();
    const read = await jsonRpc(port, 'tools/call', {
      name: 'repo_manager-read_file',
      arguments: { path: 'chat.mjs' },
    });
    const text: string = read.result.content[0].text;
    // What the model sees as the file is everything below the header line.
    const seen = text.slice(text.indexOf('\n') + 1);
    expect(seen).toBe(ORIGINAL);

    // A model that copies what it saw and adds the requested comment.
    const edited = `// test\n${seen}`;
    const write = await jsonRpc(port, 'tools/call', {
      name: 'repo_manager-write_file',
      arguments: { path: 'chat.mjs', content: edited },
    });
    expect(write.result.isError).toBeUndefined();

    const onDisk = await readFile(join(dir, 'chat.mjs'), 'utf-8');
    expect(onDisk).toBe(`// test\n${ORIGINAL}`);
    expect(onDisk.split('\\\\n').length).toBe(ORIGINAL.split('\\\\n').length);
    expect(onDisk.split('\\n').length).toBe(ORIGINAL.split('\\n').length);
  });
});
