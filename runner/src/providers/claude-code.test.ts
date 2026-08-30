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
    stdinWritten: string;
  };
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.stdinWritten = '';
  proc.stdin = new Writable({ write(chunk, _enc, cb) { proc.stdinWritten += String(chunk); cb(); } });
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

  it('spawns with the operator\'s user-level CLI configuration suppressed', async () => {
    const lines = [JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })];
    mockSpawn.mockReturnValueOnce(makeFakeProcess(lines));
    const provider = new ClaudeCodeProvider({ model: 'claude-sonnet-4-5' });
    await provider.runAgentLoop(BASE_REQUEST, vi.fn());

    const [, args, options] = mockSpawn.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    // Without these, ~/.claude/CLAUDE.md, the user's hooks, output styles and
    // auto-memory index land in the system prompt of an agent .studio/ is
    // supposed to define completely (STU-863).
    const sourcesIdx = args.indexOf('--setting-sources');
    expect(sourcesIdx).toBeGreaterThan(-1);
    expect(args[sourcesIdx + 1]).toBe('');
    // It takes a single value, so the empty string must be followed by another
    // flag — never left last, where the CLI would read the next word as a source.
    expect(args[sourcesIdx + 2]).toMatch(/^--/);
    expect(options.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    // The CLI still needs the rest of the operator's environment: the OAuth
    // session it authenticates with is not something Studio can supply.
    expect(options.env.PATH).toBe(process.env.PATH);
  });

  it('sends the prompt on stdin and closes it, never in argv', async () => {
    const lines = [JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })];
    const proc = makeFakeProcess(lines);
    mockSpawn.mockReturnValueOnce(proc);
    const provider = new ClaudeCodeProvider({ model: 'claude-sonnet-4-5' });
    await provider.runAgentLoop(BASE_REQUEST, vi.fn());

    const [, args, options] = mockSpawn.mock.calls[0] as [string, string[], { stdio: string[] }];
    // A positional prompt caps every agent at MAX_ARG_STRLEN and fails with E2BIG
    // before the process exists (STU-561) — the last arg must stay a flag.
    expect(args.some(arg => arg.includes('Hello'))).toBe(false);
    expect(args.at(-1)).toBe('--dangerously-skip-permissions');
    expect(options.stdio[0]).toBe('pipe');
    expect(proc.stdinWritten).toContain('Hello');
    expect(proc.stdinWritten).toContain('You are helpful.');
    // claude blocks forever on a pipe nobody closes; end() is what delivers the EOF.
    expect(proc.stdin.writableEnded).toBe(true);
  });

  it('a prompt past MAX_ARG_STRLEN reaches a real process on stdin and cannot on argv', async () => {
    // The reason the test above exists, against the real kernel rather than a mock:
    // Linux caps one argv entry at 32 pages, so the old positional prompt made
    // spawn throw E2BIG for any agent whose payload outgrew it (STU-561). This is
    // not a Claude limit and no CLI flag lifts it — stdin is the only way through.
    const { spawn: realSpawn } =
      await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const huge = 'x'.repeat(512 * 1024);
    expect(() => realSpawn('/bin/cat', [huge], { stdio: 'ignore' })).toThrow(/E2BIG/);

    const received = await new Promise<number>((resolve, reject) => {
      const proc = realSpawn('/bin/cat', [], { stdio: ['pipe', 'pipe', 'ignore'] });
      let out = 0;
      proc.stdout.on('data', (chunk: Buffer) => { out += chunk.length; });
      proc.on('close', () => resolve(out));
      proc.on('error', reject);
      proc.stdin.end(huge);
    });
    expect(received).toBe(huge.length);
  });

  it('honors the per-agent model from request.model over the construction-time default', async () => {
    // STU-429: the construction-time model (from config.claudeCode.model, i.e.
    // defaults.model) is only a FALLBACK. When a stage's agent declares its own
    // model, the engine resolves it into request.model — the provider must spawn
    // claude with THAT model, not the default it was constructed with.
    const lines = [JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })];
    mockSpawn.mockReturnValueOnce(makeFakeProcess(lines));
    const provider = new ClaudeCodeProvider({ model: 'claude-sonnet-4-5' }); // default
    const requestWithModel: LLMRequest = { ...BASE_REQUEST, model: 'claude-opus-4-1' }; // per-agent override
    await provider.runAgentLoop(requestWithModel, vi.fn());
    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    const modelIdx = args.indexOf('--model');
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(args[modelIdx + 1]).toBe('claude-opus-4-1');
  });

  it('falls back to the construction-time default when request.model is absent', async () => {
    // Direct callers (not the runner) may omit model; the construction default
    // still applies as the fallback.
    const lines = [JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })];
    mockSpawn.mockReturnValueOnce(makeFakeProcess(lines));
    const provider = new ClaudeCodeProvider({ model: 'claude-sonnet-4-5' });
    const requestNoModel = { ...BASE_REQUEST, model: undefined } as unknown as LLMRequest;
    await provider.runAgentLoop(requestNoModel, vi.fn());
    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    const modelIdx = args.indexOf('--model');
    expect(args[modelIdx + 1]).toBe('claude-sonnet-4-5');
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
    // CLI from loading the user's global MCP servers, which otherwise inject ~88k
    // tokens of tool defs per call (~15x cost) and can hang on their handshake.
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

  it('never leaves claude an open stdin pipe (else --print hangs waiting for EOF)', async () => {
    // ROOT CAUSE of the studio classify hang: an open, non-TTY stdin nobody closes.
    // claude 2.1.37 blocks waiting for its EOF and never emits output, so Studio
    // cancels it (0 tool calls / 0 tokens). The prompt now travels on that pipe, so
    // the guard is no longer stdio[0]='ignore' — it is that the pipe always ends.
    const lines = [JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })];
    const proc = makeFakeProcess(lines);
    mockSpawn.mockReturnValueOnce(proc);
    await new ClaudeCodeProvider().runAgentLoop(BASE_REQUEST, vi.fn());
    expect(proc.stdin.writableEnded).toBe(true);
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

describe('ClaudeCodeProvider token usage (STU-750)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Verbatim shape of a `claude -p --output-format stream-json` result event.
  const RESULT_WITH_USAGE = {
    type: 'result',
    subtype: 'success',
    result: '{"summary":"done"}',
    usage: {
      input_tokens: 4,
      cache_creation_input_tokens: 13512,
      cache_read_input_tokens: 21000,
      output_tokens: 437,
    },
    modelUsage: {
      'claude-sonnet-4-5-20250929': {
        inputTokens: 4,
        outputTokens: 437,
        cacheReadInputTokens: 21000,
        cacheCreationInputTokens: 13512,
        costUSD: 0.0521,
      },
    },
  };

  it('reports the CLI usage block on the agent loop result', async () => {
    mockSpawn.mockReturnValueOnce(makeFakeProcess([JSON.stringify(RESULT_WITH_USAGE)]));
    const provider = new ClaudeCodeProvider({ model: 'claude-sonnet-4-5' });

    const result = await provider.runAgentLoop(BASE_REQUEST, vi.fn());

    expect(result.usage).toEqual({
      prompt_tokens: 4,
      completion_tokens: 437,
      // Cache reads and writes are tokens the call consumed, so they belong in the total.
      total_tokens: 4 + 437 + 21000 + 13512,
      cached_input_tokens: 21000,
      cache_creation_tokens: 13512,
      by_model: {
        'claude-sonnet-4-5-20250929': {
          prompt_tokens: 4,
          completion_tokens: 437,
          total_tokens: 4 + 437 + 21000 + 13512,
          cached_input_tokens: 21000,
          cache_creation_tokens: 13512,
        },
      },
    });
  });

  it('attributes each model separately when the session spanned several', async () => {
    const lines = [JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'ok',
      modelUsage: {
        'claude-opus-4-5': { inputTokens: 100, outputTokens: 50 },
        'claude-haiku-4-5': { inputTokens: 10, outputTokens: 5 },
      },
    })];
    mockSpawn.mockReturnValueOnce(makeFakeProcess(lines));
    const provider = new ClaudeCodeProvider({ model: 'claude-sonnet-4-5' });

    const result = await provider.runAgentLoop(BASE_REQUEST, vi.fn());

    expect(result.usage?.total_tokens).toBe(165);
    expect(result.usage?.by_model?.['claude-opus-4-5'].total_tokens).toBe(150);
    expect(result.usage?.by_model?.['claude-haiku-4-5'].total_tokens).toBe(15);
  });

  it('falls back to the flat usage block, attributed to the spawned model', async () => {
    const lines = [JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'ok',
      usage: { input_tokens: 120, output_tokens: 30 },
    })];
    mockSpawn.mockReturnValueOnce(makeFakeProcess(lines));
    const provider = new ClaudeCodeProvider({ model: 'claude-opus-4-5' });

    const result = await provider.runAgentLoop({ ...BASE_REQUEST, model: '' }, vi.fn());

    expect(result.usage).toEqual({
      prompt_tokens: 120,
      completion_tokens: 30,
      total_tokens: 150,
      by_model: { 'claude-opus-4-5': { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } },
    });
  });

  it('reports no usage when the CLI reported none, rather than a false zero', async () => {
    const lines = [JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })];
    mockSpawn.mockReturnValueOnce(makeFakeProcess(lines));
    const provider = new ClaudeCodeProvider({ model: 'claude-sonnet-4-5' });

    const result = await provider.runAgentLoop(BASE_REQUEST, vi.fn());

    expect(result.usage).toBeUndefined();
  });

  it('carries usage through call() as well as runAgentLoop()', async () => {
    mockSpawn.mockReturnValueOnce(makeFakeProcess([JSON.stringify(RESULT_WITH_USAGE)]));
    const provider = new ClaudeCodeProvider({ model: 'claude-sonnet-4-5' });

    const response = await provider.call(BASE_REQUEST);

    expect(response.usage?.total_tokens).toBe(4 + 437 + 21000 + 13512);
  });
});
