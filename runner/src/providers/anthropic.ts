/**
 * Anthropic provider implementation with full tool calling support
 */

import type { LLMRequest, LLMResponse } from '@studio/contracts';
import type { Provider } from './provider.js';
import Anthropic from '@anthropic-ai/sdk';
import type {
  Message,
  MessageParam,
  Tool,
  TextBlockParam
} from '@anthropic-ai/sdk/resources/messages';
import { raceSignal } from '../utils/race-signal.js';

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  private client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic({
      apiKey: apiKey || process.env.ANTHROPIC_API_KEY
    });
  }

  async call(request: LLMRequest, onToken?: (token: string) => void, signal?: AbortSignal): Promise<LLMResponse> {
    const params = this.buildParams(request);

    if (onToken) {
      // Streaming path
      const stream = this.client.messages.stream(params, { signal });
      stream.on('text', (textDelta: string) => {
        if (signal?.aborted) return; // guard: don't emit after abort
        onToken(textDelta);
      });
      // KEY FIX: race finalMessage() against signal abort.
      // Without this, finalMessage() hangs forever when the HTTP connection
      // is killed mid-stream (the stream 'end' event never fires).
      const response = await raceSignal(stream.finalMessage(), signal);
      return this.parseResponse(response);
    }

    // Non-streaming path
    const response = await raceSignal(this.client.messages.create(params, { signal }), signal);
    return this.parseResponse(response);
  }

  private buildParams(request: LLMRequest) {
    // Extract system messages (Anthropic handles them separately)
    const systemMessages = request.messages.filter(m => m.role === 'system');
    const systemContent = systemMessages.map(m => m.content).join('\n\n');

    // Convert remaining messages to Anthropic format
    const anthropicMessages: MessageParam[] = request.messages
      .filter(m => m.role !== 'system')
      .map(msg => {
        if (msg.role === 'user') {
          return { role: 'user' as const, content: msg.content };
        }
        if (msg.role === 'assistant') {
          return { role: 'assistant' as const, content: msg.content };
        }
        throw new Error(`Unsupported message role: ${msg.role}`);
      });

    // Convert tool definitions to Anthropic format
    // Mark the last tool with cache_control so Anthropic caches system + tools block
    const rawTools = request.tools ?? [];
    const tools: Tool[] | undefined = rawTools.length > 0
      ? rawTools.map((tool, index) => ({
          name: tool.name,
          description: tool.description,
          input_schema: {
            type: 'object',
            ...tool.parameters
          } as Tool['input_schema'],
          ...(index === rawTools.length - 1
            ? { cache_control: { type: 'ephemeral' as const } }
            : {})
        }))
      : undefined;

    // Mark system prompt with cache_control — stable across retries and group iterations
    const systemParam: TextBlockParam[] | undefined = systemContent
      ? [{ type: 'text', text: systemContent, cache_control: { type: 'ephemeral' as const } }]
      : undefined;

    return {
      model: request.model,
      max_tokens: request.max_tokens || 4096,
      system: systemParam,
      messages: anthropicMessages,
      tools: tools,
      temperature: request.temperature
    };
  }

  private parseResponse(response: Message): LLMResponse {
    // Parse tool calls and text content from response
    const tool_calls: Array<{
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }> = [];
    let textContent = '';

    for (const block of response.content) {
      if (block.type === 'text') {
        textContent += block.text;
      } else if (block.type === 'tool_use') {
        tool_calls.push({
          id: block.id,
          name: block.name,
          arguments: block.input as Record<string, unknown>
        });
      }
    }

    const cachedInputTokens = response.usage.cache_read_input_tokens ?? 0;
    const cacheCreationTokens = response.usage.cache_creation_input_tokens ?? 0;

    return {
      content: textContent,
      tool_calls,
      finish_reason: response.stop_reason || 'stop',
      usage: {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
        cached_input_tokens: cachedInputTokens > 0 ? cachedInputTokens : undefined,
        cache_creation_tokens: cacheCreationTokens > 0 ? cacheCreationTokens : undefined
      }
    };
  }
}
