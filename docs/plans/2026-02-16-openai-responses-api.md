# OpenAI Responses API Provider Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `openai-responses` as a second OpenAI provider that uses `/v1/responses` instead of `/v1/chat/completions`, supporting models like `gpt-5.1-codex-mini` that only work on the new endpoint.

**Architecture:** Extend `runner/src/providers/provider.ts` with an optional `AgentLoopProvider` interface whose `runAgentLoop()` handles the full tool-calling loop natively (needed because the Responses API uses typed `function_call`/`function_call_output` items, not plain text messages). The runner detects this capability and delegates; existing providers (openai, anthropic) are unaffected.

**Tech Stack:** OpenAI Node SDK v4.77+ (`client.responses.create`), TypeScript, existing `@studio/contracts` types.

---

## Context — Why a New Interface?

The current runner multi-turn loop appends tool results as plain text user messages. The Responses API requires typed `function_call_output` items with `call_id` references. These are incompatible — the provider must own the loop to pass tool results in the correct format.

---

### Task 1: Extend the Provider interface with optional `runAgentLoop`

**Files:**
- Modify: `runner/src/providers/provider.ts`

**Step 1: Add the `AgentLoopProvider` interface**

Replace the full content of `runner/src/providers/provider.ts` with:

```typescript
/**
 * Provider interface - aligned with @studio/contracts
 */

import type { LLMRequest, LLMResponse, ToolDefinition } from '@studio/contracts';

export interface Provider {
  readonly name: string;
  call(request: LLMRequest): Promise<LLMResponse>;
}

/**
 * Extended interface for providers that own the full agent loop.
 * Used by providers (e.g. OpenAI Responses API) where multi-turn
 * tool calling cannot be expressed as plain text messages.
 */
export interface AgentLoopProvider extends Provider {
  runAgentLoop(
    request: LLMRequest,
    executeTool: (name: string, args: Record<string, unknown>, callId: string) => Promise<{ result?: unknown; error?: string }>
  ): Promise<AgentLoopResult>;
}

export interface AgentLoopResult {
  content: string;
  tool_calls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    result?: unknown;
    error?: string;
  }>;
  finish_reason: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export function isAgentLoopProvider(p: Provider): p is AgentLoopProvider {
  return typeof (p as AgentLoopProvider).runAgentLoop === 'function';
}
```

**Step 2: Build to verify no type errors**

```bash
cd runner && npm run build
```
Expected: build succeeds (no changes to existing providers yet).

**Step 3: Commit**

```bash
git add runner/src/providers/provider.ts
git commit -m "feat(runner): add AgentLoopProvider interface for full-loop providers"
```

---

### Task 2: Implement `OpenAIResponsesProvider`

**Files:**
- Create: `runner/src/providers/openai-responses.ts`

**Step 1: Write the provider**

```typescript
/**
 * OpenAI Responses API provider — supports models only available on /v1/responses
 * (e.g. gpt-5.1-codex-mini, codex-mini-latest).
 *
 * Implements AgentLoopProvider to own the multi-turn tool-calling loop,
 * because the Responses API uses typed function_call / function_call_output
 * items that cannot be expressed as plain text messages.
 */

import type { LLMRequest, LLMResponse, Message } from '@studio/contracts';
import type { Provider, AgentLoopProvider, AgentLoopResult } from './provider.js';
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
  async call(request: LLMRequest): Promise<LLMResponse> {
    const input = messagesToInput(request.messages);
    const response = await this.client.responses.create({
      model: request.model,
      input,
      temperature: request.temperature,
      max_output_tokens: request.max_tokens ?? undefined,
    });

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
    executeTool: (name: string, args: Record<string, unknown>, callId: string) => Promise<{ result?: unknown; error?: string }>
  ): Promise<AgentLoopResult> {
    const tools: FunctionTool[] = (request.tools ?? []).map(t => ({
      type: 'function' as const,
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      strict: false,
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
        const { result, error } = await executeTool(fc.name, args, fc.call_id);

        allToolCalls.push({ id: fc.call_id, name: fc.name, arguments: args, result, error });

        toolOutputs.push({
          type: 'function_call_output',
          call_id: fc.call_id,
          output: error ? `Error: ${error}` : JSON.stringify(result),
        } as ResponseInputItem);
      }

      // Extend input with the response output items + tool results
      input = [...input, ...response.output as ResponseInputItem[], ...toolOutputs];
    }

    throw new Error(`Maximum tool calling iterations (${MAX_ITERATIONS}) reached.`);
  }
}

function messagesToInput(messages: Message[]): ResponseInputItem[] {
  return messages.map(msg => ({
    role: msg.role as 'user' | 'assistant' | 'system',
    content: msg.content,
  })) as ResponseInputItem[];
}
```

**Step 2: Build**

```bash
cd runner && npm run build
```
Expected: build succeeds.

**Step 3: Commit**

```bash
git add runner/src/providers/openai-responses.ts
git commit -m "feat(runner): add OpenAIResponsesProvider using /v1/responses endpoint"
```

---

### Task 3: Update runner to delegate to `runAgentLoop` when available

**Files:**
- Modify: `runner/src/runner.ts`

**Step 1: Import the new type guard and update the loop**

At the top of `runner.ts`, add the import:

```typescript
import { isAgentLoopProvider } from './providers/provider.js';
```

Replace the section in `runAgent` from `// Multi-turn conversation loop` to the end of the while loop (lines ~78–143) with:

```typescript
  // --- Delegate to provider if it owns the loop (e.g. Responses API) ---
  if (isAgentLoopProvider(provider)) {
    const loopResult = await provider.runAgentLoop(
      {
        model: agent.model,
        messages: currentMessages,
        tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
        temperature: agent.temperature,
        max_tokens: agent.max_tokens,
      },
      async (name, args, callId) => {
        const executed = await toolExecutor.execute({ id: callId, name, arguments: args });
        if (executed.result !== undefined || executed.error !== undefined) {
          allToolCalls.push(executed);
        }
        return { result: executed.result, error: executed.error };
      }
    );

    if (loopResult.usage) {
      tokenAccumulator.prompt_tokens += loopResult.usage.prompt_tokens;
      tokenAccumulator.completion_tokens += loopResult.usage.completion_tokens;
      tokenAccumulator.total_tokens += loopResult.usage.total_tokens;
    }

    // allToolCalls were pushed inside the callback above
    const output = parseAgentOutput(loopResult.content);
    const duration = Date.now() - startTime;
    return {
      output,
      tool_calls: allToolCalls,
      tool_calls_count: allToolCalls.length,
      raw_response: {
        content: loopResult.content,
        tool_calls: loopResult.tool_calls,
        finish_reason: loopResult.finish_reason,
        usage: loopResult.usage,
      },
      duration_ms: duration,
      token_usage: tokenAccumulator.total_tokens > 0 ? tokenAccumulator : undefined,
    };
  }

  // --- Standard multi-turn loop (Chat Completions style) ---
  let iterations = 0;
  let lastResponse: LLMResponse | null = null;

  while (iterations < MAX_TOOL_ITERATIONS) {
    // ... (keep existing loop code exactly as-is)
  }
```

**Step 2: Build**

```bash
cd runner && npm run build
```
Expected: build succeeds.

**Step 3: Commit**

```bash
git add runner/src/runner.ts
git commit -m "feat(runner): delegate to AgentLoopProvider.runAgentLoop when available"
```

---

### Task 4: Register the new provider in the registry

**Files:**
- Modify: `runner/src/providers/registry.ts`

**Step 1: Import and register `OpenAIResponsesProvider`**

Add the import after the existing OpenAI import:
```typescript
import { OpenAIResponsesProvider } from './openai-responses.js';
```

In the `createDefaultRegistry` function config, add:
```typescript
openaiResponses?: { apiKey: string };
```

And register it alongside the existing OpenAI provider:
```typescript
if (config.openaiResponses) {
  registry.register(new OpenAIResponsesProvider(config.openaiResponses.apiKey));
}
```

**Step 2: Find where the registry is created and add `openaiResponses` config**

Search for `createDefaultRegistry` call sites:
```bash
grep -rn "createDefaultRegistry" runner/src/ engine/src/
```

Update the call site to pass `openaiResponses` with the same API key as `openai` (they share the same key):
```typescript
openaiResponses: config.openai  // same key, different endpoint
```

**Step 3: Build runner and engine**

```bash
cd runner && npm run build
cd ../engine && npm run build
```
Expected: both build successfully.

**Step 4: Commit**

```bash
git add runner/src/providers/registry.ts
git commit -m "feat(runner): register openai-responses provider in default registry"
```

---

### Task 5: Update agent YAMLs to use the new provider

**Files:**
- Modify: `engine/configs/software/agents/analyst.agent.yaml`
- Modify: `engine/configs/software/agents/coder.agent.yaml`

**Step 1: Update analyst**

Change `provider: openai` → `provider: openai-responses`

**Step 2: Update coder**

Change `provider: openai` → `provider: openai-responses`

**Step 3: Verify by running the pipeline**

```bash
studio run software/feature-builder --input-file engine/configs/software/inputs/faq-about.input.yaml
```
Expected: stages progress without 404 errors.

**Step 4: Commit**

```bash
git add engine/configs/software/agents/analyst.agent.yaml engine/configs/software/agents/coder.agent.yaml
git commit -m "config: switch analyst and coder agents to openai-responses provider"
```

---

## Build Order Reminder

After modifying runner:
```bash
cd runner && npm run build
cd ../engine && npm run build  # if engine imports runner
```

## Notes on TypeScript Casting

The `response.output` typing may require a cast when spreading into input. If `as ResponseInputItem[]` causes a TypeScript error, use:
```typescript
input = [...input, ...(response.output as unknown as ResponseInputItem[]), ...toolOutputs];
```
This is safe — the Responses API guarantees these output items are valid as subsequent input items.
