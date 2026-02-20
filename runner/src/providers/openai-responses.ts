/**
 * OpenAI Responses API provider — supports models only available on /v1/responses
 * (e.g. gpt-5.1-codex-mini).
 *
 * Implements AgentLoopProvider to own the multi-turn tool-calling loop,
 * because the Responses API uses typed function_call / function_call_output
 * items that cannot be expressed as plain text messages.
 */

import type { LLMRequest, LLMResponse, Message } from '@studio/contracts';
import type { AgentLoopProvider, AgentLoopResult, ToolCallOutcome } from './provider.js';
import OpenAI from 'openai';
import type {
  ResponseInputItem,
  ResponseFunctionToolCall,
  FunctionTool,
} from 'openai/resources/responses/responses.js';

export class OpenAIResponsesProvider implements AgentLoopProvider {
  readonly name = 'openai-responses';
  private client: OpenAI;

  constructor(apiKey?: string) {
    this.client = new OpenAI({ apiKey: apiKey || process.env.OPENAI_API_KEY });
  }

  // Satisfy Provider interface for simple (no-tool) calls
  async call(request: LLMRequest, _onToken?: (token: string) => void): Promise<LLMResponse> {
    const input = messagesToInput(request.messages);
    const response = await this.client.responses.create({
      model: request.model,
      input,
      temperature: request.temperature,
      max_output_tokens: request.max_tokens ?? undefined,
    });

    // NOTE: call() is for tool-free requests only.
    // Tool calls in the response are intentionally discarded.
    // For agentic tool-calling, use runAgentLoop() instead.
    return {
      content: response.output_text ?? '',
      tool_calls: [],
      finish_reason: 'stop',
      usage: response.usage
        ? {
            prompt_tokens: response.usage.input_tokens,
            completion_tokens: response.usage.output_tokens,
            total_tokens: response.usage.total_tokens,
          }
        : undefined,
    };
  }

  async runAgentLoop(
    request: LLMRequest,
    executeTool: (name: string, args: Record<string, unknown>, callId: string) => Promise<ToolCallOutcome>,
    onToken?: (token: string) => void
  ): Promise<AgentLoopResult> {
    const tools: FunctionTool[] = (request.tools ?? []).map(t => ({
      type: 'function' as const,
      name: t.name,
      description: t.description ?? null,
      parameters: t.parameters as Record<string, unknown> | null,
      strict: null,
    }));

    let input: ResponseInputItem[] = messagesToInput(request.messages);
    const allToolCalls: AgentLoopResult['tool_calls'] = [];
    const tokenAccumulator = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const MAX_ITERATIONS = 20;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await this.client.responses.create({
        model: request.model,
        input,
        tools: tools.length > 0 ? tools : undefined,
        temperature: request.temperature,
        max_output_tokens: request.max_tokens ?? undefined,
      });

      if (response.usage) {
        tokenAccumulator.prompt_tokens += response.usage.input_tokens;
        tokenAccumulator.completion_tokens += response.usage.output_tokens;
        tokenAccumulator.total_tokens += response.usage.total_tokens;
      }

      // Find all function calls in the output
      const functionCalls = response.output.filter(
        (item): item is ResponseFunctionToolCall => item.type === 'function_call'
      );

      if (functionCalls.length === 0) {
        // No tool calls — done
        return {
          content: response.output_text ?? '',
          tool_calls: allToolCalls,
          finish_reason: 'stop',
          usage: tokenAccumulator.total_tokens > 0 ? tokenAccumulator : undefined,
        };
      }

      // Execute all tool calls
      const toolOutputs: ResponseInputItem[] = [];
      for (const fc of functionCalls) {
        const args = JSON.parse(fc.arguments) as Record<string, unknown>;
        const outcome = await executeTool(fc.name, args, fc.call_id);

        allToolCalls.push({ id: fc.call_id, name: fc.name, arguments: args, ...outcome });

        toolOutputs.push({
          type: 'function_call_output',
          call_id: fc.call_id,
          output: outcome.error ? `Error: ${outcome.error}` : JSON.stringify(outcome.result),
        } as ResponseInputItem.FunctionCallOutput);
      }

      // Extend input: previous input + this response's output items + tool results
      // ResponseOutputItem is a subset of the ResponseInputItem union, so the cast is safe
      input = [
        ...input,
        ...(response.output as unknown as ResponseInputItem[]),
        ...toolOutputs,
      ];
    }

    throw new Error(`Maximum tool calling iterations (${MAX_ITERATIONS}) reached.`);
  }
}

function messagesToInput(messages: Message[]): ResponseInputItem[] {
  return messages.map(msg => ({
    type: 'message' as const,
    role: msg.role as 'user' | 'assistant' | 'system',
    content: msg.content,
  }));
}
