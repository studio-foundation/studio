import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LLMRequest, LLMResponse } from '@studio-foundation/contracts';
import type { AgentLoopProvider, AgentLoopResult, ToolCallOutcome } from './provider.js';
import { ClaudeCodeMcpServer } from './claude-code-mcp-server.js';

export interface ClaudeCodeConfig {
  model?: string;
}

export class ClaudeCodeProvider implements AgentLoopProvider {
  readonly name = 'claude-code';
  private readonly model: string;

  constructor(config: ClaudeCodeConfig = {}) {
    this.model = config.model ?? 'claude-sonnet-4-5';
  }

  async call(request: LLMRequest, onToken?: (token: string) => void, signal?: AbortSignal): Promise<LLMResponse> {
    const result = await this.runAgentLoop(request, async () => ({ result: null }), onToken, signal);
    return {
      content: result.content,
      tool_calls: result.tool_calls,
      finish_reason: result.finish_reason,
      usage: result.usage,
    };
  }

  async runAgentLoop(
    request: LLMRequest,
    executeTool: (name: string, args: Record<string, unknown>, callId: string) => Promise<ToolCallOutcome>,
    onToken?: (token: string) => void,
    signal?: AbortSignal
  ): Promise<AgentLoopResult> {
    const tools = request.tools ?? [];
    const prompt = buildPrompt(request);

    // No tools → no MCP server. Attaching the HTTP MCP server makes the claude CLI
    // hang on the streamable-http handshake, and a tool-less agent has nothing to
    // call anyway, so run a plain --print invocation with no --mcp-config.
    if (tools.length === 0) {
      const result = await this.spawnClaude(prompt, undefined, onToken, signal);
      return { ...result, tool_calls: [] };
    }

    const mcpServer = new ClaudeCodeMcpServer(tools, executeTool);
    const port = await mcpServer.start();

    const mcpConfig = { mcpServers: { studio: { type: 'http', url: `http://127.0.0.1:${port}` } } };
    const mcpConfigPath = join(tmpdir(), `studio-mcp-${randomUUID()}.json`);
    await writeFile(mcpConfigPath, JSON.stringify(mcpConfig), 'utf-8');

    try {
      const result = await this.spawnClaude(prompt, mcpConfigPath, onToken, signal);
      return { ...result, tool_calls: mcpServer.getToolCalls() };
    } finally {
      await mcpServer.stop();
      await unlink(mcpConfigPath).catch(() => {});
    }
  }

  private spawnClaude(
    prompt: string,
    mcpConfigPath: string | undefined,
    onToken: ((token: string) => void) | undefined,
    signal: AbortSignal | undefined
  ): Promise<Omit<AgentLoopResult, 'tool_calls'>> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));

      const args = [
        '--print',
        '--output-format', 'stream-json',
        '--model', this.model,
        // With tools: expose them via the MCP server. Without tools: disable the
        // CLI's built-in tools (`--tools ""`) so this is a single-turn pure
        // completion — otherwise claude would run an unbounded agentic loop
        // (reading files, running commands) instead of just answering.
        // `--tools` is variadic, so it must be followed by another flag (--verbose),
        // never by the positional prompt.
        ...(mcpConfigPath ? ['--mcp-config', mcpConfigPath] : ['--tools', '']),
        // --strict-mcp-config: use ONLY the MCP servers we pass (the studio server,
        // or none for tool-less agents) and ignore the user's GLOBAL MCP servers
        // (claude.ai Gmail/Drive/Linear/Notion/Figma/…). Without this, the spawned
        // `claude` loads those at startup; their streamable-http handshake can hang
        // the whole --print subprocess (→ Studio cancels with 0 tool calls / 0
        // tokens) and injects ~88k tokens of tool defs into every call (~15x cost).
        '--strict-mcp-config',
        // stream-json output with --print REQUIRES --verbose. (The old
        // --no-verbose flag was removed from the claude CLI and now errors.)
        '--verbose',
        '--dangerously-skip-permissions',
        prompt,
      ];

      const startedAt = Date.now();
      logCC('spawn', { model: this.model, hasMcp: !!mcpConfigPath, flags: args.slice(0, -1), promptChars: prompt.length });

      const proc = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      logCC('spawned', { pid: proc.pid });

      if (signal) {
        signal.addEventListener('abort', () => {
          proc.kill('SIGTERM');
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      }

      let resultContent: string | undefined;
      let stderrContent = '';
      let buffer = '';

      proc.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            logCC('event', { type: event.type, subtype: event.subtype });
            if (event.type === 'assistant') {
              const msg = event.message as { content?: Array<{ type: string; text?: string }> };
              for (const block of msg.content ?? []) {
                if (block.type === 'text' && block.text) {
                  onToken?.(block.text);
                }
              }
            }
            if (event.type === 'result' && event.subtype === 'success') {
              resultContent = String(event.result ?? '');
            }
          } catch {
            // ignore non-JSON lines
          }
        }
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        const s = chunk.toString('utf-8');
        stderrContent += s;
        logCC('stderr', s.trim());
      });

      proc.on('close', (code) => {
        logCC('close', { code, ms: Date.now() - startedAt, gotResult: resultContent !== undefined });
        if (signal?.aborted) return;
        if (resultContent !== undefined) {
          resolve({ content: resultContent, finish_reason: 'stop', usage: undefined });
        } else {
          const errDetail = stderrContent.trim() ? `: ${stderrContent.trim()}` : '';
          reject(new Error(`claude -p exited with code ${code}${errDetail}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn claude: ${err.message}. Is Claude Code installed?`));
      });
    });
  }
}

/**
 * Diagnostic logging for the claude-code provider, gated by the
 * STUDIO_LOG_CLAUDE_CODE env var (set it to any non-empty value to enable).
 * Writes to STDERR only — stdout carries the stream-json/result payload that
 * callers (e.g. `studio run --json`) parse, so it must never be polluted.
 * Lets you see, during a hang, exactly which lifecycle step stalls: spawn →
 * spawned(pid) → event(type)… → close(code, ms, gotResult).
 */
function logCC(stage: string, detail: unknown): void {
  if (!process.env.STUDIO_LOG_CLAUDE_CODE) return;
  let rendered: string;
  try {
    rendered = typeof detail === 'string' ? detail : JSON.stringify(detail);
  } catch {
    rendered = String(detail);
  }
  process.stderr.write(`[claude-code] ${stage} ${rendered}\n`);
}

function buildPrompt(request: LLMRequest): string {
  const system = request.messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const user = request.messages.filter(m => m.role !== 'system').map(m => m.content).join('\n\n');
  return system ? `<system>\n${system}\n</system>\n\n${user}` : user;
}
