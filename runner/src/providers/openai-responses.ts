/**
 * OpenAI Responses API provider — supports models only available on /v1/responses
 * (e.g. gpt-5.1-codex-mini).
 *
 * Implements AgentLoopProvider to own the multi-turn tool-calling loop,
 * because the Responses API uses typed function_call / function_call_output
 * items that cannot be expressed as plain text messages.
 */

import type { LLMRequest, LLMResponse, Message, TokenUsage } from '@studio-foundation/contracts';
import { accumulateTokenUsage, emptyTokenUsage, withModel } from '@studio-foundation/contracts';
import type { AgentLoopProvider, AgentLoopResult, ToolCallOutcome } from './provider.js';
import OpenAI from 'openai';
import type {
  ResponseInputItem,
  ResponseFunctionToolCall,
  ResponseOutputItem,
  FunctionTool,
} from 'openai/resources/responses/responses.js';

export class OpenAIResponsesProvider implements AgentLoopProvider {
  readonly name = 'openai-responses';
  private client: OpenAI;

  constructor(apiKey?: string) {
    this.client = new OpenAI({ apiKey: apiKey || process.env.OPENAI_API_KEY });
  }

  // Satisfy Provider interface for simple (no-tool) calls
  async call(request: LLMRequest, _onToken?: (token: string) => void, signal?: AbortSignal): Promise<LLMResponse> {
    const input = messagesToInput(request.messages);
    const response = await this.client.responses.create({
      model: request.model,
      input,
      temperature: request.temperature,
      max_output_tokens: request.max_tokens ?? undefined,
    }, { signal });

    // NOTE: call() is for tool-free requests only.
    // Tool calls in the response are intentionally discarded.
    // For agentic tool-calling, use runAgentLoop() instead.
    return {
      content: response.output_text ?? '',
      tool_calls: [],
      finish_reason: 'stop',
      usage: normalizeUsage(response.usage, response.model || request.model),
    };
  }

  async runAgentLoop(
    request: LLMRequest,
    executeTool: (name: string, args: Record<string, unknown>, callId: string) => Promise<ToolCallOutcome>,
    onToken?: (token: string) => void,
    signal?: AbortSignal
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
    const tokenAccumulator: TokenUsage = emptyTokenUsage();
    const MAX_ITERATIONS = 20;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      if (signal?.aborted) {
        throw new DOMException('The operation was aborted', 'AbortError');
      }

      let outputItems: ResponseOutputItem[];
      let responseText = '';

      if (onToken) {
        // Streaming path — emit text deltas as they arrive, then get the completed response
        const stream = this.client.responses.stream({
          model: request.model,
          input,
          tools: tools.length > 0 ? tools : undefined,
          temperature: request.temperature,
          max_output_tokens: request.max_tokens ?? undefined,
        });

        for await (const event of stream) {
          if (event.type === 'response.output_text.delta') {
            onToken(event.delta);
            responseText += event.delta;
          }
        }

        const finalResponse = await stream.finalResponse();

        accumulateTokenUsage(
          tokenAccumulator,
          normalizeUsage(finalResponse.usage, finalResponse.model || request.model)
        );

        outputItems = finalResponse.output;

        // Find all function calls in the output
        const functionCalls = outputItems.filter(
          (item): item is ResponseFunctionToolCall => item.type === 'function_call'
        );

        if (functionCalls.length === 0) {
          // No tool calls — done
          return {
            content: responseText,
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
          ...(outputItems as unknown as ResponseInputItem[]),
          ...toolOutputs,
        ];
      } else {
        // Non-streaming path
        const response = await this.client.responses.create({
          model: request.model,
          input,
          tools: tools.length > 0 ? tools : undefined,
          temperature: request.temperature,
          max_output_tokens: request.max_tokens ?? undefined,
        }, { signal });

        accumulateTokenUsage(
          tokenAccumulator,
          normalizeUsage(response.usage, response.model || request.model)
        );

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

/**
 * Map a Responses-API usage block onto Studio's counts. Like Chat Completions,
 * `input_tokens` already includes anything served from cache
 * (`input_tokens_details.cached_tokens`), so the cached part is split back out
 * to keep `prompt_tokens` meaning "input billed at full rate".
 */
function normalizeUsage(
  usage: { input_tokens?: number; output_tokens?: number; total_tokens?: number;
           input_tokens_details?: { cached_tokens?: number } | null } | null | undefined,
  model: string
): TokenUsage | undefined {
  if (!usage) return undefined;
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cachedTokens = Math.min(usage.input_tokens_details?.cached_tokens ?? 0, inputTokens);
  return withModel(model, {
    prompt_tokens: inputTokens - cachedTokens,
    completion_tokens: outputTokens,
    total_tokens: usage.total_tokens ?? inputTokens + outputTokens,
    ...(cachedTokens > 0 ? { cached_input_tokens: cachedTokens } : {}),
  });
}
