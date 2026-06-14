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
    const mcpServer = new ClaudeCodeMcpServer(tools, executeTool);
    const port = await mcpServer.start();

    const mcpConfig = { mcpServers: { studio: { type: 'http', url: `http://127.0.0.1:${port}` } } };
    const mcpConfigPath = join(tmpdir(), `studio-mcp-${randomUUID()}.json`);
    await writeFile(mcpConfigPath, JSON.stringify(mcpConfig), 'utf-8');

    const prompt = buildPrompt(request);

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
    mcpConfigPath: string,
    onToken: ((token: string) => void) | undefined,
    signal: AbortSignal | undefined
  ): Promise<Omit<AgentLoopResult, 'tool_calls'>> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));

      const args = [
        '--print',
        '--output-format', 'stream-json',
        '--model', this.model,
        '--mcp-config', mcpConfigPath,
        '--no-verbose',
        '--dangerously-skip-permissions',
        prompt,
      ];

      const proc = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });

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
        stderrContent += chunk.toString('utf-8');
      });

      proc.on('close', (code) => {
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

function buildPrompt(request: LLMRequest): string {
  const system = request.messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const user = request.messages.filter(m => m.role !== 'system').map(m => m.content).join('\n\n');
  return system ? `<system>\n${system}\n</system>\n\n${user}` : user;
}
