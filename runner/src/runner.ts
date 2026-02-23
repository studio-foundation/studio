/**
 * Main agent runner function - executes agent with LLM + tools
 */

import type { AgentConfig, ToolCall, LLMResponse, Message, OutputContract, RunnerCallbacks } from '@studio/contracts';
import { buildPrompt, type TaskInput, type AgentContext, type ExecutionContext } from './prompt-builder.js';
import type { ToolRegistry } from './tools/tool-registry.js';
import { ToolExecutor } from './tools/tool-executor.js';
import type { ProviderRegistry } from './providers/registry.js';
import { isAgentLoopProvider } from './providers/provider.js';
import type { AnonymizationMiddleware } from './middleware/anonymization.js';

export interface RunAgentConfig {
  agent: AgentConfig;
  task: TaskInput;
  context: AgentContext;
  executionContext?: ExecutionContext;
  toolRegistry: ToolRegistry;
  providerRegistry: ProviderRegistry;
  outputContract?: OutputContract;
  maxToolCalls?: number;
  anonymizationMiddleware?: AnonymizationMiddleware;
  callbacks?: RunnerCallbacks;
  signal?: AbortSignal;
}

export interface AgentRunResult {
  output: unknown;
  tool_calls: ToolCall[];
  tool_calls_count: number;
  raw_response: LLMResponse;
  duration_ms: number;
  token_usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

const DEFAULT_MAX_TOOL_CALLS = 20; // Safety limit for tool calling loop

/**
 * Run an agent task with LLM + tool execution
 *
 * Flow:
 * 1. Build prompt with context + retry info
 * 2. Call LLM provider
 * 3. Execute tool calls (multi-turn loop)
 * 4. Return complete result with tracked tool calls
 */
export async function runAgent(config: RunAgentConfig): Promise<AgentRunResult> {
  const startTime = Date.now();
  const { agent, task, context, executionContext, toolRegistry, providerRegistry, signal } = config;
  const maxToolCalls = config.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const mw = config.anonymizationMiddleware;

  // Get provider
  const provider = providerRegistry.get(agent.provider);

  // Get allowed tools for this agent (filter if specified)
  const allowedTools = agent.tools && agent.tools.length > 0
    ? toolRegistry.filter(agent.tools)
    : toolRegistry;

  const promptSnippets = allowedTools.getActiveSnippets();

  // Injection point 1: Anonymize task input before building prompt
  const taskForPrompt = mw
    ? { ...task, description: mw.anonymize(task.description) }
    : task;

  // Build initial prompt
  const messages = buildPrompt({
    agent,
    task: taskForPrompt,
    context,
    executionContext,
    outputContract: config.outputContract,
    promptSnippets,
  });

  const toolDefinitions = allowedTools.toToolDefinitions();

  // Tool executor
  const toolExecutor = new ToolExecutor(allowedTools);

  // Track all tool calls made during execution
  const allToolCalls: ToolCall[] = [];

  // Accumulate token usage across turns
  const tokenAccumulator = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  // Build onToken wrapper that bridges provider token callbacks → RunnerCallbacks.onAgentToken
  const onToken = config.callbacks?.onAgentToken
    ? (token: string) => config.callbacks!.onAgentToken!({ token, timestamp: Date.now() })
    : undefined;

  // --- Delegate to provider if it owns the full agent loop (e.g. Responses API) ---
  if (isAgentLoopProvider(provider)) {
    const loopResult = await provider.runAgentLoop(
      {
        model: agent.model,
        messages,
        tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
        temperature: agent.temperature,
        max_tokens: agent.max_tokens,
        stage_name: task.contract_name,
      },
      async (name, args, callId) => {
        const tcStart = Date.now();
        config.callbacks?.onToolCallStart?.({
          tool: name,
          params: args,
          timestamp: tcStart,
        });

        // pre_tool_use: check if hook wants to block this tool call
        if (config.callbacks?.onPreToolUse) {
          const preResult = await config.callbacks.onPreToolUse({ tool: name, params: args, timestamp: tcStart });
          if (preResult.blocked) {
            const blockedCall: ToolCall = {
              id: callId,
              name,
              arguments: args,
              error: preResult.error ?? 'Pre-tool hook blocked execution',
            };
            allToolCalls.push(blockedCall);
            return { result: undefined, error: blockedCall.error };
          }
        }

        const executed = await toolExecutor.execute({ id: callId, name, arguments: args });
        allToolCalls.push(executed);

        config.callbacks?.onToolCallComplete?.({
          tool: name,
          result: executed.result,
          error: executed.error,
          duration_ms: Date.now() - tcStart,
          timestamp: Date.now(),
        });

        // post_tool_use: notify (append_message not injected in agent loop path — provider controls conversation)
        if (config.callbacks?.onPostToolUse) {
          await config.callbacks.onPostToolUse({
            tool: name,
            params: args,
            result: executed.result,
            error: executed.error,
            timestamp: Date.now(),
          });
        }

        // Injection point 2: Anonymize tool results before returning to LLM
        let result = executed.result;
        if (mw && result !== undefined) {
          const resultStr = mw.anonymize(JSON.stringify(result));
          try { result = JSON.parse(resultStr); } catch { result = resultStr; }
        }
        return { result, error: executed.error };
      },
      onToken,
      signal
    );

    if (loopResult.usage) {
      tokenAccumulator.prompt_tokens += loopResult.usage.prompt_tokens;
      tokenAccumulator.completion_tokens += loopResult.usage.completion_tokens;
      tokenAccumulator.total_tokens += loopResult.usage.total_tokens;
    }

    const finalContent = mw ? mw.deanonymize(loopResult.content) : loopResult.content;
    const output = parseAgentOutput(finalContent);
    const duration = Date.now() - startTime;
    return {
      output,
      tool_calls: allToolCalls,
      tool_calls_count: allToolCalls.length,
      raw_response: {
        content: loopResult.content,
        tool_calls: loopResult.tool_calls.map(tc => ({ id: tc.id, name: tc.name, arguments: tc.arguments })),
        finish_reason: loopResult.finish_reason,
        usage: loopResult.usage,
      },
      duration_ms: duration,
      token_usage: tokenAccumulator.total_tokens > 0 ? tokenAccumulator : undefined,
    };
  }

  // --- Standard multi-turn loop (Chat Completions style) ---
  let currentMessages: Message[] = messages;
  let iterations = 0;
  let lastResponse: LLMResponse | null = null;

  while (iterations < maxToolCalls) {
    // Check for cancellation before calling LLM
    if (signal?.aborted) {
      throw new DOMException('The operation was aborted', 'AbortError');
    }

    // Call LLM
    const response = await provider.call({
      model: agent.model,
      messages: currentMessages,
      tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
      temperature: agent.temperature,
      max_tokens: agent.max_tokens,
      stage_name: task.contract_name,
    }, onToken, signal);

    lastResponse = response;

    if (response.usage) {
      tokenAccumulator.prompt_tokens += response.usage.prompt_tokens;
      tokenAccumulator.completion_tokens += response.usage.completion_tokens;
      tokenAccumulator.total_tokens += response.usage.total_tokens;
    }

    // Check if there are tool calls to execute
    if (!response.tool_calls || response.tool_calls.length === 0) {
      // No tool calls - this is the final response
      break;
    }

    // Emit thinking/progress if the LLM produced text alongside tool calls
    const thinkingText = response.content?.trim();
    if (thinkingText) {
      const now = Date.now();
      if (iterations === 0) {
        config.callbacks?.onAgentThinking?.({ thought: thinkingText, timestamp: now });
      } else {
        config.callbacks?.onAgentProgress?.({ message: thinkingText, timestamp: now });
      }
    }

    // Execute each tool call
    const executedToolCalls: ToolCall[] = [];
    const appendMessages = new Map<string, string>(); // tc.id → post-hook message

    for (const tc of response.tool_calls) {
      const tcStart = Date.now();
      config.callbacks?.onToolCallStart?.({
        tool: tc.name,
        params: tc.arguments,
        timestamp: tcStart,
      });

      // pre_tool_use: check if hook wants to block this tool call
      let executed!: ToolCall;
      let wasBlocked = false;
      if (config.callbacks?.onPreToolUse) {
        const preResult = await config.callbacks.onPreToolUse({
          tool: tc.name,
          params: tc.arguments,
          timestamp: tcStart,
        });
        if (preResult.blocked) {
          wasBlocked = true;
          executed = {
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
            error: preResult.error ?? 'Pre-tool hook blocked execution',
          };
        }
      }

      if (!wasBlocked) {
        executed = await toolExecutor.execute({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        });
      }

      executedToolCalls.push(executed);
      allToolCalls.push(executed);

      if (!wasBlocked) {
        config.callbacks?.onToolCallComplete?.({
          tool: tc.name,
          result: executed.result,
          error: executed.error,
          duration_ms: Date.now() - tcStart,
          timestamp: Date.now(),
        });
      }

      // post_tool_use: only called if tool was not blocked
      if (!wasBlocked && config.callbacks?.onPostToolUse) {
        const postResult = await config.callbacks.onPostToolUse({
          tool: tc.name,
          params: tc.arguments,
          result: executed.result,
          error: executed.error,
          timestamp: Date.now(),
        });
        if (postResult.append_message) {
          appendMessages.set(tc.id, postResult.append_message);
        }
      }
    }

    // Add assistant message with tool calls to conversation
    currentMessages.push({
      role: 'assistant',
      content: response.content || ''
    });

    // Add tool results as user messages
    // Format them clearly so the LLM can understand the results
    const toolResultsMessage = executedToolCalls.map(tc => {
      let msg: string;
      if (tc.error) {
        msg = `Tool ${tc.name} (id: ${tc.id}) failed: ${tc.error}`;
      } else {
        msg = `Tool ${tc.name} (id: ${tc.id}) result: ${JSON.stringify(tc.result)}`;
      }
      const appendMsg = appendMessages.get(tc.id);
      if (appendMsg) {
        msg += `\n\nPost-hook note: ${appendMsg}`;
      }
      return msg;
    }).join('\n\n');

    const toolResultContent = `Tool execution results:\n\n${toolResultsMessage}`;
    currentMessages.push({
      role: 'user',
      // Injection point 4: Anonymize tool results before adding to conversation
      content: mw ? mw.anonymize(toolResultContent) : toolResultContent,
    });

    iterations++;
  }

  if (iterations >= maxToolCalls) {
    throw new Error(`Maximum tool calling iterations (${maxToolCalls}) reached. Possible infinite loop.`);
  }

  if (!lastResponse) {
    throw new Error('No response received from LLM');
  }

  // Parse final output from the last response content
  const finalContent = mw ? mw.deanonymize(lastResponse.content) : lastResponse.content;
  const output = parseAgentOutput(finalContent);

  const duration = Date.now() - startTime;

  return {
    output,
    tool_calls: allToolCalls,
    tool_calls_count: allToolCalls.length,
    raw_response: lastResponse,
    duration_ms: duration,
    token_usage: tokenAccumulator.total_tokens > 0 ? tokenAccumulator : undefined,
  };
}

function parseAgentOutput(rawContent: string): unknown {
  // Try 1: Direct JSON parse
  try {
    return JSON.parse(rawContent);
  } catch {}

  // Try 2: Extract from markdown code block
  const codeBlockMatch = rawContent.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch {}
  }

  // Try 3: Find first { ... } in the response
  const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {}
  }

  // Failed to parse — return raw string, ralph validation will reject it
  return rawContent;
}
