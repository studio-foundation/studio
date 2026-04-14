# STU-120: Graceful Shutdown Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire AbortController from CLI through engine/ralph/runner/providers so Ctrl-C cleanly cancels a pipeline run.

**Architecture:** AbortSignal threading — CLI creates AbortController, passes signal down. Each layer checks `signal.aborted` at its natural checkpoints. Two-phase Ctrl-C: first cooperative, second force-kill.

**Tech Stack:** Node.js AbortController (native), Anthropic SDK signal support, OpenAI SDK signal support, vitest.

**Worktree:** `.worktrees/stu-120-graceful-shutdown` (branch `arianedguay/stu-120-graceful-shutdown-sur-ctrl-c-sigintsigterm`)

---

### Task 1: Add `cancelled` to StageStatus in contracts

**Files:**
- Modify: `contracts/src/stage.ts:3`
- Test: `engine/tests/status-derivation.test.ts` (existing, will update in Task 3)

**Step 1: Add `cancelled` to the union type**

In `contracts/src/stage.ts`, line 3, change:

```typescript
export type StageStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'rejected' | 'cancelled';
```

**Step 2: Build to verify**

Run: `pnpm build`
Expected: PASS (no consumers use exhaustive switch on StageStatus yet besides status-derivation, which we update in Task 3)

**Step 3: Commit**

```bash
git add contracts/src/stage.ts
git commit -m "feat(contracts): add 'cancelled' to StageStatus type"
```

---

### Task 2: Add `cancelled` variant to RalphResult and signal support to ralph loop

**Files:**
- Modify: `ralph/src/loop.ts`
- Test: `ralph/tests/loop.test.ts`

**Step 1: Write the failing tests**

Append to `ralph/tests/loop.test.ts`:

```typescript
  it('returns cancelled immediately when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const executor = vi.fn().mockResolvedValue('result');
    const validator = vi.fn().mockReturnValue({ valid: true, errors: [], warnings: [] });

    const result = await ralph({
      executor,
      validator,
      maxAttempts: 3,
      retryStrategy: noDelay(),
      signal: controller.signal,
    });

    expect(result.status).toBe('cancelled');
    expect(executor).not.toHaveBeenCalled();
  });

  it('returns cancelled when signal aborts between attempts', async () => {
    const controller = new AbortController();

    const executor = vi.fn().mockResolvedValue('result');
    const validator = vi.fn().mockReturnValueOnce({ valid: false, errors: ['fail'], warnings: [] });

    // Abort after first validation
    validator.mockImplementationOnce(() => {
      controller.abort();
      return { valid: false, errors: ['fail 2'], warnings: [] };
    });

    const result = await ralph({
      executor,
      validator,
      maxAttempts: 5,
      retryStrategy: noDelay(),
      signal: controller.signal,
    });

    expect(result.status).toBe('cancelled');
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('returns cancelled when executor throws AbortError', async () => {
    const controller = new AbortController();

    const executor = vi.fn().mockImplementation(async () => {
      controller.abort();
      const err = new DOMException('The operation was aborted', 'AbortError');
      throw err;
    });
    const validator = vi.fn();

    const result = await ralph({
      executor,
      validator,
      maxAttempts: 3,
      retryStrategy: noDelay(),
      signal: controller.signal,
    });

    expect(result.status).toBe('cancelled');
    expect(validator).not.toHaveBeenCalled();
  });

  it('cancellation resolves pending retry delay immediately', async () => {
    const controller = new AbortController();

    let attempt = 0;
    const executor = vi.fn().mockImplementation(async () => {
      attempt++;
      if (attempt === 1) {
        // After first attempt, schedule abort in 5ms (well before any real delay)
        setTimeout(() => controller.abort(), 5);
      }
      return 'result';
    });
    const validator = vi.fn().mockReturnValue({ valid: false, errors: ['fail'], warnings: [] });

    const start = Date.now();
    const result = await ralph({
      executor,
      validator,
      maxAttempts: 5,
      retryStrategy: { getDelay: () => 60_000 }, // 60 second delay — should NOT wait
      signal: controller.signal,
    });

    const elapsed = Date.now() - start;
    expect(result.status).toBe('cancelled');
    expect(elapsed).toBeLessThan(5000); // Way less than 60s
  });
```

**Step 2: Run tests to verify they fail**

Run: `cd ralph && pnpm test`
Expected: FAIL — `signal` is not a valid property in RalphConfig

**Step 3: Implement signal support in ralph**

Replace the entire `ralph/src/loop.ts` with:

```typescript
// RALPH loop - main function
import type { ValidationResult } from '@studio-foundation/contracts';

export interface ExecutionContext {
  attempt: number;
  previousFailures: string[];
}

export interface RetryEvent<T> {
  attempt: number;
  result: T;
  validation: ValidationResult;
  allFailures: string[];
}

export interface RetryStrategy {
  getDelay(attempt: number): number;
}

export interface RalphConfig<T> {
  executor: (context: ExecutionContext) => Promise<T>;
  validator: (result: T) => ValidationResult | Promise<ValidationResult>;
  maxAttempts: number;
  retryStrategy: RetryStrategy;
  onRetry?: (event: RetryEvent<T>) => void | Promise<void>;
  onSuccess?: (result: T, attempts: number) => void | Promise<void>;
  onExhausted?: (lastResult: T, allFailures: string[]) => void | Promise<void>;
  signal?: AbortSignal;
}

export type RalphResult<T> =
  | { status: 'success'; result: T; attempts: number }
  | { status: 'exhausted'; lastResult: T; failures: string[]; attempts: number }
  | { status: 'cancelled'; lastResult?: T; attempts: number };

export async function ralph<T>(config: RalphConfig<T>): Promise<RalphResult<T>> {
  const { executor, validator, maxAttempts, retryStrategy, onRetry, onSuccess, onExhausted, signal } = config;

  let attempt = 1;
  const allFailures: string[] = [];
  let lastResult: T | undefined;

  while (attempt <= maxAttempts) {
    // Check cancellation before each attempt
    if (signal?.aborted) {
      return { status: 'cancelled', lastResult, attempts: attempt };
    }

    // 1. Execute avec contexte
    const context: ExecutionContext = {
      attempt,
      previousFailures: [...allFailures]
    };

    let result: T;
    try {
      result = await executor(context);
    } catch (err) {
      // If signal was aborted, the executor likely threw an AbortError
      if (signal?.aborted) {
        return { status: 'cancelled', lastResult, attempts: attempt };
      }
      throw err; // Re-throw non-abort errors
    }

    lastResult = result;

    // 2. Validate
    const validation = await Promise.resolve(validator(result));

    // 3. Si valide → SUCCESS
    if (validation.valid) {
      await onSuccess?.(result, attempt);
      return { status: 'success', result, attempts: attempt };
    }

    // 4. Si invalide → accumuler erreurs
    allFailures.push(...validation.errors);

    // 5. Si dernière tentative → EXHAUSTED
    if (attempt >= maxAttempts) {
      await onExhausted?.(result, allFailures);
      return { status: 'exhausted', lastResult: result, attempts: attempt, failures: allFailures };
    }

    // Check cancellation before retry
    if (signal?.aborted) {
      return { status: 'cancelled', lastResult: result, attempts: attempt };
    }

    // 6. Callback + delay + retry
    const retryEvent: RetryEvent<T> = {
      attempt,
      result,
      validation,
      allFailures: [...allFailures]
    };
    await onRetry?.(retryEvent);

    const delay = retryStrategy.getDelay(attempt);
    if (delay > 0) {
      await abortableDelay(delay, signal);
    }

    attempt++;
  }

  // Unreachable mais TypeScript est content
  throw new Error('ralph loop should have returned');
}

/** Sleep that resolves immediately if signal is aborted */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
```

**Step 4: Run tests to verify they pass**

Run: `cd ralph && pnpm test`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add ralph/src/loop.ts ralph/tests/loop.test.ts
git commit -m "feat(ralph): add signal support for cancellation"
```

---

### Task 3: Update deriveStageStatus for `cancelled`

**Files:**
- Modify: `engine/src/state/status-derivation.ts`
- Modify: `engine/tests/status-derivation.test.ts`

**Step 1: Write the failing test**

Append to `engine/tests/status-derivation.test.ts`, inside the `describe` block:

```typescript
  it('ralph cancelled → stage cancelled', () => {
    const ralphResult = {
      status: 'cancelled' as const,
      lastResult: undefined,
      attempts: 2,
    };

    const stageStatus = deriveStageStatus(ralphResult as any);
    expect(stageStatus).toBe('cancelled');
  });
```

**Step 2: Run test to verify it fails**

Run: `cd engine && pnpm test -- tests/status-derivation.test.ts`
Expected: FAIL — "Unknown ralph status: cancelled"

**Step 3: Add `cancelled` mapping to deriveStageStatus**

In `engine/src/state/status-derivation.ts`, after the `exhausted` check (line 27), add:

```typescript
  if (ralphResult.status === 'cancelled') {
    return 'cancelled';
  }
```

**Step 4: Run test to verify it passes**

Run: `cd engine && pnpm test -- tests/status-derivation.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add engine/src/state/status-derivation.ts engine/tests/status-derivation.test.ts
git commit -m "feat(engine): map ralph cancelled → stage cancelled in status derivation"
```

---

### Task 4: Add signal to Provider interface and Anthropic provider

**Files:**
- Modify: `runner/src/providers/provider.ts:7-10,22-27`
- Modify: `runner/src/providers/anthropic.ts:25-38`
- Test: `runner/tests/anthropic.test.ts`

**Step 1: Write the failing test**

Append to `runner/tests/anthropic.test.ts`. If the file only tests with real API keys (skip pattern), create a focused unit test at the top:

```typescript
describe('AnthropicProvider abort signal', () => {
  it('accepts signal parameter in call()', () => {
    // Type-level test: this should compile without errors
    const provider = new AnthropicProvider('fake-key');
    const controller = new AbortController();
    // We don't actually call it (would hit the API), just verify the signature
    expect(typeof provider.call).toBe('function');
    expect(provider.call.length).toBeGreaterThanOrEqual(1);
  });
});
```

**Step 2: Update Provider interface**

In `runner/src/providers/provider.ts`, change line 9:

```typescript
export interface Provider {
  readonly name: string;
  call(request: LLMRequest, onToken?: (token: string) => void, signal?: AbortSignal): Promise<LLMResponse>;
}
```

And change `AgentLoopProvider` (lines 22-27):

```typescript
export interface AgentLoopProvider extends Provider {
  runAgentLoop(
    request: LLMRequest,
    executeTool: (name: string, args: Record<string, unknown>, callId: string) => Promise<ToolCallOutcome>,
    onToken?: (token: string) => void,
    signal?: AbortSignal
  ): Promise<AgentLoopResult>;
}
```

**Step 3: Update AnthropicProvider**

In `runner/src/providers/anthropic.ts`, change the `call` method signature (line 25) and pass signal to SDK:

```typescript
  async call(request: LLMRequest, onToken?: (token: string) => void, signal?: AbortSignal): Promise<LLMResponse> {
    const params = this.buildParams(request);

    if (onToken) {
      // Streaming path
      const stream = this.client.messages.stream(params, { signal });
      stream.on('text', (textDelta: string) => onToken(textDelta));
      const response = await stream.finalMessage();
      return this.parseResponse(response);
    }

    // Non-streaming path
    const response = await this.client.messages.create(params, { signal });
    return this.parseResponse(response);
  }
```

**Step 4: Build to verify all providers compile**

Run: `pnpm build`
Expected: May fail on other providers that need signature update — fix in next steps.

**Step 5: Update OpenAI provider**

In `runner/src/providers/openai.ts`, change the `call` method signature (line 21):

```typescript
  async call(request: LLMRequest, onToken?: (token: string) => void, signal?: AbortSignal): Promise<LLMResponse> {
```

In the non-streaming path (around line 30), add `signal`:

```typescript
    const completion = await this.client.chat.completions.create({
      model: request.model,
      messages: openaiMessages,
      tools: tools && tools.length > 0 ? tools : undefined,
      temperature: request.temperature,
      max_completion_tokens: request.max_tokens
    }, { signal });
```

In the `callStreaming` method signature (around line 59), add `signal` parameter:

```typescript
  private async callStreaming(
    request: LLMRequest,
    openaiMessages: ChatCompletionMessageParam[],
    tools: ChatCompletionTool[] | undefined,
    onToken: (token: string) => void,
    signal?: AbortSignal
  ): Promise<LLMResponse> {
```

And pass it to the streaming create call (around line 65):

```typescript
    const stream = this.client.chat.completions.create({
      model: request.model,
      messages: openaiMessages,
      tools: tools && tools.length > 0 ? tools : undefined,
      temperature: request.temperature,
      max_completion_tokens: request.max_tokens,
      stream: true as const,
      stream_options: { include_usage: true },
    }, { signal }) as unknown as AsyncIterable<ChatCompletionChunk>;
```

Also update the call to `callStreaming` inside `call()` (around line 27):

```typescript
      return this.callStreaming(request, openaiMessages, tools, onToken, signal);
```

**Step 6: Update OpenAI Responses provider**

In `runner/src/providers/openai-responses.ts`:

Change `call` signature (line 29):

```typescript
  async call(request: LLMRequest, _onToken?: (token: string) => void, signal?: AbortSignal): Promise<LLMResponse> {
```

Add signal to the `responses.create` call (around line 31):

```typescript
    const response = await this.client.responses.create({
      model: request.model,
      input,
      temperature: request.temperature,
      max_output_tokens: request.max_tokens ?? undefined,
    }, { signal });
```

Change `runAgentLoop` signature (line 55):

```typescript
  async runAgentLoop(
    request: LLMRequest,
    executeTool: (name: string, args: Record<string, unknown>, callId: string) => Promise<ToolCallOutcome>,
    onToken?: (token: string) => void,
    signal?: AbortSignal
  ): Promise<AgentLoopResult> {
```

Add signal to both the streaming and non-streaming create calls within `runAgentLoop`:

For streaming (around line 79): `this.client.responses.stream({...})` — the OpenAI SDK stream helper doesn't take a second options arg. Instead, check `signal?.aborted` at the top of each loop iteration within `runAgentLoop`:

```typescript
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      if (signal?.aborted) {
        throw new DOMException('The operation was aborted', 'AbortError');
      }
      // ... rest of loop
```

For non-streaming creates (line 143), pass signal:

```typescript
      const response = await this.client.responses.create({
        model: request.model,
        input,
        tools: tools.length > 0 ? tools : undefined,
        temperature: request.temperature,
        max_output_tokens: request.max_tokens ?? undefined,
      }, { signal });
```

**Step 7: Update MockProvider**

In `runner/src/providers/mock.ts`:

Change `call` signature (line 18):

```typescript
  async call(_request: LLMRequest, _onToken?: (token: string) => void, _signal?: AbortSignal): Promise<LLMResponse> {
```

Change `runAgentLoop` signature (line 22):

```typescript
  async runAgentLoop(
    request: LLMRequest,
    executeTool: (name: string, args: Record<string, unknown>, callId: string) => Promise<ToolCallOutcome>,
    onToken?: (token: string) => void,
    _signal?: AbortSignal
  ): Promise<AgentLoopResult> {
```

**Step 8: Build and test**

Run: `pnpm build && pnpm test`
Expected: ALL PASS

**Step 9: Commit**

```bash
git add runner/src/providers/
git commit -m "feat(runner): add abort signal to Provider interface and all implementations"
```

---

### Task 5: Thread signal through runAgent

**Files:**
- Modify: `runner/src/runner.ts`
- Test: `runner/tests/runner.test.ts`

**Step 1: Write the failing test**

Append to `runner/tests/runner.test.ts`, find the describe block and add:

```typescript
  it('stops tool loop when signal is aborted', async () => {
    const controller = new AbortController();

    // Provider that returns a tool call, then on second call returns content
    const mockProvider = {
      name: 'test',
      call: vi.fn()
        .mockImplementationOnce(async () => {
          // First call: return tool call, then abort
          controller.abort();
          return {
            content: '',
            tool_calls: [{ id: 'tc1', name: 'test-tool', arguments: {} }],
            finish_reason: 'tool_use',
          };
        }),
    };

    // Should throw/reject because signal is aborted before second LLM call
    await expect(runAgent({
      agent: { name: 'test', provider: 'test', model: 'test', tools: [] },
      task: { description: 'test' },
      context: {},
      toolRegistry: new ToolRegistry(),
      providerRegistry: { get: () => mockProvider } as any,
      signal: controller.signal,
    })).rejects.toThrow();
  });
```

**Step 2: Run test to verify it fails**

Run: `cd runner && pnpm test -- tests/runner.test.ts`
Expected: FAIL — `signal` is not a valid property of RunAgentConfig

**Step 3: Add signal to RunAgentConfig and wire it through**

In `runner/src/runner.ts`:

Add `signal` to `RunAgentConfig` (after line 22):

```typescript
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
```

In `runAgent()`, destructure signal (around line 52):

```typescript
  const { agent, task, context, executionContext, toolRegistry, providerRegistry } = config;
  const signal = config.signal;
```

For the **AgentLoopProvider path** (around line 99), pass signal:

```typescript
    const loopResult = await provider.runAgentLoop(
      { ... },
      async (name, args, callId) => { ... },
      onToken,
      signal
    );
```

For the **standard multi-turn loop** (around line 193), add abort check before each LLM call:

```typescript
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
```

**Step 4: Run tests to verify they pass**

Run: `cd runner && pnpm test`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add runner/src/runner.ts runner/tests/runner.test.ts
git commit -m "feat(runner): thread abort signal through runAgent to providers"
```

---

### Task 6: Thread signal through engine

**Files:**
- Modify: `engine/src/engine.ts`
- Test: `engine/tests/engine.test.ts`

**Step 1: Write the failing test**

In `engine/tests/engine.test.ts`, add a test that verifies the engine returns `cancelled` when signal is aborted. You'll need to look at the existing test setup pattern in that file to reuse fixtures. The core test:

```typescript
  it('returns cancelled when signal is aborted before stages run', async () => {
    const controller = new AbortController();
    controller.abort(); // Pre-aborted

    const result = await engine.run({
      pipeline: 'test-pipeline',
      input: 'test input',
      signal: controller.signal,
    });

    expect(result.status).toBe('cancelled');
  });
```

**Step 2: Run test to verify it fails**

Run: `cd engine && pnpm test -- tests/engine.test.ts`
Expected: FAIL — `signal` is not a valid property on RunInput

**Step 3: Add signal to RunInput and wire through engine**

In `engine/src/engine.ts`:

Add `signal` to `RunInput` (after line 121):

```typescript
export interface RunInput {
  pipeline: string;
  input: string | Record<string, unknown>;
  meta?: Record<string, unknown>;
  anonymize?: boolean;
  signal?: AbortSignal;
}
```

In `PipelineEngine.run()`, extract signal at the top:

```typescript
  async run(input: RunInput): Promise<PipelineRun> {
    const signal = input.signal;
```

**Check signal before the main stage loop** (before line 210, the `for (const entry of pipeline.stages)` loop):

```typescript
    for (const entry of pipeline.stages) {
      // Check for cancellation before each pipeline entry
      if (signal?.aborted) {
        pipelineRun.status = 'cancelled';
        pipelineRun.completed_at = new Date().toISOString();
        this.events?.onPipelineComplete?.({
          pipeline_name: pipeline.name,
          run_id: pipelineRun.id,
          status: 'cancelled',
          duration_ms: Date.now() - pipelineStartTime,
          total_tokens: this.pipelineTotals.tokens,
          total_tool_calls: this.pipelineTotals.toolCalls,
        });
        this.emitter.emit({ type: 'pipeline_complete', pipelineId: pipelineRun.id });
        this.config.db?.savePipelineRun(pipelineRun);
        return pipelineRun;
      }
```

**Pass signal to executeStage** (add to all `this.executeStage(...)` calls — add signal as a new last parameter). Update `executeStage` private method signature:

```typescript
  private async executeStage(
    stageDef: StageDefinition,
    pipelineContext: PipelineContext,
    previousStageName: string | undefined,
    userInput: string | Record<string, unknown>,
    stageIndex: number,
    totalStages: number,
    paths: ProjectPaths,
    runMiddleware?: AnonymizationMiddleware | null,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<StageResult> {
```

Inside `executeStage`, pass signal to the ralph call (around line 509):

```typescript
    const ralphResult = await ralph<AgentRunResult>({
      executor: async (execContext: RalphExecutionContext) => {
        // ... existing executor code
        const result = await runAgent({
          // ... existing config
          signal,
        });
        // ... rest
      },
      validator: ralphValidator,
      maxAttempts: stageDef.ralph?.max_attempts ?? 3,
      retryStrategy,
      signal,
      onRetry: async (event) => { /* existing */ },
    });
```

**Also handle cancelled in the status check after ralph** — after deriveStageStatus (around line 606), if status is `cancelled`, skip post-validation and hooks:

```typescript
    let stageStatus = deriveStageStatus(ralphResult);

    // Cancelled — skip post-validation and hooks
    if (stageStatus === 'cancelled') {
      stageRun.status = 'cancelled';
      stageRun.completed_at = new Date().toISOString();
      stageRun.tasks = [taskRun];
      taskRun.status = 'failed'; // closest existing TaskRun status
      taskRun.completed_at = new Date().toISOString();
      this.events?.onStageComplete?.({
        stage_name: stageDef.name,
        stage_index: stageIndex,
        total_stages: totalStages,
        status: 'cancelled',
        attempts: ralphResult.attempts,
        duration_ms: Date.now() - new Date(stageStartedAt).getTime(),
      });
      this.emitter.emit({ type: 'stage_complete', stageId: stageRunId, stageName: stageDef.name });
      return { stageRun, status: 'cancelled' };
    }
```

**Pass signal in runGroup** — update `runGroup` signature to accept signal:

```typescript
  private async runGroup(
    group: StageGroup,
    context: PipelineContext,
    stageOffset: number,
    totalStages: number,
    userInput: string | Record<string, unknown>,
    paths: ProjectPaths,
    runMiddleware?: AnonymizationMiddleware | null,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<GroupResult> {
```

Inside `runGroup`, check signal before each iteration and each stage, and forward to `executeStage`:

```typescript
    while (iteration < group.max_iterations) {
      // Check cancellation before group iteration
      if (signal?.aborted) {
        // ... emit group_complete with 'cancelled', return { status: 'cancelled', ... }
      }
      iteration++;
      // ...
      for (let i = 0; i < group.stages.length; i++) {
        if (signal?.aborted) break;
        // ...
        const result = await this.executeStage(
          stage, context, previousStageName, userInput,
          stageNumber, totalStages, paths, runMiddleware, runId, signal,
        );
        // ...
        if (result.status === 'cancelled') {
          // Same handling as 'failed' — stop group, return cancelled
        }
      }
    }
```

Update all call sites of `runGroup` and `executeStage` in `run()` to pass `signal`.

**Step 4: Run tests to verify they pass**

Run: `cd engine && pnpm test`
Expected: ALL PASS

**Step 5: Full build**

Run: `pnpm build`
Expected: PASS

**Step 6: Commit**

```bash
git add engine/src/engine.ts engine/tests/engine.test.ts engine/src/state/status-derivation.ts
git commit -m "feat(engine): thread abort signal through pipeline execution"
```

---

### Task 7: Rewrite CLI SIGINT handler

**Files:**
- Modify: `cli/src/commands/run.ts:370-395`

**Step 1: Rewrite the signal handling block**

Replace the current `onInterrupt` + `try/finally` block (lines 370-395) with:

```typescript
    const controller = new AbortController();
    let forceExitOnNextInterrupt = false;

    const onInterrupt = () => {
      if (forceExitOnNextInterrupt) {
        // Second Ctrl-C: force exit
        process.exit(130);
      }
      forceExitOnNextInterrupt = true;
      controller.abort();
      progress.interrupt();
      process.stderr.write('\n' + chalk.yellow('⚠ Cancelling run...') + '\n');
    };
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onInterrupt);

    let result;
    try {
      result = await engine.run({
        pipeline: pipelineName,
        input,
        anonymize: options.anonymize,
        signal: controller.signal,
      });
    } finally {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onInterrupt);
      await runLogger.close();
      await Promise.allSettled(mcpClients.map((c) => c.close()));
    }
```

**Update the exit logic** at the bottom (around line 407):

```typescript
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (result.status === 'cancelled') {
        // Find the last stage that ran
        const lastStage = result.stages[result.stages.length - 1];
        const stageName = lastStage?.stage_name ?? 'unknown';
        const stageIdx = result.stages.length;
        console.error(chalk.red(`✗ Run cancelled at stage [${stageIdx}] ${stageName}`));
      } else {
        formatResult(result);
        const changes = fileCollector.computeSummary(repoPath);
        if (changes) {
          console.log(formatFileChanges(changes));
        }
      }
    }

    if (result.status === 'cancelled') {
      process.exit(130);
    }
    process.exit(result.status === 'success' ? 0 : 1);
```

**Step 2: Build**

Run: `pnpm build`
Expected: PASS

**Step 3: Commit**

```bash
git add cli/src/commands/run.ts
git commit -m "feat(cli): two-phase Ctrl-C graceful shutdown with AbortController"
```

---

### Task 8: Add onPipelineCancelled event

**Files:**
- Modify: `engine/src/events.ts`
- Modify: `engine/src/engine.ts` (the cancellation return point in `run()`)
- Modify: `engine/src/index.ts` (re-export new event type)

**Step 1: Add event type to events.ts**

In `engine/src/events.ts`, add after `PipelineCompleteEvent` (around line 29):

```typescript
export interface PipelineCancelledEvent {
  run_id: string;
  cancelled_at_stage: string;
  duration_ms: number;
}
```

Add to `EngineEvents` interface (after line 99):

```typescript
  onPipelineCancelled?: (event: PipelineCancelledEvent) => void;
```

**Step 2: Emit the event in engine**

In the cancellation return point in `engine.ts` `run()` (the `if (signal?.aborted)` block), emit the event before returning:

```typescript
      const lastStage = pipelineRun.stages[pipelineRun.stages.length - 1];
      this.events?.onPipelineCancelled?.({
        run_id: pipelineRun.id,
        cancelled_at_stage: lastStage?.stage_name ?? 'before_first_stage',
        duration_ms: Date.now() - pipelineStartTime,
      });
```

Also emit when a stage returns `cancelled` — in the simple stage and group handling blocks.

**Step 3: Re-export from index**

In `engine/src/index.ts`, add `PipelineCancelledEvent` to the exports:

```typescript
export type {
  EngineEvents,
  PipelineEvent,
  PipelineStartEvent,
  PipelineCompleteEvent,
  PipelineCancelledEvent,
  // ... rest
} from './events.js';
```

**Step 4: Wire into CLI logger**

In `cli/src/commands/run.ts`, in the `mergeEvents` function, add:

```typescript
    onPipelineCancelled: (e) => {
      logger.log({
        event: 'pipeline_cancelled',
        run_id: e.run_id,
        cancelled_at_stage: e.cancelled_at_stage,
        duration_ms: e.duration_ms,
      });
    },
```

**Step 5: Build and test**

Run: `pnpm build && pnpm test`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add engine/src/events.ts engine/src/engine.ts engine/src/index.ts cli/src/commands/run.ts
git commit -m "feat(engine): add onPipelineCancelled event"
```

---

### Task 9: Final integration test and cleanup

**Step 1: Run full test suite**

Run: `pnpm build && pnpm test`
Expected: ALL PASS

**Step 2: Manual smoke test with mock provider**

If a test pipeline + mock.yaml are available in any test fixture:

```bash
# In the worktree, find a test fixture with a pipeline
# Start a run with mock provider, then Ctrl-C during execution
node cli/dist/index.js run <pipeline> --provider mock --input "test"
# Press Ctrl-C
# Expected: "⚠ Cancelling run..." → "✗ Run cancelled at stage [N] <name>"
# Expected: exit code 130
```

**Step 3: Commit any final fixes**

```bash
git add -A
git commit -m "test: integration verification for graceful shutdown"
```

---

## Summary of changes by package

| Package | Files changed | What |
|---------|--------------|------|
| **contracts** | `stage.ts` | Add `'cancelled'` to StageStatus |
| **ralph** | `loop.ts`, `tests/loop.test.ts` | Add `signal` to RalphConfig, `cancelled` to RalphResult, abortable delay |
| **runner** | `provider.ts`, `anthropic.ts`, `openai.ts`, `openai-responses.ts`, `mock.ts`, `runner.ts`, `tests/runner.test.ts` | Add `signal` param throughout provider chain and runAgent |
| **engine** | `engine.ts`, `status-derivation.ts`, `events.ts`, `index.ts`, `tests/status-derivation.test.ts`, `tests/engine.test.ts` | Check signal in main loop, derive cancelled status, new event |
| **cli** | `commands/run.ts` | Two-phase AbortController, cancellation output |
