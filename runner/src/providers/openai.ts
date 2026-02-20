/**
 * OpenAI provider implementation with full tool calling support
 */

import type { LLMRequest, LLMResponse, Message } from '@studio/contracts';
import type { Provider } from './provider.js';
import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';

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
    // Convert our Message format to OpenAI format
    const openaiMessages: ChatCompletionMessageParam[] = request.messages.map(msg => {
      if (msg.role === 'system') {
        return { role: 'system', content: msg.content };
      }
      if (msg.role === 'user') {
        return { role: 'user', content: msg.content };
      }
      if (msg.role === 'assistant') {
        return { role: 'assistant', content: msg.content };
      }
      throw new Error(`Unsupported message role: ${msg.role}`);
    });

    // Convert tool definitions to OpenAI format
    const tools: ChatCompletionTool[] | undefined = request.tools?.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }));

    // Make API call
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
}
