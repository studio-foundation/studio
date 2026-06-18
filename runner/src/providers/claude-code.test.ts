import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudeCodeProvider } from './claude-code.js';
import type { LLMRequest } from '@studio-foundation/contracts';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

const { mockSpawn, MockClaudeCodeMcpServer } = vi.hoisted(() => {
  const mockSpawn = vi.fn();
  function MockClaudeCodeMcpServer() {
    return {
      start: vi.fn().mockResolvedValue(9999),
      stop: vi.fn().mockResolvedValue(undefined),
      getToolCalls: vi.fn().mockReturnValue([]),
    };
  }
  return { mockSpawn, MockClaudeCodeMcpServer };
});

vi.mock('node:child_process', () => ({ spawn: mockSpawn }));
vi.mock('./claude-code-mcp-server.js', () => ({ ClaudeCodeMcpServer: MockClaudeCodeMcpServer }));
vi.mock('node:fs/promises', () => {
  return {
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
  };
});

function makeFakeProcess(lines: string[], exitCode = 0) {
  const proc = new EventEmitter() as NodeJS.EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    stdin: Writable;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  proc.kill = vi.fn();

  setTimeout(() => {
    for (const line of lines) {
      proc.stdout.push(line + '\n');
    }
    proc.stdout.push(null);
    proc.emit('close', exitCode);
  }, 0);

  return proc;
}

const BASE_REQUEST: LLMRequest = {
  model: 'claude-sonnet-4-5',
  messages: [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Hello' },
  ],
};

describe('ClaudeCodeProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('has name "claude-code"', () => {
    const provider = new ClaudeCodeProvider();
    expect(provider.name).toBe('claude-code');
  });

  it('runAgentLoop returns content from result event', async () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '{"summary":"done"}' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: '{"summary":"done"}' }),
    ];
    mockSpawn.mockReturnValueOnce(makeFakeProcess(lines));
    const provider = new ClaudeCodeProvider({ model: 'claude-sonnet-4-5' });
    const result = await provider.runAgentLoop(BASE_REQUEST, vi.fn());
    expect(result.content).toBe('{"summary":"done"}');
    expect(result.finish_reason).toBe('stop');
  });

  it('streams tokens via onToken from assistant events', async () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: ' world' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'Hello world' }),
    ];
    mockSpawn.mockReturnValueOnce(makeFakeProcess(lines));
    const provider = new ClaudeCodeProvider({ model: 'claude-sonnet-4-5' });
    const tokens: string[] = [];
    await provider.runAgentLoop(BASE_REQUEST, vi.fn(), t => tokens.push(t));
    expect(tokens).toEqual(['Hello', ' world']);
  });

  it('spawns claude with --output-format stream-json, --model, and --mcp-config when tools are present', async () => {
    const lines = [JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })];
    mockSpawn.mockReturnValueOnce(makeFakeProcess(lines));
    const provider = new ClaudeCodeProvider({ model: 'claude-sonnet-4-5' });
    const requestWithTools: LLMRequest = {
      ...BASE_REQUEST,
      tools: [{ name: 'echo', description: 'echo', parameters: { type: 'object', properties: {} } }],
    };
    await provider.runAgentLoop(requestWithTools, vi.fn());
    const [cmd, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('claude');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--model');
    expect(args).toContain('claude-sonnet-4-5');
    expect(args).toContain('--mcp-config');
    // --strict-mcp-config pins the spawned claude to ONLY the studio MCP server,
    // ignoring the user's global MCP servers (claude.ai Gmail/Drive/Linear/etc.)
    // whose startup handshake otherwise hangs the subprocess and balloons cost.
    expect(args).toContain('--strict-mcp-config');
    // --output-format stream-json with --print REQUIRES --verbose; the old
    // --no-verbose flag was removed from the claude CLI and now errors out.
    expect(args).toContain('--verbose');
    expect(args).not.toContain('--no-verbose');
  });

  it('skips the MCP server and --mcp-config when there are no tools', async () => {
    // Attaching the HTTP MCP server makes the claude CLI hang on the streamable-http
    // handshake; a tool-less agent (e.g. a pure classifier) needs no MCP server.
    const lines = [JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })];
    mockSpawn.mockReturnValueOnce(makeFakeProcess(lines));
    const provider = new ClaudeCodeProvider({ model: 'claude-sonnet-4-5' });
    const result = await provider.runAgentLoop(BASE_REQUEST, vi.fn());  // BASE_REQUEST has no tools
    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(args).not.toContain('--mcp-config');
    // No --mcp-config here, but --strict-mcp-config still matters: it stops the
    // CLI from loading the user's global MCP servers, which otherwise hang the
    // tool-less classify subprocess on their handshake (the real cancel/hang bug).
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--verbose');
    // built-in tools disabled for a single-turn pure completion (no agentic roaming),
    // and the empty value must sit before a flag so the variadic doesn't eat the prompt.
    const toolsIdx = args.indexOf('--tools');
    expect(toolsIdx).toBeGreaterThanOrEqual(0);
    expect(args[toolsIdx + 1]).toBe('');
    expect(args[toolsIdx + 2]).toMatch(/^--/);
    expect(result.tool_calls).toEqual([]);
  });

  it('logs lifecycle to stderr only when STUDIO_LOG_CLAUDE_CODE is set', async () => {
    const lines = [JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })];
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((s: string | Uint8Array) => {
      writes.push(String(s));
      return true;
    }) as typeof process.stderr.write);
    try {
      // Off by default: no diagnostic lines.
      delete process.env.STUDIO_LOG_CLAUDE_CODE;
      mockSpawn.mockReturnValueOnce(makeFakeProcess(lines));
      await new ClaudeCodeProvider().runAgentLoop(BASE_REQUEST, vi.fn());
      expect(writes.some(w => w.includes('[claude-code]'))).toBe(false);

      // On when the env var is set: spawn + close lifecycle lines on stderr.
      process.env.STUDIO_LOG_CLAUDE_CODE = '1';
      mockSpawn.mockReturnValueOnce(makeFakeProcess(lines));
      await new ClaudeCodeProvider().runAgentLoop(BASE_REQUEST, vi.fn());
      expect(writes.some(w => w.includes('[claude-code] spawn'))).toBe(true);
      expect(writes.some(w => w.includes('[claude-code] close'))).toBe(true);
    } finally {
      delete process.env.STUDIO_LOG_CLAUDE_CODE;
      spy.mockRestore();
    }
  });

  it('throws when claude exits non-zero with no result event', async () => {
    mockSpawn.mockReturnValueOnce(makeFakeProcess([], 1));
    const provider = new ClaudeCodeProvider();
    await expect(provider.runAgentLoop(BASE_REQUEST, vi.fn())).rejects.toThrow(/claude -p exited/i);
  });

  it('aborts child process when signal fires', async () => {
    const controller = new AbortController();
    // Long-running proc that never closes on its own
    const proc = new EventEmitter() as NodeJS.EventEmitter & {
      stdout: Readable; stderr: Readable; stdin: Writable; kill: ReturnType<typeof vi.fn>;
    };
    proc.stdout = new Readable({ read() {} });
    proc.stderr = new Readable({ read() {} });
    proc.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
    proc.kill = vi.fn();

    mockSpawn.mockReturnValueOnce(proc);
    const provider = new ClaudeCodeProvider();
    const promise = provider.runAgentLoop(BASE_REQUEST, vi.fn(), undefined, controller.signal);
    // Wait for spawn to be called and listeners to be set up
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    // Simulate OS sending signal back as close event
    proc.emit('close', 130);
    await expect(promise).rejects.toThrow(/aborted/i);
    expect(proc.kill).toHaveBeenCalled();
  });

  it('call() delegates to runAgentLoop and returns LLMResponse shape', async () => {
    const lines = [JSON.stringify({ type: 'result', subtype: 'success', result: '{"answer":42}' })];
    mockSpawn.mockReturnValueOnce(makeFakeProcess(lines));
    const provider = new ClaudeCodeProvider({ model: 'claude-sonnet-4-5' });
    const result = await provider.call(BASE_REQUEST);
    expect(result.content).toBe('{"answer":42}');
    expect(result.finish_reason).toBe('stop');
  });
});
