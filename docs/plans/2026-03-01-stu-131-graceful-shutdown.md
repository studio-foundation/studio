# STU-131 Graceful Shutdown Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix Ctrl-C during an active LLM stream so it cancels the pipeline within 1–2 seconds instead of hanging indefinitely.

**Architecture:** Add a `raceSignal()` utility in `runner/src/utils/`, then use it in the Anthropic provider to race `stream.finalMessage()` against signal abort. Add a per-chunk signal check in the OpenAI provider's `for await` loop. No changes to ralph, engine, or CLI — the cancellation propagation chain is already correct.

**Tech Stack:** Vitest (test runner), Anthropic SDK (`@anthropic-ai/sdk`), OpenAI SDK (`openai`), Node.js `AbortController`/`AbortSignal`.

---

## Context (read before starting)

The signal already flows: CLI → engine → ralph → runner → provider. The bug is purely inside the providers:

- **Anthropic:** `stream.finalMessage()` waits for a stream `end` event that never fires when the HTTP connection is aborted mid-stream. The `await` hangs forever.
- **OpenAI:** The `for await (const chunk of stream)` loop has no per-chunk signal check. Buffered chunks keep processing after abort.

Ralph's catch block (loop.ts:58–62) already checks `signal?.aborted` after any error, so once a provider throws, cancellation flows through cleanly.

---

## Task 1: Create worktree

Per CLAUDE.md, every Linear ticket starts with a worktree.

**Step 1: Create the worktree**

```bash
git worktree add .worktrees/stu-131-graceful-shutdown -b fix/stu-131-graceful-shutdown
cd .worktrees/stu-131-graceful-shutdown
```

**Step 2: Verify you're in the worktree**

```bash
git branch --show-current
```
Expected: `fix/stu-131-graceful-shutdown`

---

## Task 2: `raceSignal()` utility — TDD

**Files:**
- Create: `runner/src/utils/race-signal.ts`
- Create: `runner/src/utils/race-signal.test.ts`

---

**Step 1: Write the failing tests**

Create `runner/src/utils/race-signal.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { raceSignal } from './race-signal.js';

describe('raceSignal', () => {
  it('resolves normally when no signal provided', async () => {
    const result = await raceSignal(Promise.resolve(42));
    expect(result).toBe(42);
  });

  it('resolves normally when signal is not aborted', async () => {
    const controller = new AbortController();
    const result = await raceSignal(Promise.resolve('hello'), controller.signal);
    expect(result).toBe('hello');
  });

  it('rejects immediately if signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(raceSignal(new Promise(() => {}), controller.signal))
      .rejects.toThrow('Aborted');
  });

  it('rejects when signal fires after creation', async () => {
    const controller = new AbortController();
    // A promise that never resolves on its own
    const hanging = new Promise<never>(() => {});
    const raced = raceSignal(hanging, controller.signal);
    controller.abort();
    await expect(raced).rejects.toThrow('Aborted');
  });

  it('resolves if promise resolves before signal fires', async () => {
    const controller = new AbortController();
    const result = await raceSignal(Promise.resolve(99), controller.signal);
    // Abort after the fact — should not cause rejection
    controller.abort();
    expect(result).toBe(99);
  });

  it('thrown error name is AbortError', async () => {
    const controller = new AbortController();
    controller.abort();
    try {
      await raceSignal(new Promise(() => {}), controller.signal);
    } catch (e) {
      expect(e).toBeInstanceOf(DOMException);
      expect((e as DOMException).name).toBe('AbortError');
    }
  });
});
```

**Step 2: Run the tests to verify they fail**

```bash
cd runner && pnpm vitest run src/utils/race-signal.test.ts
```
Expected: FAIL — "Cannot find module './race-signal.js'"

**Step 3: Write the implementation**

Create `runner/src/utils/race-signal.ts`:

```typescript
/**
 * Race a promise against an AbortSignal.
 * Rejects with DOMException('Aborted', 'AbortError') if the signal fires first.
 */
export function raceSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });

    promise
      .then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); })
      .catch((e) => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}
```

**Step 4: Run tests to verify they pass**

```bash
cd runner && pnpm vitest run src/utils/race-signal.test.ts
```
Expected: 6 tests PASS

**Step 5: Commit**

```bash
git add runner/src/utils/race-signal.ts runner/src/utils/race-signal.test.ts
git commit -m "feat(runner): add raceSignal utility for signal-aware promise racing"
```

---

## Task 3: Fix Anthropic provider — TDD

**Files:**
- Create: `runner/src/providers/anthropic.test.ts`
- Modify: `runner/src/providers/anthropic.ts`

---

**Step 1: Write the failing test**

Create `runner/src/providers/anthropic.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicProvider } from './anthropic.js';

// We mock the entire SDK so no real HTTP calls are made.
// The fake stream hangs on finalMessage() to simulate the bug scenario.
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class FakeAnthropic {
      messages = {
        stream: (_params: unknown, _opts: unknown) => {
          const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
          return {
            on(event: string, handler: (...args: unknown[]) => void) {
              if (!listeners.has(event)) listeners.set(event, []);
              listeners.get(event)!.push(handler);
              return this;
            },
            // finalMessage() hangs forever — this is the bug we're fixing
            finalMessage: () => new Promise(() => {}),
          };
        },
        create: (_params: unknown, _opts: unknown) => new Promise(() => {}),
      };
    },
  };
});

describe('AnthropicProvider', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    provider = new AnthropicProvider('test-key');
  });

  it('aborts streaming call when signal fires', async () => {
    const controller = new AbortController();
    const onToken = vi.fn();

    const callPromise = provider.call(
      {
        model: 'claude-haiku-4-20250514',
        messages: [{ role: 'user', content: 'hello' }],
      },
      onToken,
      controller.signal,
    );

    // Fire signal after a tick to let the stream start
    await Promise.resolve();
    controller.abort();

    await expect(callPromise).rejects.toSatisfy(
      (e: unknown) => e instanceof DOMException && (e as DOMException).name === 'AbortError',
    );
  });

  it('aborts non-streaming call when signal fires', async () => {
    const controller = new AbortController();

    const callPromise = provider.call(
      {
        model: 'claude-haiku-4-20250514',
        messages: [{ role: 'user', content: 'hello' }],
      },
      undefined,
      controller.signal,
    );

    await Promise.resolve();
    controller.abort();

    await expect(callPromise).rejects.toSatisfy(
      (e: unknown) => e instanceof DOMException && (e as DOMException).name === 'AbortError',
    );
  });

  it('resolves normally when signal is not aborted', async () => {
    // Override the mock for this test to return immediately
    const { default: FakeAnthropic } = await import('@anthropic-ai/sdk');
    const fakeFinalMessage = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{"ok":true}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    vi.mocked(FakeAnthropic).prototype.messages = {
      stream: () => ({
        on: (_: string, __: unknown) => ({ on: (_: string, __: unknown) => {} }),
        finalMessage: fakeFinalMessage,
      }),
      create: vi.fn(),
    } as unknown as typeof FakeAnthropic.prototype.messages;

    const controller = new AbortController();
    const result = await provider.call(
      {
        model: 'claude-haiku-4-20250514',
        messages: [{ role: 'user', content: 'hello' }],
      },
      vi.fn(),
      controller.signal,
    );
    expect(result).toBeDefined();
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd runner && pnpm vitest run src/providers/anthropic.test.ts
```
Expected: 2 tests FAIL — the abort tests time out because `finalMessage()` hangs.

**Step 3: Fix the Anthropic provider**

Open `runner/src/providers/anthropic.ts`. Make these two changes:

1. Add the import at the top (after the existing imports):
```typescript
import { raceSignal } from '../utils/race-signal.js';
```

2. Replace the streaming block (the `if (onToken) { ... }` block, lines 28–34) with:
```typescript
    if (onToken) {
      // Streaming path
      const stream = this.client.messages.stream(params, { signal });
      stream.on('text', (textDelta: string) => {
        if (signal?.aborted) return; // guard: don't emit after abort
        onToken(textDelta);
      });
      // KEY FIX: race finalMessage() against signal abort.
      // Without this, finalMessage() hangs forever when the HTTP connection
      // is killed mid-stream (the stream 'end' event never fires).
      const response = await raceSignal(stream.finalMessage(), signal);
      return this.parseResponse(response);
    }
```

The non-streaming path (line 37) already passes `signal` to the SDK correctly — no change needed there.

**Step 4: Run tests to verify they pass**

```bash
cd runner && pnpm vitest run src/providers/anthropic.test.ts
```
Expected: all tests PASS

**Step 5: Commit**

```bash
git add runner/src/providers/anthropic.ts runner/src/providers/anthropic.test.ts
git commit -m "fix(runner): abort Anthropic stream via raceSignal on finalMessage()

Fixes STU-131: finalMessage() could hang indefinitely when the HTTP
connection is killed mid-stream. Now races against the AbortSignal."
```

---

## Task 4: Fix OpenAI provider — TDD

**Files:**
- Create: `runner/src/providers/openai.test.ts`
- Modify: `runner/src/providers/openai.ts`

---

**Step 1: Write the failing test**

Create `runner/src/providers/openai.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { OpenAIProvider } from './openai.js';

// Fake async iterable that yields chunks with a delay between each,
// simulating a slow stream that should be interruptible.
async function* slowStream(chunks: unknown[], delayMs = 10): AsyncGenerator<unknown> {
  for (const chunk of chunks) {
    await new Promise((r) => setTimeout(r, delayMs));
    yield chunk;
  }
}

vi.mock('openai', () => {
  return {
    default: class FakeOpenAI {
      chat = {
        completions: {
          create: (_params: unknown, _opts: { signal?: AbortSignal }) =>
            slowStream([
              { choices: [{ delta: { content: 'hello' }, finish_reason: null }] },
              { choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }] },
            ]),
        },
      };
    },
  };
});

describe('OpenAIProvider', () => {
  it('aborts streaming when signal fires mid-iteration', async () => {
    const provider = new OpenAIProvider('test-key');
    const controller = new AbortController();
    const onToken = vi.fn();

    const callPromise = provider.call(
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
      },
      onToken,
      controller.signal,
    );

    // Abort after first chunk has a chance to arrive
    setTimeout(() => controller.abort(), 5);

    await expect(callPromise).rejects.toSatisfy(
      (e: unknown) => e instanceof DOMException && (e as DOMException).name === 'AbortError',
    );
  });

  it('completes normally when signal is not aborted', async () => {
    const provider = new OpenAIProvider('test-key');
    const onToken = vi.fn();

    const result = await provider.call(
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
      },
      onToken,
    );

    expect(result.content).toBe('hello world');
    expect(onToken).toHaveBeenCalledTimes(2);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd runner && pnpm vitest run src/providers/openai.test.ts
```
Expected: FAIL — the abort test times out (loop never checks signal).

**Step 3: Fix the OpenAI provider**

Open `runner/src/providers/openai.ts`. In `callStreaming()`, add a signal check at the very top of the `for await` loop (line 81):

```typescript
    for await (const chunk of stream) {
      // KEY FIX: check signal at the start of each chunk so we don't keep
      // consuming buffered data after Ctrl-C.
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const delta = chunk.choices[0]?.delta;
      // ... rest unchanged
```

**Step 4: Run tests to verify they pass**

```bash
cd runner && pnpm vitest run src/providers/openai.test.ts
```
Expected: 2 tests PASS

**Step 5: Commit**

```bash
git add runner/src/providers/openai.ts runner/src/providers/openai.test.ts
git commit -m "fix(runner): check AbortSignal per-chunk in OpenAI streaming loop

Fixes STU-131: the for-await loop had no signal check, so buffered
chunks kept processing after Ctrl-C."
```

---

## Task 5: Full test suite + build

**Step 1: Run all runner tests**

```bash
cd runner && pnpm vitest run
```
Expected: all tests PASS (no regressions)

**Step 2: Build the full monorepo**

From the repo root:
```bash
pnpm build
```
Expected: all 7 packages build without errors.

**Step 3: Smoke test with mock provider**

From the worktree root (requires a `.studio/` setup in the worktree or a project that has one):
```bash
studio run <any-pipeline> --provider mock
```
Press Ctrl-C while it's "running" — it should cancel within 1–2 seconds with status `cancelled`.

If you don't have a project handy, skip this step — the unit tests cover the abort behavior.

**Step 4: Final commit if anything changed**

If `pnpm build` produced any compiled output that changed:
```bash
git add -A
git commit -m "build: compile runner after graceful shutdown fixes"
```

---

## Task 6: Open PR

**Step 1: Push the branch**

```bash
git push -u origin fix/stu-131-graceful-shutdown
```

**Step 2: Create the PR**

```bash
gh pr create \
  --title "[STU-131] fix(runner): graceful shutdown during active LLM stream" \
  --body "$(cat <<'EOF'
## What

Fixes Ctrl-C hanging indefinitely when pressed during an active LLM stream.

## Why

- **Anthropic:** `stream.finalMessage()` waits for a stream `end` event that never fires when the HTTP connection is killed mid-stream. Added `raceSignal()` to race it against the AbortSignal.
- **OpenAI:** The `for await` loop had no per-chunk signal check. Added check at the top of each iteration.

## Packages touched

- `runner` — `src/utils/race-signal.ts` (new), `src/providers/anthropic.ts`, `src/providers/openai.ts`

## How to test

1. Start a pipeline with a real LLM provider
2. Press Ctrl-C while the LLM is generating
3. Pipeline should cancel within 1–2 seconds with `status: cancelled`
4. Check that `pipeline_complete` is written to the JSONL log

Closes STU-131
EOF
)" \
  --base main
```

---

## Acceptance criteria checklist

- [ ] Ctrl-C during LLM stream cancels within 1–2s
- [ ] Run status is `cancelled` (not `failed`)
- [ ] `pipeline_complete` written to JSONL log
- [ ] No partial file writes (tool calls always finish)
- [ ] All tests pass
- [ ] `pnpm build` passes
