/**
 * Ollama provider — OpenAI-compatible local LLM server
 * Uses the openai npm SDK pointed at Ollama's /v1 endpoint.
 */

import type { LLMRequest, LLMResponse } from '@studio/contracts';
import type { Provider } from './provider.js';
import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool, ChatCompletionChunk } from 'openai/resources/chat/completions';

function isConnectionRefused(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if ('code' in err && (err as NodeJS.ErrnoException).code === 'ECONNREFUSED') return true;
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause instanceof Error && 'code' in cause && (cause as NodeJS.ErrnoException).code === 'ECONNREFUSED') return true;
  if (err.message.includes('ECONNREFUSED')) return true;
  return false;
}

export class OllamaProvider implements Provider {
  readonly name = 'ollama';
  private client: OpenAI;
  private baseUrl: string;

  constructor(baseUrl = 'http://localhost:11434') {
    this.baseUrl = baseUrl;
    this.client = new OpenAI({
      baseURL: `${baseUrl}/v1`,
      apiKey: 'ollama', // required by SDK, ignored by Ollama
    });
  }

  async call(request: LLMRequest, onToken?: (token: string) => void, signal?: AbortSignal): Promise<LLMResponse> {
    try {
      if (onToken) {
        return await this.callStreaming(request, onToken, signal);
      }
      return await this.callNonStreaming(request, signal);
    } catch (err) {
      if (isConnectionRefused(err)) {
        throw new Error(
          `Ollama is not running at ${this.baseUrl}. Start it with: ollama serve`
        );
      }
      throw err;
    }
  }

  private async callNonStreaming(request: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
    const completion = await this.client.chat.completions.create({
      model: request.model,
      messages: this.buildMessages(request),
      tools: this.buildTools(request),
      temperature: request.temperature,
      max_tokens: request.max_tokens,
      response_format: request.json_mode ? { type: 'json_object' } : undefined,
    }, { signal });

    const choice = completion.choices[0];
    if (!choice) throw new Error('Ollama returned an empty choices array');
    const tool_calls = choice.message.tool_calls?.map(tc => ({
      id: tc.id,
      name: tc.function.name,
      arguments: (() => {
        try { return JSON.parse(tc.function.arguments); }
        catch { return {}; }
      })(),
    })) || [];

    return {
      content: choice.message.content || '',
      tool_calls,
      finish_reason: choice.finish_reason ?? 'stop',
      usage: completion.usage ? {
        prompt_tokens: completion.usage.prompt_tokens,
        completion_tokens: completion.usage.completion_tokens,
        total_tokens: completion.usage.total_tokens,
      } : undefined,
    };
  }

  private async callStreaming(
    request: LLMRequest,
    onToken: (token: string) => void,
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    // NOTE: No stream_options here — older Ollama versions reject it
    const stream = this.client.chat.completions.create({
      model: request.model,
      messages: this.buildMessages(request),
      tools: this.buildTools(request),
      temperature: request.temperature,
      max_tokens: request.max_tokens,
      response_format: request.json_mode ? { type: 'json_object' } : undefined,
      stream: true as const,
    }, { signal }) as unknown as AsyncIterable<ChatCompletionChunk>;

    let textContent = '';
    const toolCallMap = new Map<number, { id: string; name: string; args: string }>();
    let finishReason = 'stop';

    for await (const chunk of stream) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        textContent += delta.content;
        onToken(delta.content);
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!toolCallMap.has(tc.index)) {
            toolCallMap.set(tc.index, { id: '', name: '', args: '' });
          }
          const acc = toolCallMap.get(tc.index)!;
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name += tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
        }
      }
      if (chunk.choices[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
    }

    const tool_calls = Array.from(toolCallMap.values()).map(tc => ({
      id: tc.id,
      name: tc.name,
      arguments: JSON.parse(tc.args || '{}'),
    }));

    return { content: textContent, tool_calls, finish_reason: finishReason, usage: undefined };
  }

  private buildMessages(request: LLMRequest): ChatCompletionMessageParam[] {
    return request.messages.map(msg => {
      if (msg.role === 'system') return { role: 'system', content: msg.content };
      if (msg.role === 'user') return { role: 'user', content: msg.content };
      if (msg.role === 'assistant') return { role: 'assistant', content: msg.content };
      throw new Error(`Unsupported message role: ${msg.role}`);
    });
  }

  private buildTools(request: LLMRequest): ChatCompletionTool[] | undefined {
    if (!request.tools || request.tools.length === 0) return undefined;
    return request.tools.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }
}
