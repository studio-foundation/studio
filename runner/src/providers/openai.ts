/**
 * OpenAI provider implementation with full tool calling support
 */

import type { LLMRequest, LLMResponse } from '@studio/contracts';
import type { Provider } from './provider.js';
import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool, ChatCompletionChunk } from 'openai/resources/chat/completions';

export class OpenAIProvider implements Provider {
  readonly name = 'openai';
  private client: OpenAI;

  constructor(apiKey?: string, private baseUrl?: string) {
    this.client = new OpenAI({
      apiKey: apiKey || process.env.OPENAI_API_KEY,
      baseURL: baseUrl
    });
  }

  async call(request: LLMRequest, onToken?: (token: string) => void): Promise<LLMResponse> {
    const openaiMessages = this.buildMessages(request);
    const tools = this.buildTools(request);

    if (onToken) {
      return this.callStreaming(request, openaiMessages, tools, onToken);
    }

    // Non-streaming path (existing behavior)
    const completion = await this.client.chat.completions.create({
      model: request.model,
      messages: openaiMessages,
      tools: tools && tools.length > 0 ? tools : undefined,
      temperature: request.temperature,
      max_completion_tokens: request.max_tokens
    });

    const choice = completion.choices[0];

    // Extract tool calls if any
    const tool_calls = choice.message.tool_calls?.map(tc => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments)
    })) || [];

    return {
      content: choice.message.content || '',
      tool_calls,
      finish_reason: choice.finish_reason,
      usage: {
        prompt_tokens: completion.usage?.prompt_tokens || 0,
        completion_tokens: completion.usage?.completion_tokens || 0,
        total_tokens: completion.usage?.total_tokens || 0
      }
    };
  }

  private async callStreaming(
    request: LLMRequest,
    openaiMessages: ChatCompletionMessageParam[],
    tools: ChatCompletionTool[] | undefined,
    onToken: (token: string) => void
  ): Promise<LLMResponse> {
    const stream = this.client.chat.completions.create({
      model: request.model,
      messages: openaiMessages,
      tools: tools && tools.length > 0 ? tools : undefined,
      temperature: request.temperature,
      max_completion_tokens: request.max_tokens,
      stream: true as const,
      stream_options: { include_usage: true },
    }) as unknown as AsyncIterable<ChatCompletionChunk>;

    let textContent = '';
    const toolCallMap = new Map<number, { id: string; name: string; args: string }>();
    let finishReason = 'stop';
    let usage: LLMResponse['usage'];

    for await (const chunk of stream) {
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
      if (chunk.usage) {
        usage = {
          prompt_tokens: chunk.usage.prompt_tokens,
          completion_tokens: chunk.usage.completion_tokens,
          total_tokens: chunk.usage.total_tokens,
        };
      }
    }

    const tool_calls = Array.from(toolCallMap.values()).map(tc => ({
      id: tc.id,
      name: tc.name,
      arguments: JSON.parse(tc.args || '{}'),
    }));

    return { content: textContent, tool_calls, finish_reason: finishReason, usage };
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
    return request.tools?.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }));
  }
}
