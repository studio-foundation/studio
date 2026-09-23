/**
 * Main agent runner function - executes agent with LLM + tools
 */

import type { ResolvedAgentConfig, ToolCall, LLMResponse, Message, OutputContract, RunnerCallbacks, TokenUsage } from '@studio-foundation/contracts';
import { accumulateTokenUsage, emptyTokenUsage } from '@studio-foundation/contracts';
import { buildPrompt, hasFields, type TaskInput, type AgentContext, type ExecutionContext } from './prompt-builder.js';
import { shouldCachePrompt } from './prompt-cache.js';
import { compactMessages } from './compact.js';
import type { ToolRegistry } from './tools/tool-registry.js';
import { ToolExecutor } from './tools/tool-executor.js';
import type { ProviderRegistry } from './providers/registry.js';
import { isAgentLoopProvider } from './providers/provider.js';
import type { AnonymizationMiddleware } from './middleware/anonymization.js';
import type { SkillContent } from './plugins/plugin-loader.js';

/** Prefix used to identify unauthorized tool calls in error messages. */
export const UNAUTHORIZED_TOOL_ERROR_PREFIX = 'Unauthorized tool call:';

export interface RunAgentConfig {
  agent: ResolvedAgentConfig;
  task: TaskInput;
  context: AgentContext;
  executionContext?: ExecutionContext;
  /** The current stage's own resolved context (e.g. `{ input }`), passed through
   *  to tool execution for `from_context` parameters — never seen by the LLM. */
  resolvedContext?: unknown;
  toolRegistry: ToolRegistry;
  providerRegistry: ProviderRegistry;
  /** Resolved config of the agent named in `agent.compact.summarizer`, if `compact` is set. */
  compactAgent?: ResolvedAgentConfig;
  outputContract?: OutputContract;
  /** Markdown chunks from the plugins the agent declares. */
  pluginSkills?: string[];
  /** `.studio/skills/*.skill.md` the agent declares, already read from disk. */
  skills?: SkillContent[];
  /** `.studio/invariants.md` of the project the run belongs to. */
  projectInvariants?: string;
  maxToolCalls?: number;
  anonymizationMiddleware?: AnonymizationMiddleware;
  callbacks?: RunnerCallbacks;
  signal?: AbortSignal;
  /**
   * Aborts the provider call (killing its process/request) if one attempt runs
   * longer than this. Undefined means no timeout — the historical behavior,
   * since a default here would cut off long-running LLM calls unannounced.
   * A fired timeout returns a normal AgentRunResult with `error` set, the same
   * shape script-executor's own timeout returns, so RALPH retries it as an
   * ordinary failed attempt instead of failing the whole stage (STU-1485).
   */
  timeoutMs?: number;
}

/**
 * What one attempt managed to do before it threw. `runAgentAttempt` writes into
 * it as it goes, so the catch in `runAgent` can report the tool calls already
 * executed and the tokens already spent instead of a zeroed result (STU-1489).
 */
interface AttemptProgress {
  tool_calls: ToolCall[];
  token_usage: TokenUsage;
}

export interface AgentRunResult {
  output: unknown;
  tool_calls: ToolCall[];
  tool_calls_count: number;
  raw_response?: LLMResponse;
  duration_ms: number;
  /**
   * What this agent run cost, summed over every turn — including the turns a
   * provider ran internally. Absent when no provider reported anything, so an
   * unmeasured run is never mistaken for a free one.
   */
  token_usage?: TokenUsage;
  /**
   * Set when the attempt failed — max tool iterations, an unauthorized tool, a
   * timeout, or any throw that escaped the provider call. RALPH treats it as a
   * validation failure, which is the point: `runAgent` resolves with it rather
   * than rejecting, so the stage keeps the attempts it has left (STU-1489).
   */
  error?: string;
}

const DEFAULT_MAX_TOOL_CALLS = 20; // Safety limit for tool calling loop
const DEFAULT_KEEP_LAST_TURNS = 2; // Turns kept verbatim by compaction when unset

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
  const { timeoutMs, signal: externalSignal } = config;
  const startTime = Date.now();
  const progress: AttemptProgress = { tool_calls: [], token_usage: emptyTokenUsage() };

  const timeoutController = timeoutMs === undefined ? undefined : new AbortController();
  const timer = timeoutController === undefined
    ? undefined
    : setTimeout(() => timeoutController.abort(), timeoutMs);
  const signal = timeoutController === undefined
    ? externalSignal
    : externalSignal
      ? AbortSignal.any([externalSignal, timeoutController.signal])
      : timeoutController.signal;

  try {
    return await runAgentAttempt(config, signal, progress);
  } catch (err) {
    // The pipeline's own cancellation is the one throw that must keep
    // propagating: ralph reads it as 'cancelled', and swallowing it here would
    // turn a cancelled run into a failed one.
    if (externalSignal?.aborted) {
      throw err;
    }
    // Everything else — a provider network error, a rate limit the SDK raised
    // instead of wrapping, an AgentLoopProvider that rejected rather than
    // resolving with `error` — is one failed attempt, not a stage-ending throw.
    // Returned as an ordinary AgentRunResult so it reaches RALPH with the
    // stage's remaining attempts intact (STU-1489).
    return {
      output: null,
      tool_calls: progress.tool_calls,
      tool_calls_count: progress.tool_calls.filter(tc => !tc.error).length,
      duration_ms: Date.now() - startTime,
      token_usage: progress.token_usage.total_tokens > 0 ? progress.token_usage : undefined,
      error: timeoutController?.signal.aborted
        ? `Agent timed out after ${timeoutMs}ms`
        : `Agent execution failed: ${describeThrown(err)}`,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Message of a thrown value, keeping the error name when it adds something. */
function describeThrown(err: unknown): string {
  if (err instanceof Error) {
    return err.name && err.name !== 'Error' ? `${err.name}: ${err.message}` : err.message;
  }
  return String(err);
}

async function runAgentAttempt(
  config: RunAgentConfig,
  signal: AbortSignal | undefined,
  progress: AttemptProgress,
): Promise<AgentRunResult> {
  const startTime = Date.now();
  const { agent, task, context, executionContext, toolRegistry, providerRegistry } = config;
  const maxToolCalls = config.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const mw = config.anonymizationMiddleware;

  // Get provider
  const provider = providerRegistry.get(agent.provider);

  // Strict whitelist: filter to declared tools, or empty registry if tools is absent/empty.
  // tools: ['a', 'b'] → only a and b visible to LLM
  // tools: []          → no tools visible
  // tools: undefined   → no tools visible (whitelist-by-default)
  const allowedTools = toolRegistry.filter(agent.tools ?? [], { agentName: agent.name });

  const promptSnippets = allowedTools.getActiveSnippets();

  // Injection point 1: Anonymize task input BEFORE building the prompt — the
  // middleware sees structured fields (or the flat description), never an
  // assembled prompt string.
  let taskForPrompt = task;
  if (mw) {
    if (hasFields(task)) {
      taskForPrompt = { ...task, fields: await mw.anonymizeFields(task.fields!, task.anonymize_fields) };
    } else {
      taskForPrompt = { ...task, description: mw.anonymize(task.description) };
    }
  }

  // The context block renders the same input in clear; the Task section already
  // carries it (tokenized or, out of scope, verbatim).
  const contextForPrompt = mw && context.input !== undefined
    ? { ...context, additional_context: undefined }
    : context;

  // Build initial prompt
  const messages = buildPrompt({
    agent,
    task: taskForPrompt,
    context: contextForPrompt,
    executionContext,
    outputContract: config.outputContract,
    promptSnippets,
    pluginSkills: config.pluginSkills,
    skills: config.skills,
    projectInvariants: config.projectInvariants,
  });

  const toolDefinitions = allowedTools.toToolDefinitions();

  // Decided once for the whole run, not per turn: a prefix cached on turn 1 is
  // what turns 2..n read, so flipping the marker mid-run writes a cache the
  // remaining turns never look for.
  const cachePrompt = shouldCachePrompt({
    hasTools: toolDefinitions.length > 0,
    contract: config.outputContract,
    mode: agent.prompt_cache,
  });

  // Tool executor
  const toolExecutor = new ToolExecutor(allowedTools);

  // Track all tool calls made during execution. Shared with the caller so a
  // throw mid-run still reports what already ran.
  const allToolCalls: ToolCall[] = progress.tool_calls;

  // Accumulate token usage across turns, keeping the per-model split so a stage
  // that spanned models can still be priced model by model. Shared for the same
  // reason as allToolCalls: a failed attempt still cost what it cost.
  const tokenAccumulator: TokenUsage = progress.token_usage;

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
        cache_prompt: cachePrompt,
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

        const executed = await toolExecutor.execute({ id: callId, name, arguments: args }, config.resolvedContext);
        allToolCalls.push(executed);

        // Hallucination guard: tool not in whitelist → terminal stage error (RALPH fails, not retries)
        if (executed.error?.startsWith('Tool not found:')) {
          const unauthorizedError = `${UNAUTHORIZED_TOOL_ERROR_PREFIX} agent attempted to use '${name}', which is not in its allowed tool list`;
          config.callbacks?.onToolCallComplete?.({
            tool: name,
            result: undefined,
            error: unauthorizedError,
            duration_ms: Date.now() - tcStart,
            timestamp: Date.now(),
          });
          return { result: undefined, error: unauthorizedError };
        }

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
      accumulateTokenUsage(tokenAccumulator, loopResult.usage);
    }

    const duration = Date.now() - startTime;

    // A provider-reported failure (STU-1488) — resolved, not thrown, precisely
    // so it lands here as a normal retry-eligible failed attempt instead of
    // propagating out of runAgent and skipping RALPH's remaining attempts.
    if (loopResult.error) {
      return {
        output: null,
        tool_calls: allToolCalls,
        tool_calls_count: allToolCalls.filter(tc => !tc.error).length,
        duration_ms: duration,
        token_usage: tokenAccumulator.total_tokens > 0 ? tokenAccumulator : undefined,
        error: loopResult.error,
      };
    }

    const finalContent = mw ? mw.deanonymize(loopResult.content) : loopResult.content;
    const output = parseAgentOutput(finalContent);
    return {
      output,
      tool_calls: allToolCalls,
      tool_calls_count: allToolCalls.filter(tc => !tc.error).length,
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
      json_mode: !!task.contract_name,
      cache_prompt: cachePrompt,
    }, onToken, signal);

    lastResponse = response;

    if (response.usage) {
      accumulateTokenUsage(tokenAccumulator, response.usage);
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
        }, config.resolvedContext);

        // Hallucination guard: tool not in whitelist → terminal stage error
        if (executed.error?.startsWith('Tool not found:')) {
          const unauthorizedError = `${UNAUTHORIZED_TOOL_ERROR_PREFIX} agent attempted to use '${tc.name}', which is not in its allowed tool list`;
          executed = { ...executed, error: unauthorizedError };
          allToolCalls.push(executed);
          config.callbacks?.onToolCallComplete?.({
            tool: tc.name,
            result: undefined,
            error: unauthorizedError,
            duration_ms: Date.now() - tcStart,
            timestamp: Date.now(),
          });
          const duration = Date.now() - startTime;
          return {
            output: null,
            tool_calls: allToolCalls,
            tool_calls_count: 0,
            raw_response: lastResponse!,
            duration_ms: duration,
            token_usage: tokenAccumulator.total_tokens > 0 ? tokenAccumulator : undefined,
            error: unauthorizedError,
          };
        }
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

    // Compact once the prompt that produced this response crossed the configured
    // threshold, checked on real provider-reported usage, never an estimate. This
    // turn's own assistant/tool-result messages are appended after compacting, so
    // they count toward "last N turns" going forward rather than being summarized
    // away the moment they're created.
    if (agent.compact && config.compactAgent && (response.usage?.prompt_tokens ?? 0) >= agent.compact.threshold_tokens) {
      const compacted = await compactMessages(
        currentMessages,
        agent.compact.keep_last_turns ?? DEFAULT_KEEP_LAST_TURNS,
        config.compactAgent,
        providerRegistry,
        signal,
      );
      currentMessages = compacted.messages;
      if (compacted.usage) accumulateTokenUsage(tokenAccumulator, compacted.usage);
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
    const duration = Date.now() - startTime;
    return {
      output: null,
      tool_calls: allToolCalls,
      tool_calls_count: allToolCalls.filter(tc => !tc.error).length,
      raw_response: lastResponse!,
      duration_ms: duration,
      token_usage: tokenAccumulator.total_tokens > 0 ? tokenAccumulator : undefined,
      error: `Maximum tool calling iterations (${maxToolCalls}) reached. Possible infinite loop.`,
    };
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
    tool_calls_count: allToolCalls.filter(tc => !tc.error).length,
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
