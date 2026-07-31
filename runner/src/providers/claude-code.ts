import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LLMRequest, LLMResponse, ModelTokenUsage, TokenUsage } from '@studio-foundation/contracts';
import { accumulateTokenUsage, emptyTokenUsage, withModel } from '@studio-foundation/contracts';
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

  /**
   * Resolve the model to spawn `claude` with. The per-agent model — resolved by
   * the engine into request.model (STU-429) — takes precedence. The
   * construction-time model (config.claudeCode.model, i.e. defaults.model) is
   * only a FALLBACK, for direct callers that omit or blank out request.model.
   * `||` (not `??`) so an empty string also falls back, never reaching the CLI
   * as a broken `--model ""`.
   */
  private resolveModel(request: LLMRequest): string {
    return request.model || this.model;
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
    const model = this.resolveModel(request);

    // No tools → no MCP server. Attaching the HTTP MCP server makes the claude CLI
    // hang on the streamable-http handshake, and a tool-less agent has nothing to
    // call anyway, so run a plain --print invocation with no --mcp-config.
    if (tools.length === 0) {
      const result = await this.spawnClaude(model, prompt, undefined, onToken, signal);
      return { ...result, tool_calls: [] };
    }

    const mcpServer = new ClaudeCodeMcpServer(tools, executeTool);
    const port = await mcpServer.start();

    const mcpConfig = { mcpServers: { studio: { type: 'http', url: `http://127.0.0.1:${port}` } } };
    const mcpConfigPath = join(tmpdir(), `studio-mcp-${randomUUID()}.json`);
    await writeFile(mcpConfigPath, JSON.stringify(mcpConfig), 'utf-8');

    try {
      const result = await this.spawnClaude(model, prompt, mcpConfigPath, onToken, signal);
      return { ...result, tool_calls: mcpServer.getToolCalls() };
    } finally {
      await mcpServer.stop();
      await unlink(mcpConfigPath).catch(() => {});
    }
  }

  private spawnClaude(
    model: string,
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
        '--model', model,
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
      ];

      const startedAt = Date.now();
      logCC('spawn', { model, hasMcp: !!mcpConfigPath, flags: args, promptChars: prompt.length });

      // The prompt goes on stdin, never in argv. Linux caps ONE argv entry at
      // MAX_ARG_STRLEN (32 pages = 131072 bytes — not the ARG_MAX getconf reports),
      // so a positional prompt makes spawn throw E2BIG for every agent whose payload
      // outgrows 128 KiB, before the process exists (STU-561).
      // What stdin must never be is an open pipe nobody closes: claude 2.1.37 blocks
      // waiting for its EOF and never emits output. `end()` below is what delivers it.
      const proc = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      logCC('spawned', { pid: proc.pid });
      proc.stdin.on('error', () => {
        // The CLI can exit before reading it all; `close` already reports that.
      });
      proc.stdin.end(prompt);

      if (signal) {
        signal.addEventListener('abort', () => {
          proc.kill('SIGTERM');
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      }

      let resultContent: string | undefined;
      let resultUsage: TokenUsage | undefined;
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
              // The CLI reports what the whole --print session spent. This is
              // the only place the cost of a claude-code stage is observable:
              // without it, `.studio/runs/<run>.jsonl` records zero tokens and
              // pricing a run means correlating ~/.claude session files against
              // stage timestamps (STU-750).
              resultUsage = parseResultUsage(event, model);
              logCC('usage', resultUsage ?? null);
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
          resolve({ content: resultContent, finish_reason: 'stop', usage: resultUsage });
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

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Read the token counts off the CLI's terminal `result` event.
 *
 * Two shapes, both optional and both handled:
 *  - `modelUsage`: `{ "<model-id>": { inputTokens, outputTokens, cacheReadInputTokens,
 *    cacheCreationInputTokens } }` — cumulative for the session and split per model,
 *    so a stage whose agent delegated to another model is priced correctly. Preferred.
 *  - `usage`: `{ input_tokens, output_tokens, cache_read_input_tokens,
 *    cache_creation_input_tokens }` — one flat block, attributed to the model we
 *    spawned with. Used when `modelUsage` is absent (older CLI builds).
 *
 * The CLI reports the Anthropic split — `input_tokens` already excludes both
 * cache counts — so the fields map across one-for-one and only `total_tokens`
 * has to be summed.
 *
 * A `result` event with no counts at all yields undefined — an unreported cost
 * stays absent instead of being logged as a real zero.
 */
function parseResultUsage(event: Record<string, unknown>, fallbackModel: string): TokenUsage | undefined {
  const modelUsage = event.modelUsage as Record<string, Record<string, unknown>> | undefined;
  if (modelUsage && typeof modelUsage === 'object' && Object.keys(modelUsage).length > 0) {
    const total = emptyTokenUsage();
    for (const [model, counts] of Object.entries(modelUsage)) {
      if (!counts || typeof counts !== 'object') continue;
      accumulateTokenUsage(total, withModel(model, countsOf({
        input: num(counts.inputTokens),
        output: num(counts.outputTokens),
        cacheRead: num(counts.cacheReadInputTokens),
        cacheCreation: num(counts.cacheCreationInputTokens),
      })));
    }
    if (total.total_tokens > 0 || (total.cached_input_tokens ?? 0) > 0 || (total.cache_creation_tokens ?? 0) > 0) {
      return total;
    }
  }

  const usage = event.usage as Record<string, unknown> | undefined;
  if (usage && typeof usage === 'object') {
    const counts = countsOf({
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheCreation: num(usage.cache_creation_input_tokens),
    });
    if (counts.total_tokens > 0 || (counts.cached_input_tokens ?? 0) > 0 || (counts.cache_creation_tokens ?? 0) > 0) {
      return withModel(fallbackModel, counts);
    }
  }

  return undefined;
}

function countsOf(raw: { input: number; output: number; cacheRead: number; cacheCreation: number }): ModelTokenUsage {
  return {
    prompt_tokens: raw.input,
    completion_tokens: raw.output,
    total_tokens: raw.input + raw.output + raw.cacheRead + raw.cacheCreation,
    ...(raw.cacheRead > 0 ? { cached_input_tokens: raw.cacheRead } : {}),
    ...(raw.cacheCreation > 0 ? { cache_creation_tokens: raw.cacheCreation } : {}),
  };
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
