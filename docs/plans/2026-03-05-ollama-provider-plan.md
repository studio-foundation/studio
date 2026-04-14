# Ollama Provider Adapter Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an `OllamaProvider` to `@studio-foundation/runner` so users can run Studio pipelines locally with Ollama, zero cloud API keys required.

**Architecture:** Thin wrapper around the `openai` npm SDK (already a dependency) with `baseURL` pointed at Ollama's OpenAI-compatible `/v1` endpoint. Registered in `createDefaultRegistry` under key `'ollama'`. CLI and API bootstrap updated to read `providers.ollama.baseUrl` from `config.yaml` and pass it through.

**Tech Stack:** TypeScript, `openai` npm SDK, vitest

---

### Task 1: OllamaProvider class + unit tests

**Files:**
- Create: `runner/src/providers/ollama.ts`
- Create: `runner/src/providers/ollama.test.ts`

**Step 1: Write the failing tests**

Create `runner/src/providers/ollama.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OllamaProvider } from './ollama.js';

// Capture constructor config so we can assert on baseURL
let capturedConfig: Record<string, unknown> = {};
const createMock = vi.fn();

vi.mock('openai', () => ({
  default: class FakeOpenAI {
    chat = { completions: { create: createMock } };
    constructor(config: Record<string, unknown>) {
      capturedConfig = config;
    }
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  capturedConfig = {};
});

describe('OllamaProvider', () => {
  it('has name "ollama"', () => {
    const provider = new OllamaProvider();
    expect(provider.name).toBe('ollama');
  });

  it('passes correct baseURL to SDK (default)', () => {
    new OllamaProvider();
    expect(capturedConfig.baseURL).toBe('http://localhost:11434/v1');
    expect(capturedConfig.apiKey).toBe('ollama');
  });

  it('passes custom baseURL to SDK', () => {
    new OllamaProvider('http://my-server:11434');
    expect(capturedConfig.baseURL).toBe('http://my-server:11434/v1');
  });

  it('returns content and tool calls on non-streaming call', async () => {
    createMock.mockResolvedValueOnce({
      choices: [{
        message: {
          content: '{"result":"ok"}',
          tool_calls: [{
            id: 'call_1',
            function: { name: 'repo_manager-read_file', arguments: '{"path":"src/foo.ts"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    });

    const provider = new OllamaProvider();
    const result = await provider.call({
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(result.content).toBe('{"result":"ok"}');
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0].name).toBe('repo_manager-read_file');
    expect(result.tool_calls[0].arguments).toEqual({ path: 'src/foo.ts' });
    expect(result.usage?.total_tokens).toBe(30);
  });

  it('streaming: does NOT send stream_options', async () => {
    async function* fakeStream() {
      yield { choices: [{ delta: { content: 'hi' }, finish_reason: null }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
    }
    createMock.mockReturnValueOnce(fakeStream());

    const provider = new OllamaProvider();
    await provider.call(
      { model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }] },
      () => {},
    );

    const callArgs = createMock.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.stream_options).toBeUndefined();
    expect(callArgs.stream).toBe(true);
  });

  it('streaming: accumulates content and calls onToken', async () => {
    async function* fakeStream() {
      yield { choices: [{ delta: { content: 'hello' }, finish_reason: null }] };
      yield { choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }] };
    }
    createMock.mockReturnValueOnce(fakeStream());

    const provider = new OllamaProvider();
    const tokens: string[] = [];
    const result = await provider.call(
      { model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }] },
      (t) => tokens.push(t),
    );

    expect(result.content).toBe('hello world');
    expect(tokens).toEqual(['hello', ' world']);
  });

  it('wraps ECONNREFUSED with a helpful message', async () => {
    const connErr = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
      code: 'ECONNREFUSED',
    });
    createMock.mockRejectedValueOnce(connErr);

    const provider = new OllamaProvider();
    await expect(
      provider.call({ model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow('Ollama is not running at http://localhost:11434');
  });

  it('wraps ECONNREFUSED from error.cause too', async () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const wrappedErr = new Error('fetch failed');
    (wrappedErr as Error & { cause: unknown }).cause = cause;
    createMock.mockRejectedValueOnce(wrappedErr);

    const provider = new OllamaProvider();
    await expect(
      provider.call({ model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow('ollama serve');
  });
});
```

**Step 2: Run tests to confirm they fail**

```bash
cd .worktrees/stu-87-ollama
pnpm --filter @studio-foundation/runner test 2>&1 | grep -A3 'ollama'
```

Expected: `Cannot find module './ollama.js'`

**Step 3: Implement `runner/src/providers/ollama.ts`**

```typescript
/**
 * Ollama provider — OpenAI-compatible local LLM server
 * Uses the openai npm SDK pointed at Ollama's /v1 endpoint.
 */

import type { LLMRequest, LLMResponse } from '@studio-foundation/contracts';
import type { Provider } from './provider.js';
import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool, ChatCompletionChunk } from 'openai/resources/chat/completions';

function isConnectionRefused(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if ('code' in err && (err as NodeJS.ErrnoException).code === 'ECONNREFUSED') return true;
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause instanceof Error && 'code' in cause && (cause as NodeJS.ErrnoException).code === 'ECONNREFUSED') return true;
  if (err.message.includes('ECONNREFUSED')) return true;
  return false;
}

export class OllamaProvider implements Provider {
  readonly name = 'ollama';
  private client: OpenAI;
  private baseUrl: string;

  constructor(baseUrl = 'http://localhost:11434') {
    this.baseUrl = baseUrl;
    this.client = new OpenAI({
      baseURL: `${baseUrl}/v1`,
      apiKey: 'ollama', // required by SDK, ignored by Ollama
    });
  }

  async call(request: LLMRequest, onToken?: (token: string) => void, signal?: AbortSignal): Promise<LLMResponse> {
    try {
      if (onToken) {
        return await this.callStreaming(request, onToken, signal);
      }
      return await this.callNonStreaming(request, signal);
    } catch (err) {
      if (isConnectionRefused(err)) {
        throw new Error(
          `Ollama is not running at ${this.baseUrl}. Start it with: ollama serve`
        );
      }
      throw err;
    }
  }

  private async callNonStreaming(request: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
    const completion = await this.client.chat.completions.create({
      model: request.model,
      messages: this.buildMessages(request),
      tools: this.buildTools(request),
      temperature: request.temperature,
      max_tokens: request.max_tokens,
    }, { signal });

    const choice = completion.choices[0];
    const tool_calls = choice.message.tool_calls?.map(tc => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments),
    })) || [];

    return {
      content: choice.message.content || '',
      tool_calls,
      finish_reason: choice.finish_reason,
      usage: completion.usage ? {
        prompt_tokens: completion.usage.prompt_tokens,
        completion_tokens: completion.usage.completion_tokens,
        total_tokens: completion.usage.total_tokens,
      } : undefined,
    };
  }

  private async callStreaming(
    request: LLMRequest,
    onToken: (token: string) => void,
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    // NOTE: No stream_options here — older Ollama versions reject it
    const stream = this.client.chat.completions.create({
      model: request.model,
      messages: this.buildMessages(request),
      tools: this.buildTools(request),
      temperature: request.temperature,
      max_tokens: request.max_tokens,
      stream: true as const,
    }, { signal }) as unknown as AsyncIterable<ChatCompletionChunk>;

    let textContent = '';
    const toolCallMap = new Map<number, { id: string; name: string; args: string }>();
    let finishReason = 'stop';

    for await (const chunk of stream) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
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
    }

    const tool_calls = Array.from(toolCallMap.values()).map(tc => ({
      id: tc.id,
      name: tc.name,
      arguments: JSON.parse(tc.args || '{}'),
    }));

    return { content: textContent, tool_calls, finish_reason: finishReason, usage: undefined };
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
    if (!request.tools || request.tools.length === 0) return undefined;
    return request.tools.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }
}
```

**Step 4: Run the tests**

```bash
pnpm --filter @studio-foundation/runner test 2>&1 | tail -20
```

Expected: All ollama tests pass.

**Step 5: Commit**

```bash
cd .worktrees/stu-87-ollama
git add runner/src/providers/ollama.ts runner/src/providers/ollama.test.ts
git commit -m "feat(runner): add OllamaProvider — OpenAI-compatible local LLM adapter [STU-87]"
```

---

### Task 2: Register OllamaProvider in registry + export

**Files:**
- Modify: `runner/src/providers/registry.ts`
- Modify: `runner/src/index.ts`

**Step 1: Update `createDefaultRegistry` in `runner/src/providers/registry.ts`**

Add to the import at the top:
```typescript
import { OllamaProvider } from './ollama.js';
```

Change the function signature and body:
```typescript
export function createDefaultRegistry(config: {
  openai?: { apiKey: string; baseUrl?: string };
  anthropic?: { apiKey: string };
  openaiResponses?: { apiKey: string };
  ollama?: { baseUrl?: string };          // ADD THIS
}): ProviderRegistry {
  const registry = new ProviderRegistry();

  if (config.openai) {
    registry.register(new OpenAIProvider(config.openai.apiKey, config.openai.baseUrl));
  }
  if (config.anthropic) {
    registry.register(new AnthropicProvider(config.anthropic.apiKey));
  }
  if (config.openaiResponses) {
    registry.register(new OpenAIResponsesProvider(config.openaiResponses.apiKey));
  }
  if (config.ollama) {                    // ADD THIS BLOCK
    registry.register(new OllamaProvider(config.ollama.baseUrl));
  }

  return registry;
}
```

**Step 2: Export from `runner/src/index.ts`**

Add after the `AnthropicProvider` export line:
```typescript
export { OllamaProvider } from './providers/ollama.js';
```

**Step 3: Build and verify no type errors**

```bash
cd .worktrees/stu-87-ollama
pnpm build 2>&1 | grep -E 'error|Error' | head -10
```

Expected: No errors.

**Step 4: Run all runner tests**

```bash
pnpm --filter @studio-foundation/runner test 2>&1 | tail -5
```

Expected: All passing.

**Step 5: Commit**

```bash
git add runner/src/providers/registry.ts runner/src/index.ts
git commit -m "feat(runner): register OllamaProvider in createDefaultRegistry + export [STU-87]"
```

---

### Task 3: Update CLI config type + run command

**Files:**
- Modify: `cli/src/config.ts`
- Modify: `cli/src/commands/run.ts`

**Step 1: Add `ollama` to `StudioConfig` in `cli/src/config.ts`**

Change the `providers` field:
```typescript
providers?: {
  openai?: { apiKey: string };
  anthropic?: { apiKey: string };
  ollama?: { baseUrl?: string };   // ADD THIS
};
```

**Step 2: Pass ollama config in `cli/src/commands/run.ts`**

Find the `createDefaultRegistry(...)` call (~line 276). Change it to:
```typescript
const providerRegistry = createDefaultRegistry(
  options.provider === 'mock' ? {} : {
    openai: config.providers?.openai ? { apiKey: config.providers.openai.apiKey } : undefined,
    anthropic: config.providers?.anthropic ? { apiKey: config.providers.anthropic.apiKey } : undefined,
    openaiResponses: config.providers?.openai ? { apiKey: config.providers.openai.apiKey } : undefined,
    ollama: config.providers?.ollama ? { baseUrl: config.providers.ollama.baseUrl } : undefined,  // ADD
  }
);
```

**Step 3: Build**

```bash
cd .worktrees/stu-87-ollama
pnpm build 2>&1 | grep -E 'error|Error' | head -10
```

Expected: No errors.

**Step 4: Run CLI tests**

```bash
pnpm --filter @studio-foundation/cli test 2>&1 | tail -5
```

Expected: All passing (no tests reference the new field yet).

**Step 5: Commit**

```bash
git add cli/src/config.ts cli/src/commands/run.ts
git commit -m "feat(cli): add ollama provider to StudioConfig + run command [STU-87]"
```

---

### Task 4: Update CLI config wizard (local → ollama)

The CLI currently uses `'local'` as the provider ID for Ollama. We rename it to `'ollama'` throughout, and fix `addProviderConfig` to store `{ baseUrl }` instead of `{ apiKey }` for ollama.

**Files:**
- Modify: `cli/src/commands/config.ts`
- Modify: `cli/src/provider-validator.ts`

**Step 1: Update PROVIDERS list in `cli/src/commands/config.ts`**

Find the PROVIDERS array. Change the `local` entry:
```typescript
// Before:
{ id: 'local', label: 'Local (Ollama)', defaultModel: 'llama3.2' },

// After:
{ id: 'ollama', label: 'Ollama (local)', defaultModel: 'llama3.2' },
```

**Step 2: Fix `validateApiKeyForProvider` for ollama in `cli/src/commands/config.ts`**

Find the validation function. The `local` branch needs renaming:
```typescript
// Find:
} else if (provider === 'local') {

// Change to:
} else if (provider === 'ollama') {
```

**Step 3: Fix `addProviderConfig` to store `{ baseUrl }` for ollama**

In `addProviderConfig` (around line 46), change the assignment:
```typescript
// Before:
(config.providers as Record<string, unknown>)[provider] = { apiKey };

// After:
if (provider === 'ollama') {
  (config.providers as Record<string, unknown>)[provider] = { baseUrl: apiKey };
} else {
  (config.providers as Record<string, unknown>)[provider] = { apiKey };
}
```

Note: `apiKey` here holds the baseUrl value entered by the user — the wizard asks "Ollama base URL" and passes it as the `apiKey` parameter. After this change, it gets stored under the correct key.

**Step 4: Update all `'local'` string references in `cli/src/commands/config.ts`**

Search for remaining `'local'` references (validation branch, wizard call to `validateApiKeyLive`, the written config section):

```bash
grep -n "'local'" .worktrees/stu-87-ollama/cli/src/commands/config.ts
```

Change each `'local'` → `'ollama'` where it refers to the provider ID.

**Step 5: Update `cli/src/provider-validator.ts`**

Find:
```typescript
} else if (provider === 'local') {
  return await validateLocalOllama(...)
```

Change to:
```typescript
} else if (provider === 'ollama') {
  return await validateLocalOllama(...)
```

**Step 6: Run CLI tests and fix any that reference `'local'`**

```bash
pnpm --filter @studio-foundation/cli test 2>&1 | grep -E 'FAIL|local' | head -20
```

In `cli/tests/commands/config.test.ts`, find tests that assert `ids.toContain('local')` and update to `'ollama'`. Find tests that call `addProviderConfig(..., 'local', ...)` and update. Find tests that call `validateApiKeyLive('local', ...)` and update.

In `cli/tests/provider-validator.test.ts`, find tests that call `validateApiKeyLive('local', ...)` and update to `'ollama'`.

After fixing, re-run:
```bash
pnpm --filter @studio-foundation/cli test 2>&1 | tail -5
```

Expected: All passing.

**Step 7: Commit**

```bash
git add cli/src/commands/config.ts cli/src/provider-validator.ts \
        cli/tests/commands/config.test.ts cli/tests/provider-validator.test.ts
git commit -m "feat(cli): rename local → ollama provider, store baseUrl correctly [STU-87]"
```

---

### Task 5: Update API bootstrap

**Files:**
- Modify: `api/src/bootstrap.ts`
- Modify: `api/src/routes/config.ts`

**Step 1: Add `ollama` to `StudioApiConfig` in `api/src/bootstrap.ts`**

Find the `StudioApiConfig` interface (~line 36):
```typescript
providers?: {
  openai?: { apiKey: string };
  anthropic?: { apiKey: string };
  ollama?: { baseUrl?: string };   // ADD THIS
};
```

**Step 2: Pass ollama to `createDefaultRegistry` in `api/src/bootstrap.ts`**

Find the `createDefaultRegistry({...})` call (~line 149):
```typescript
const providerRegistry = createDefaultRegistry({
  openai: config.providers?.openai ? { apiKey: config.providers.openai.apiKey } : undefined,
  anthropic: config.providers?.anthropic ? { apiKey: config.providers.anthropic.apiKey } : undefined,
  openaiResponses: config.providers?.openai ? { apiKey: config.providers.openai.apiKey } : undefined,
  ollama: config.providers?.ollama ? { baseUrl: config.providers.ollama.baseUrl } : undefined,  // ADD
});
```

**Step 3: Add `ollama` to `KNOWN_PROVIDERS` in `api/src/routes/config.ts`**

Find:
```typescript
const KNOWN_PROVIDERS = new Set(['anthropic', 'openai']);
```

Change to:
```typescript
const KNOWN_PROVIDERS = new Set(['anthropic', 'openai', 'ollama']);
```

**Step 4: Build everything**

```bash
cd .worktrees/stu-87-ollama
pnpm build 2>&1 | grep -E 'error|Error' | head -10
```

Expected: No errors.

**Step 5: Run all tests**

```bash
pnpm test 2>&1 | tail -10
```

Expected: All passing.

**Step 6: Commit**

```bash
git add api/src/bootstrap.ts api/src/routes/config.ts
git commit -m "feat(api): add ollama provider to bootstrap + KNOWN_PROVIDERS [STU-87]"
```

---

### Task 6: Final verification

**Step 1: Full build from root**

```bash
cd .worktrees/stu-87-ollama
pnpm build 2>&1 | tail -5
```

Expected: Clean build, no errors.

**Step 2: Full test suite**

```bash
pnpm test 2>&1 | tail -10
```

Expected: All tests passing, none failing.

**Step 3: Verify the end-to-end config works**

Manually verify the target config from the ticket would parse correctly:

```bash
cat > /tmp/test-ollama-config.yaml << 'EOF'
providers:
  ollama:
    baseUrl: http://localhost:11434
defaults:
  provider: ollama
  model: llama3.2
EOF
```

Check `StudioConfig` type accepts this shape (TypeScript confirms at build time).

**Step 4: Commit if any cleanup needed, then proceed to PR**

```bash
git log --oneline arianedguay/stu-87-adaptateur-ollama-dans-runner ^main
```

Expected: 6 commits (design doc + 5 feature commits).
