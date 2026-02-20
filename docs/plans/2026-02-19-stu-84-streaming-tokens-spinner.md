# STU-84: Real-time Agent Feedback — Streaming Tokens + Animated Spinner

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add two UX improvements to `--live` mode: (1) an animated "Thinking…" spinner between tool calls, and (2) LLM tokens streamed token-by-token as they arrive from Anthropic and OpenAI.

**Architecture:**
- Phase 1 — Spinner: pure CLI change in `progress.ts`, no new events needed.
- Phase 2 — Streaming: add `onAgentToken` to `RunnerCallbacks` (contracts) and `EngineEvents` (engine), update the `Provider` interface to accept an optional `onToken` callback, implement streaming in all three provider classes, and update `progress.ts` to display tokens inline.

**Tech Stack:** TypeScript, Anthropic SDK (`.messages.stream()`), OpenAI SDK (`stream: true`), ora (spinner), vitest (tests), pnpm workspaces.

**Worktree:** `.worktrees/stu-84/`
**Branch:** `arianedguay/stu-84-implement-real-time-agent-feedback-streaming-tokens-animated`

---

## Task 1 — Animated "Thinking…" spinner in live mode

**Files:**
- Modify: `cli/src/output/progress.ts`

This is a pure display change — no new events required. In `--live` mode the gap between stage start and the first tool call (and between tool calls) currently shows nothing. We add an ora spinner labelled "Thinking…" that:
- starts on `onStageStart` (live mode)
- stops before the tool spinner starts (`onToolCallStart`)
- restarts after each `onToolCallComplete`
- stops (and clears) on `onStageComplete` and `onTaskRetry`

### Step 1 — Write the failing tests

Create `cli/tests/progress-spinner.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock ora BEFORE importing progress.ts
const mockOraInstance = {
  start: vi.fn().mockReturnThis(),
  stop: vi.fn().mockReturnThis(),
  succeed: vi.fn().mockReturnThis(),
  fail: vi.fn().mockReturnThis(),
};
vi.mock('ora', () => ({ default: vi.fn(() => mockOraInstance) }));
import ora from 'ora';

// Now import the module under test
import { ProgressDisplay } from '../src/output/progress.js';
import type { EngineEvents } from '@studio/engine';

function makeDisplay() {
  return new ProgressDisplay(false, 'live');
}

function stageStartEvent(n = 1, total = 3) {
  return { stage_name: 'code-generation', stage_index: n - 1, total_stages: total };
}

function stageCompleteEvent(status = 'success') {
  return {
    stage_name: 'code-generation', stage_index: 0, total_stages: 3,
    status, attempts: 1, duration_ms: 1000,
  };
}

function toolCallStartEvent() {
  return { tool: 'repo_manager-read_file', params: { path: 'foo.ts' }, timestamp: Date.now() };
}

function toolCallCompleteEvent() {
  return { tool: 'repo_manager-read_file', result: 'ok', duration_ms: 100, timestamp: Date.now() };
}

describe('ProgressDisplay — thinking spinner (live mode)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts thinking spinner on onStageStart', () => {
    const d = makeDisplay();
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());
    expect(ora).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Thinking') }));
    expect(mockOraInstance.start).toHaveBeenCalledTimes(1);
  });

  it('stops thinking spinner before starting tool spinner on onToolCallStart', () => {
    const d = makeDisplay();
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());
    vi.clearAllMocks();
    events.onToolCallStart!(toolCallStartEvent());
    expect(mockOraInstance.stop).toHaveBeenCalled();
  });

  it('restarts thinking spinner after onToolCallComplete', () => {
    const d = makeDisplay();
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());
    events.onToolCallStart!(toolCallStartEvent());
    vi.clearAllMocks();
    events.onToolCallComplete!(toolCallCompleteEvent());
    // After tool succeeds a new thinking spinner should start
    expect(mockOraInstance.start).toHaveBeenCalled();
  });

  it('stops thinking spinner on onStageComplete', () => {
    const d = makeDisplay();
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());
    vi.clearAllMocks();
    events.onStageComplete!(stageCompleteEvent());
    expect(mockOraInstance.stop).toHaveBeenCalled();
  });

  it('does NOT start thinking spinner in non-live mode', () => {
    const d = new ProgressDisplay(false, 'quiet');
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());
    expect(mockOraInstance.start).not.toHaveBeenCalled();
  });
});
```

### Step 2 — Run to verify they fail

```bash
pnpm --filter @studio/cli test 2>&1 | tail -20
```

Expected: tests fail (thinkingSpinner not created yet).

### Step 3 — Implement the thinking spinner

In `cli/src/output/progress.ts`, add `private thinkingSpinner: Ora | null = null;` alongside the other spinner fields (after line 10).

Replace the `onStageStart` live branch:
```typescript
if (this.live) {
  console.log(chalk.cyan(`${this.spinnerText}...`));
  this.thinkingSpinner = ora({ text: chalk.dim('Thinking...'), indent: 2, color: 'gray' }).start();
}
```

In `onToolCallStart` (live branch), add before creating the tool spinner:
```typescript
this.thinkingSpinner?.stop();
this.thinkingSpinner = null;
```

In `onToolCallComplete` (live branch), after clearing `this.toolSpinner = null`, add:
```typescript
this.thinkingSpinner = ora({ text: chalk.dim('Thinking...'), indent: 2, color: 'gray' }).start();
```

In `onStageComplete` (live branch), before the status lines, add:
```typescript
this.thinkingSpinner?.stop();
this.thinkingSpinner = null;
```

In `onTaskRetry`, after the existing `this.toolSpinner?.stop()` block, add:
```typescript
this.thinkingSpinner?.stop();
this.thinkingSpinner = null;
```

### Step 4 — Run to verify they pass

```bash
pnpm --filter @studio/cli test 2>&1 | tail -20
```

Expected: all CLI tests pass.

### Step 5 — Build and commit

```bash
pnpm build
git add cli/src/output/progress.ts cli/tests/progress-spinner.test.ts
git commit -m "feat(cli): add animated thinking spinner in --live mode (STU-84)"
```

---

## Task 2 — Add `onAgentToken` to `RunnerCallbacks` (contracts)

**Files:**
- Modify: `contracts/src/runner-events.ts`

Type-only change — no test needed, TypeScript compilation is the verification.

### Step 1 — Add the new interface and callback

Append to `contracts/src/runner-events.ts` (after `AgentProgressEvent`):

```typescript
export interface AgentTokenEvent {
  token: string;
  timestamp: number; // ms since epoch (Date.now())
}
```

Add to `RunnerCallbacks`:

```typescript
onAgentToken?: (event: AgentTokenEvent) => void;
```

### Step 2 — Build to verify

```bash
pnpm build 2>&1 | tail -10
```

Expected: build succeeds, no type errors.

### Step 3 — Commit

```bash
git add contracts/src/runner-events.ts
git commit -m "feat(contracts): add AgentTokenEvent and onAgentToken to RunnerCallbacks (STU-84)"
```

---

## Task 3 — Add `onAgentToken` to `EngineEvents`

**Files:**
- Modify: `engine/src/events.ts`

### Step 1 — Add staged event type and update EngineEvents

After `StagedAgentProgressEvent` (line 90), add:

```typescript
export interface StagedAgentTokenEvent extends AgentTokenEvent {
  stage: string;
}
```

Add import at the top (update existing import from `@studio/contracts`):
```typescript
import type { ToolCallStartEvent, ToolCallCompleteEvent, AgentThinkingEvent, AgentProgressEvent, AgentTokenEvent } from '@studio/contracts';
```

Add to `EngineEvents`:
```typescript
onAgentToken?: (event: StagedAgentTokenEvent) => void;
```

### Step 2 — Build to verify

```bash
pnpm build 2>&1 | tail -10
```

Expected: build succeeds.

### Step 3 — Commit

```bash
git add engine/src/events.ts
git commit -m "feat(engine): add StagedAgentTokenEvent and onAgentToken to EngineEvents (STU-84)"
```

---

## Task 4 — Wire `onAgentToken` through engine callbacks

**Files:**
- Modify: `engine/src/engine.ts`

### Step 1 — Locate and update the callbacks block

Find the `callbacks:` block around line 422 in `engine/src/engine.ts`. Add:

```typescript
onAgentToken: this.events?.onAgentToken
  ? (e) => this.events!.onAgentToken!({ stage: stageDef.name, ...e })
  : undefined,
```

The final callbacks object should look like:
```typescript
callbacks: this.events ? {
  onToolCallStart: this.events.onToolCallStart,
  onToolCallComplete: this.events.onToolCallComplete,
  onAgentThinking: this.events.onAgentThinking
    ? (e) => this.events!.onAgentThinking!({ stage: stageDef.name, ...e })
    : undefined,
  onAgentProgress: this.events.onAgentProgress
    ? (e) => this.events!.onAgentProgress!({ stage: stageDef.name, ...e })
    : undefined,
  onAgentToken: this.events.onAgentToken
    ? (e) => this.events!.onAgentToken!({ stage: stageDef.name, ...e })
    : undefined,
} : undefined,
```

### Step 2 — Build to verify

```bash
pnpm build 2>&1 | tail -10
```

Expected: build succeeds.

### Step 3 — Commit

```bash
git add engine/src/engine.ts
git commit -m "feat(engine): wire onAgentToken callback through to runner (STU-84)"
```

---

## Task 5 — Update `Provider` interface to accept `onToken` callback

**Files:**
- Modify: `runner/src/providers/provider.ts`

### Step 1 — Update interfaces

In `provider.ts`, update the `Provider` interface:

```typescript
export interface Provider {
  readonly name: string;
  call(request: LLMRequest, onToken?: (token: string) => void): Promise<LLMResponse>;
}
```

Update `AgentLoopProvider`:

```typescript
export interface AgentLoopProvider extends Provider {
  runAgentLoop(
    request: LLMRequest,
    executeTool: (name: string, args: Record<string, unknown>, callId: string) => Promise<ToolCallOutcome>,
    onToken?: (token: string) => void
  ): Promise<AgentLoopResult>;
}
```

### Step 2 — Update `call()` signatures in all provider classes to accept the new parameter

`runner/src/providers/anthropic.ts`:
```typescript
async call(request: LLMRequest, onToken?: (token: string) => void): Promise<LLMResponse> {
```

`runner/src/providers/openai.ts`:
```typescript
async call(request: LLMRequest, onToken?: (token: string) => void): Promise<LLMResponse> {
```

`runner/src/providers/openai-responses.ts` (both `call` and `runAgentLoop`):
```typescript
async call(request: LLMRequest, _onToken?: (token: string) => void): Promise<LLMResponse> {
async runAgentLoop(
  request: LLMRequest,
  executeTool: ...,
  onToken?: (token: string) => void
): Promise<AgentLoopResult> {
```

`runner/src/providers/mock.ts` (both `call` and `runAgentLoop`):
```typescript
async call(_request: LLMRequest, _onToken?: (token: string) => void): Promise<LLMResponse> {
async runAgentLoop(
  request: LLMRequest,
  executeTool: ...,
  onToken?: (token: string) => void
): Promise<AgentLoopResult> {
```

Also update `runner.test.ts`'s inline `MockProvider` class to add the parameter:
```typescript
async call(request: LLMRequest, _onToken?: (token: string) => void): Promise<LLMResponse> {
```
And the `InfiniteToolCallProvider` similarly.

### Step 3 — Build and run tests

```bash
pnpm build 2>&1 | tail -10
pnpm --filter @studio/runner test 2>&1 | tail -15
```

Expected: build succeeds, all runner tests pass.

### Step 4 — Commit

```bash
git add runner/src/providers/provider.ts runner/src/providers/anthropic.ts runner/src/providers/openai.ts runner/src/providers/openai-responses.ts runner/src/providers/mock.ts runner/tests/runner.test.ts
git commit -m "feat(runner): add optional onToken parameter to Provider interface (STU-84)"
```

---

## Task 6 — Pass `onAgentToken` from runner config to providers

**Files:**
- Modify: `runner/src/runner.ts`
- Modify: `runner/tests/runner.test.ts`

### Step 1 — Write the failing test

Add to `runner/tests/runner.test.ts`:

```typescript
it('should propagate onAgentToken when provider emits tokens', async () => {
  const receivedTokens: string[] = [];

  class TokenStreamingProvider implements Provider {
    readonly name = 'mock';
    async call(_request: LLMRequest, onToken?: (token: string) => void): Promise<LLMResponse> {
      onToken?.('Hello');
      onToken?.(' world');
      return {
        content: '{"result": "streamed"}',
        tool_calls: [],
        finish_reason: 'stop',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
    }
  }

  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(new TokenStreamingProvider());
  const toolRegistry = new ToolRegistry();

  await runAgent({
    agent: { name: 'test-agent', provider: 'mock', model: 'test-model' },
    task: { description: 'stream test' },
    context: {},
    toolRegistry,
    providerRegistry,
    callbacks: {
      onAgentToken: (event) => receivedTokens.push(event.token),
    },
  });

  expect(receivedTokens).toEqual(['Hello', ' world']);
});
```

### Step 2 — Run to verify it fails

```bash
pnpm --filter @studio/runner test 2>&1 | grep -E "FAIL|PASS|should propagate"
```

Expected: the new test fails (runner doesn't pass onToken to provider yet).

### Step 3 — Update runner.ts

In `runner/src/runner.ts`, inside `runAgent()`, build the `onToken` wrapper just before the provider branch:

```typescript
// Build onToken wrapper that bridges provider → RunnerCallbacks.onAgentToken
const onToken = config.callbacks?.onAgentToken
  ? (token: string) => config.callbacks!.onAgentToken!({ token, timestamp: Date.now() })
  : undefined;
```

In the `isAgentLoopProvider` branch, update the `runAgentLoop` call:
```typescript
const loopResult = await provider.runAgentLoop(
  { model: agent.model, messages, tools: toolDefinitions.length > 0 ? toolDefinitions : undefined, temperature: agent.temperature, max_tokens: agent.max_tokens, stage_name: task.contract_name },
  async (name, args, callId) => { /* ... existing executeTool callback unchanged ... */ },
  onToken
);
```

In the standard multi-turn loop, update the `provider.call` call:
```typescript
const response = await provider.call({
  model: agent.model,
  messages: currentMessages,
  tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
  temperature: agent.temperature,
  max_tokens: agent.max_tokens,
  stage_name: task.contract_name,
}, onToken);
```

### Step 4 — Run to verify it passes

```bash
pnpm --filter @studio/runner test 2>&1 | tail -15
```

Expected: all runner tests pass including the new one.

### Step 5 — Commit

```bash
git add runner/src/runner.ts runner/tests/runner.test.ts
git commit -m "feat(runner): pass onAgentToken callback through to providers as onToken (STU-84)"
```

---

## Task 7 — Display streaming tokens in `progress.ts`

**Files:**
- Modify: `cli/src/output/progress.ts`
- Modify: `cli/tests/progress-spinner.test.ts`

We need to handle the case where tokens arrive: stop the thinking spinner, print tokens inline (no newline), and track that we're mid-stream so `onToolCallStart` knows to add a newline before the tool spinner.

### Step 1 — Write the failing tests

Add to `cli/tests/progress-spinner.test.ts`:

```typescript
describe('ProgressDisplay — token streaming (live mode)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stops thinking spinner when first token arrives', () => {
    const d = makeDisplay();
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());
    vi.clearAllMocks();
    events.onAgentToken!({ token: 'Hello', stage: 'code-generation', timestamp: Date.now() });
    expect(mockOraInstance.stop).toHaveBeenCalled();
  });

  it('does not print tokens in non-live mode', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const d = new ProgressDisplay(false, 'quiet');
    const events = d.getEvents();
    events.onAgentToken!({ token: 'Hello', stage: 'code-generation', timestamp: Date.now() });
    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });
});
```

### Step 2 — Run to verify they fail

```bash
pnpm --filter @studio/cli test 2>&1 | tail -15
```

Expected: new token tests fail.

### Step 3 — Implement token display in progress.ts

Add `private isStreamingTokens = false;` to the class fields.

Add the `onAgentToken` handler to `getEvents()` return object:

```typescript
onAgentToken: (event) => {
  if (this.jsonMode || !this.live) return;
  if (this.thinkingSpinner) {
    this.thinkingSpinner.stop();
    this.thinkingSpinner = null;
    process.stdout.write('  '); // indent to match spinner position
  }
  if (!this.isStreamingTokens) {
    this.isStreamingTokens = true;
  }
  process.stdout.write(chalk.dim(event.token));
},
```

Update `onToolCallStart` to flush the streaming line before starting the tool spinner:

```typescript
onToolCallStart: (event) => {
  if (this.jsonMode || !this.live) return;
  // End any in-progress token stream line
  if (this.isStreamingTokens) {
    process.stdout.write('\n');
    this.isStreamingTokens = false;
  }
  this.thinkingSpinner?.stop();
  this.thinkingSpinner = null;
  // ... existing tool spinner code unchanged
},
```

Update `onStageComplete` (live branch) to flush before printing result:

```typescript
if (this.live) {
  if (this.isStreamingTokens) {
    process.stdout.write('\n');
    this.isStreamingTokens = false;
  }
  this.thinkingSpinner?.stop();
  this.thinkingSpinner = null;
  // ... existing status output code unchanged
}
```

Update `onTaskRetry` to also flush and reset:

```typescript
// After existing toolSpinner and spinner stops:
if (this.isStreamingTokens) {
  process.stdout.write('\n');
  this.isStreamingTokens = false;
}
this.thinkingSpinner?.stop();
this.thinkingSpinner = null;
```

### Step 4 — Run to verify they pass

```bash
pnpm --filter @studio/cli test 2>&1 | tail -15
```

Expected: all CLI tests pass.

### Step 5 — Build and commit

```bash
pnpm build
git add cli/src/output/progress.ts cli/tests/progress-spinner.test.ts
git commit -m "feat(cli): display streaming tokens inline in --live mode (STU-84)"
```

---

## Task 8 — Anthropic provider streaming

**Files:**
- Modify: `runner/src/providers/anthropic.ts`
- Modify: `runner/tests/anthropic.test.ts`

When `onToken` is provided, use `client.messages.stream()` instead of `client.messages.create()`. The stream emits text tokens via the `'text'` event. At the end, `stream.finalMessage()` returns the complete `Message` with usage stats.

### Step 1 — Write the failing test

Replace the placeholder tests in `runner/tests/anthropic.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

// Mock the Anthropic SDK before importing the provider
const mockFinalMessage = {
  content: [{ type: 'text', text: 'Hello world' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
};

const mockStreamHandlers: Record<string, Function> = {};
const mockStream = {
  on: vi.fn((event: string, handler: Function) => {
    mockStreamHandlers[event] = handler;
    return mockStream;
  }),
  finalMessage: vi.fn().mockResolvedValue(mockFinalMessage),
};

const mockCreate = vi.fn().mockResolvedValue({
  content: [{ type: 'text', text: 'Hello world' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});
const mockStreamFn = vi.fn().mockReturnValue(mockStream);

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(() => ({
    messages: { create: mockCreate, stream: mockStreamFn },
  })),
}));

import { AnthropicProvider } from '../src/providers/anthropic.js';
import type { LLMRequest } from '@studio/contracts';

const baseRequest: LLMRequest = {
  model: 'claude-haiku-4-5',
  messages: [{ role: 'user', content: 'Say hello' }],
};

describe('AnthropicProvider', () => {
  it('calls messages.create when no onToken provided', async () => {
    const provider = new AnthropicProvider('test-key');
    vi.clearAllMocks();
    await provider.call(baseRequest);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockStreamFn).not.toHaveBeenCalled();
  });

  it('calls messages.stream when onToken is provided', async () => {
    const provider = new AnthropicProvider('test-key');
    vi.clearAllMocks();

    // Simulate text events from stream
    mockStreamFn.mockReturnValue({
      on: vi.fn((event: string, handler: Function) => {
        if (event === 'text') {
          handler('Hello');
          handler(' world');
        }
        return mockStream;
      }),
      finalMessage: vi.fn().mockResolvedValue(mockFinalMessage),
    });

    const tokens: string[] = [];
    await provider.call(baseRequest, (t) => tokens.push(t));

    expect(mockStreamFn).toHaveBeenCalledTimes(1);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(tokens).toEqual(['Hello', ' world']);
  });

  it('returns full LLMResponse with usage when streaming', async () => {
    const provider = new AnthropicProvider('test-key');
    vi.clearAllMocks();

    mockStreamFn.mockReturnValue({
      on: vi.fn((event: string, handler: Function) => {
        if (event === 'text') handler('Hello world');
        return mockStream;
      }),
      finalMessage: vi.fn().mockResolvedValue(mockFinalMessage),
    });

    const result = await provider.call(baseRequest, () => {});
    expect(result.content).toBe('Hello world');
    expect(result.usage?.prompt_tokens).toBe(10);
    expect(result.usage?.completion_tokens).toBe(5);
  });
});
```

### Step 2 — Run to verify they fail

```bash
pnpm --filter @studio/runner test 2>&1 | grep -E "AnthropicProvider|FAIL|PASS" | head -10
```

Expected: Anthropic tests fail.

### Step 3 — Implement streaming in `anthropic.ts`

Extract the request-building logic into a shared private method, then add a streaming path:

```typescript
async call(request: LLMRequest, onToken?: (token: string) => void): Promise<LLMResponse> {
  const params = this.buildParams(request);

  if (onToken) {
    // Streaming path
    const stream = this.client.messages.stream(params);
    stream.on('text', (text: string) => onToken(text));
    const response = await stream.finalMessage();
    return this.parseResponse(response);
  }

  // Non-streaming path (unchanged)
  const response = await this.client.messages.create(params);
  return this.parseResponse(response);
}

private buildParams(request: LLMRequest) {
  // All the param-building logic that was previously inline in call()
  // (system messages, tools conversion, cache_control, etc.)
  // Returns the object that was previously passed to messages.create()
}

private parseResponse(response: Awaited<ReturnType<typeof this.client.messages.create>>): LLMResponse {
  // All the parsing logic that was previously inline
  // (loop over response.content, build tool_calls, build usage)
}
```

**Important:** `stream.finalMessage()` returns the same type as `messages.create()`, so `parseResponse` can be shared.

### Step 4 — Run to verify they pass

```bash
pnpm --filter @studio/runner test 2>&1 | tail -15
```

Expected: all runner tests pass including Anthropic tests.

### Step 5 — Commit

```bash
pnpm build
git add runner/src/providers/anthropic.ts runner/tests/anthropic.test.ts
git commit -m "feat(runner): Anthropic provider streaming via messages.stream() (STU-84)"
```

---

## Task 9 — OpenAI chat completions streaming

**Files:**
- Modify: `runner/src/providers/openai.ts`
- Modify: `runner/tests/openai.test.ts`

When `onToken` is provided, pass `stream: true` to `chat.completions.create()`. The result is an `AsyncIterable<ChatCompletionChunk>`. Accumulate `delta.content` (emit via `onToken`) and `delta.tool_calls` (accumulate full JSON string, parse at end). Add `stream_options: { include_usage: true }` so usage is available in the final chunk.

### Step 1 — Write the failing tests

Replace placeholder tests in `runner/tests/openai.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

// Helpers to build fake stream chunks
function textChunk(content: string, index = 0) {
  return { choices: [{ delta: { content, tool_calls: undefined }, finish_reason: null, index }], usage: null };
}
function stopChunk(usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) {
  return { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }], usage };
}

async function* makeStream(chunks: object[]) {
  for (const c of chunks) yield c;
}

const mockCreate = vi.fn();

vi.mock('openai', () => ({
  default: vi.fn(() => ({
    chat: { completions: { create: mockCreate } },
  })),
}));

import { OpenAIProvider } from '../src/providers/openai.js';
import type { LLMRequest } from '@studio/contracts';

const baseRequest: LLMRequest = {
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Say hello' }],
};

describe('OpenAIProvider', () => {
  it('uses non-streaming create when no onToken provided', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Hello', tool_calls: null }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const provider = new OpenAIProvider('test-key');
    await provider.call(baseRequest);
    expect(mockCreate).toHaveBeenCalledWith(expect.not.objectContaining({ stream: true }));
  });

  it('uses streaming create when onToken is provided', async () => {
    mockCreate.mockReturnValueOnce(makeStream([
      textChunk('Hello'),
      textChunk(' world'),
      stopChunk(),
    ]));
    const provider = new OpenAIProvider('test-key');
    const tokens: string[] = [];
    await provider.call(baseRequest, (t) => tokens.push(t));
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ stream: true }));
    expect(tokens).toEqual(['Hello', ' world']);
  });

  it('accumulates content correctly when streaming', async () => {
    mockCreate.mockReturnValueOnce(makeStream([
      textChunk('Hello'),
      textChunk(' world'),
      stopChunk(),
    ]));
    const provider = new OpenAIProvider('test-key');
    const result = await provider.call(baseRequest, () => {});
    expect(result.content).toBe('Hello world');
    expect(result.finish_reason).toBe('stop');
  });
});
```

### Step 2 — Run to verify they fail

```bash
pnpm --filter @studio/runner test 2>&1 | grep -E "OpenAIProvider|FAIL" | head -10
```

### Step 3 — Implement streaming in `openai.ts`

```typescript
async call(request: LLMRequest, onToken?: (token: string) => void): Promise<LLMResponse> {
  const openaiMessages = this.buildMessages(request);
  const tools = this.buildTools(request);

  if (onToken) {
    return this.callStreaming(request, openaiMessages, tools, onToken);
  }
  // Non-streaming path — existing code, just refactored
  const completion = await this.client.chat.completions.create({
    model: request.model,
    messages: openaiMessages,
    tools: tools && tools.length > 0 ? tools : undefined,
    temperature: request.temperature,
    max_completion_tokens: request.max_tokens,
  });
  const choice = completion.choices[0];
  return {
    content: choice.message.content || '',
    tool_calls: choice.message.tool_calls?.map(tc => ({
      id: tc.id, name: tc.function.name, arguments: JSON.parse(tc.function.arguments),
    })) || [],
    finish_reason: choice.finish_reason,
    usage: { prompt_tokens: completion.usage?.prompt_tokens || 0, completion_tokens: completion.usage?.completion_tokens || 0, total_tokens: completion.usage?.total_tokens || 0 },
  };
}

private async callStreaming(request: LLMRequest, openaiMessages: ChatCompletionMessageParam[], tools: ChatCompletionTool[] | undefined, onToken: (token: string) => void): Promise<LLMResponse> {
  const stream = await this.client.chat.completions.create({
    model: request.model,
    messages: openaiMessages,
    tools: tools && tools.length > 0 ? tools : undefined,
    temperature: request.temperature,
    max_completion_tokens: request.max_tokens,
    stream: true,
    stream_options: { include_usage: true },
  });

  let textContent = '';
  const toolCallMap = new Map<number, { id: string; name: string; args: string }>();
  let finishReason = 'stop';
  let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;

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
      usage = { prompt_tokens: chunk.usage.prompt_tokens, completion_tokens: chunk.usage.completion_tokens, total_tokens: chunk.usage.total_tokens };
    }
  }

  const tool_calls = Array.from(toolCallMap.values()).map(tc => ({
    id: tc.id, name: tc.name, arguments: JSON.parse(tc.args || '{}'),
  }));

  return { content: textContent, tool_calls, finish_reason: finishReason, usage };
}
```

### Step 4 — Run to verify they pass

```bash
pnpm --filter @studio/runner test 2>&1 | tail -15
```

### Step 5 — Commit

```bash
pnpm build
git add runner/src/providers/openai.ts runner/tests/openai.test.ts
git commit -m "feat(runner): OpenAI chat completions streaming (STU-84)"
```

---

## Task 10 — OpenAI Responses provider streaming

**Files:**
- Modify: `runner/src/providers/openai-responses.ts`

The Responses API supports streaming via the `stream` parameter. When `onToken` is provided in `runAgentLoop()`, use `this.client.responses.stream()` for each iteration.

### Step 1 — Implement streaming in `openai-responses.ts`

Inside `runAgentLoop()`, add an `onToken` parameter and use streaming when available:

```typescript
async runAgentLoop(
  request: LLMRequest,
  executeTool: (name: string, args: Record<string, unknown>, callId: string) => Promise<ToolCallOutcome>,
  onToken?: (token: string) => void
): Promise<AgentLoopResult> {
  // ... existing setup code unchanged ...

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let functionCalls: ResponseFunctionToolCall[];
    let outputText = '';

    if (onToken) {
      // Streaming path
      const stream = this.client.responses.stream({
        model: request.model,
        input,
        tools: tools.length > 0 ? tools : undefined,
        temperature: request.temperature,
        max_output_tokens: request.max_tokens ?? undefined,
      });

      // Accumulate output items from stream events
      const outputItems: ResponseOutputItem[] = [];
      for await (const event of stream) {
        if (event.type === 'response.output_text.delta') {
          onToken(event.delta);
          outputText += event.delta;
        }
        if (event.type === 'response.completed') {
          if (event.response.usage) {
            tokenAccumulator.prompt_tokens += event.response.usage.input_tokens;
            tokenAccumulator.completion_tokens += event.response.usage.output_tokens;
            tokenAccumulator.total_tokens += event.response.usage.total_tokens;
          }
          outputItems.push(...event.response.output);
        }
      }

      functionCalls = outputItems.filter(
        (item): item is ResponseFunctionToolCall => item.type === 'function_call'
      );

      if (functionCalls.length === 0) {
        return {
          content: outputText,
          tool_calls: allToolCalls,
          finish_reason: 'stop',
          usage: tokenAccumulator.total_tokens > 0 ? tokenAccumulator : undefined,
        };
      }

      // Execute tool calls
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

      input = [...input, ...(outputItems as unknown as ResponseInputItem[]), ...toolOutputs];
    } else {
      // Non-streaming path — existing code unchanged
      const response = await this.client.responses.create({ ... });
      // ... existing logic
    }
  }
}
```

**Note on streaming event types for Responses API:** Use `response.output_text.delta` for text tokens and `response.completed` for the final response with usage. Check the OpenAI SDK types — if `responses.stream()` is not available, use `responses.create({ stream: true })` and iterate the async stream.

### Step 2 — Build to verify

```bash
pnpm build 2>&1 | tail -15
```

Expected: build succeeds.

### Step 3 — Commit

```bash
git add runner/src/providers/openai-responses.ts
git commit -m "feat(runner): OpenAI Responses API streaming in runAgentLoop (STU-84)"
```

---

## Task 11 — Mock provider emits a fake token

**Files:**
- Modify: `runner/src/providers/mock.ts`
- Modify: `runner/tests/mock-provider.test.ts`

The mock needs to be compatible with the new contract so engine integration tests still work. It emits one fake token so the full event pipeline can be exercised in tests.

### Step 1 — Write the failing test

Add to `runner/tests/mock-provider.test.ts` (or create it if it exists):

```typescript
it('emits a fake token when onToken is provided', async () => {
  const stages = new Map([
    ['test-stage', { output: { result: 'ok' }, tool_calls: [] }],
  ]);
  const provider = new MockProvider(stages);

  const tokens: string[] = [];
  const result = await provider.runAgentLoop(
    { model: 'mock', messages: [{ role: 'user', content: 'go' }], stage_name: 'test-stage' },
    async () => ({ result: 'ok' }),
    (token) => tokens.push(token)
  );

  expect(tokens.length).toBeGreaterThan(0);
  expect(result.content).toBeTruthy();
});
```

### Step 2 — Run to verify it fails

```bash
pnpm --filter @studio/runner test 2>&1 | grep -E "mock-provider|FAIL" | head -5
```

### Step 3 — Implement in `mock.ts`

In `runAgentLoop()`, emit one fake token at the start when `onToken` is provided:

```typescript
async runAgentLoop(
  request: LLMRequest,
  executeTool: (name: string, args: Record<string, unknown>, callId: string) => Promise<ToolCallOutcome>,
  onToken?: (token: string) => void
): Promise<AgentLoopResult> {
  // ... existing validation code ...

  // Emit a fake token to exercise the streaming pipeline in tests
  onToken?.('...');

  // ... rest of existing code unchanged ...
}
```

### Step 4 — Run to verify they pass

```bash
pnpm --filter @studio/runner test 2>&1 | tail -15
```

### Step 5 — Build all and commit

```bash
pnpm build
pnpm test 2>&1 | grep -E "Tests|Test Files" | tail -5
git add runner/src/providers/mock.ts runner/tests/mock-provider.test.ts
git commit -m "feat(runner): mock provider emits fake token for streaming pipeline tests (STU-84)"
```

---

## Final: Full test run + verify acceptance criteria

```bash
# Run all tests
pnpm test 2>&1 | grep -E "Tests|Test Files|FAIL|ERR" | tail -10

# Build everything
pnpm build

# Acceptance criteria checklist:
# [x] Spinner animé actif dans --live mode entre les tool calls (Task 1)
# [x] Provider Anthropic en mode streaming (Task 8)
# [x] Provider OpenAI (chat completions) en mode streaming (Task 9)
# [x] Provider OpenAI Responses en mode streaming (Task 10)
# [x] Mock provider compatible avec le nouveau contrat (Task 11)
# [x] Tokens du LLM affichés en temps réel dans --live mode (Task 7)
# [x] onAgentToken event ajouté à RunnerCallbacks et EngineEvents (Tasks 2 + 3)
# [x] Les tests existants continuent de passer (verified throughout)
```

If all pass, proceed with finishing the branch:
```bash
git push -u origin arianedguay/stu-84-implement-real-time-agent-feedback-streaming-tokens-animated
```

Then use **superpowers:finishing-a-development-branch** to create the PR.

---

## Key files touched (summary)

| Package | File | Change |
|---------|------|--------|
| `contracts` | `src/runner-events.ts` | Add `AgentTokenEvent`, `onAgentToken` to `RunnerCallbacks` |
| `engine` | `src/events.ts` | Add `StagedAgentTokenEvent`, `onAgentToken` to `EngineEvents` |
| `engine` | `src/engine.ts` | Wire `onAgentToken` in callbacks |
| `runner` | `src/providers/provider.ts` | Add `onToken?` to `Provider.call()` and `AgentLoopProvider.runAgentLoop()` |
| `runner` | `src/providers/anthropic.ts` | Streaming via `messages.stream()` |
| `runner` | `src/providers/openai.ts` | Streaming via `stream: true` |
| `runner` | `src/providers/openai-responses.ts` | Streaming in `runAgentLoop()` |
| `runner` | `src/providers/mock.ts` | Accept `onToken?`, emit one fake token |
| `runner` | `src/runner.ts` | Build `onToken` wrapper, pass to providers |
| `cli` | `src/output/progress.ts` | Thinking spinner + `onAgentToken` inline display |
