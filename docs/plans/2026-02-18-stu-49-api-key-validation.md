# STU-49: API Key Validation + Models Cache Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** After format-validating an API key, make a real network call to confirm it works — and reuse that call to populate an in-memory models cache so wizards can offer smart model selection instead of hardcoded defaults.

**Architecture:** Two new modules: `provider-validator.ts` (validates API keys via network, silently populates cache) and `models-cache.ts` (in-memory Map with TTL, filtering heuristics, sorting). Both `studio init` and `studio config add-provider` gain live validation with a re-prompt loop in wizard mode and fail-fast in direct mode. A new interactive mode for `studio config set defaults.model` (no value → select from available models).

**Tech Stack:** Node.js built-in `fetch` + `AbortController`, `@inquirer/prompts` (`select`, `password`, `input`), `ora`, `vitest` with `vi.stubGlobal('fetch', ...)` for mocking.

---

### Task 1: Create `models-cache.ts` with unit tests

**Files:**
- Create: `cli/src/models-cache.ts`
- Create: `cli/tests/models-cache.test.ts`

**Step 1: Write the failing tests**

```typescript
// cli/tests/models-cache.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  setCachedModels,
  getCachedModels,
  parseAndCacheModels,
  getAvailableModels,
  filterModels,
  sortModels,
} from '../../src/models-cache.js';

// ─── filterModels ────────────────────────────────────────────────────────────

describe('filterModels — anthropic', () => {
  it('keeps claude-* models', () => {
    const models = [
      { id: 'claude-sonnet-4-20250514' },
      { id: 'claude-haiku-4-20250514' },
    ];
    expect(filterModels('anthropic', models)).toEqual([
      'claude-sonnet-4-20250514',
      'claude-haiku-4-20250514',
    ]);
  });

  it('excludes claude-instant*', () => {
    const models = [
      { id: 'claude-sonnet-4-20250514' },
      { id: 'claude-instant-1' },
    ];
    expect(filterModels('anthropic', models)).not.toContain('claude-instant-1');
  });

  it('excludes claude-2*', () => {
    const models = [
      { id: 'claude-sonnet-4-20250514' },
      { id: 'claude-2.1' },
    ];
    expect(filterModels('anthropic', models)).not.toContain('claude-2.1');
  });

  it('excludes non-claude models', () => {
    const models = [{ id: 'gpt-4o' }, { id: 'claude-sonnet-4-20250514' }];
    expect(filterModels('anthropic', models)).toEqual(['claude-sonnet-4-20250514']);
  });
});

describe('filterModels — openai', () => {
  it('keeps gpt-4* models', () => {
    const models = [{ id: 'gpt-4o' }, { id: 'gpt-4-turbo' }];
    const result = filterModels('openai', models);
    expect(result).toContain('gpt-4o');
    expect(result).toContain('gpt-4-turbo');
  });

  it('keeps o1* and o3* models', () => {
    const models = [{ id: 'o1-preview' }, { id: 'o3-mini' }, { id: 'gpt-3.5-turbo' }];
    const result = filterModels('openai', models);
    expect(result).toContain('o1-preview');
    expect(result).toContain('o3-mini');
    expect(result).not.toContain('gpt-3.5-turbo');
  });

  it('excludes gpt-3.5* models', () => {
    const models = [{ id: 'gpt-3.5-turbo' }, { id: 'gpt-4o' }];
    expect(filterModels('openai', models)).toEqual(['gpt-4o']);
  });
});

describe('filterModels — unknown provider', () => {
  it('keeps all models for unknown providers', () => {
    const models = [{ id: 'model-a' }, { id: 'model-b' }];
    expect(filterModels('future-provider', models)).toEqual(['model-a', 'model-b']);
  });
});

// ─── sortModels ──────────────────────────────────────────────────────────────

describe('sortModels', () => {
  it('sorts by created timestamp descending', () => {
    const ids = ['old-model', 'new-model'];
    const raw = [
      { id: 'old-model', created: 1000 },
      { id: 'new-model', created: 2000 },
    ];
    expect(sortModels(ids, raw)).toEqual(['new-model', 'old-model']);
  });

  it('sorts by created_at ISO string descending', () => {
    const ids = ['model-a', 'model-b'];
    const raw = [
      { id: 'model-a', created_at: '2024-01-01T00:00:00Z' },
      { id: 'model-b', created_at: '2025-01-01T00:00:00Z' },
    ];
    expect(sortModels(ids, raw)).toEqual(['model-b', 'model-a']);
  });

  it('falls back to lexicographic descending when no timestamp', () => {
    const ids = ['claude-haiku', 'claude-sonnet', 'claude-opus'];
    const raw = [{ id: 'claude-haiku' }, { id: 'claude-sonnet' }, { id: 'claude-opus' }];
    const result = sortModels(ids, raw);
    // lexicographic descending: sonnet > opus > haiku
    expect(result[0]).toBe('claude-sonnet');
  });
});

// ─── setCachedModels / getCachedModels ───────────────────────────────────────

describe('setCachedModels / getCachedModels', () => {
  it('returns null when no entry exists', () => {
    expect(getCachedModels('anthropic', 'sk-ant-missing')).toBeNull();
  });

  it('returns stored models on cache hit', () => {
    const models = ['claude-sonnet-4-20250514', 'claude-haiku-4-20250514'];
    setCachedModels('anthropic', 'sk-ant-test1234', models);
    expect(getCachedModels('anthropic', 'sk-ant-test1234')).toEqual(models);
  });

  it('uses first 8 chars of apiKey as part of cache key (different full keys, same prefix → same entry)', () => {
    setCachedModels('anthropic', 'sk-ant-AAAAAAAA-different-suffix', ['model-a']);
    // Same first 8 chars: 'sk-ant-A'
    expect(getCachedModels('anthropic', 'sk-ant-AAAAAAAA-other-suffix')).toEqual(['model-a']);
  });

  it('returns null after TTL expires', () => {
    const realNow = Date.now;
    try {
      // Set cache entry
      Date.now = () => 0;
      setCachedModels('anthropic', 'sk-ant-expiry-test', ['model-x']);
      // Advance time past 24h
      Date.now = () => 25 * 60 * 60 * 1000;
      expect(getCachedModels('anthropic', 'sk-ant-expiry-test')).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  it('different providers do not share cache entries', () => {
    setCachedModels('anthropic', 'sk-ant-shared', ['claude-model']);
    expect(getCachedModels('openai', 'sk-ant-shared')).toBeNull();
  });
});

// ─── parseAndCacheModels ─────────────────────────────────────────────────────

describe('parseAndCacheModels', () => {
  it('parses Anthropic response format, filters, and caches', () => {
    const json = {
      data: [
        { id: 'claude-sonnet-4-20250514', created_at: '2025-05-14T00:00:00Z' },
        { id: 'claude-instant-1' },     // excluded
        { id: 'claude-2.1' },           // excluded
      ],
    };
    parseAndCacheModels('anthropic', 'sk-ant-parse-test', json);
    const cached = getCachedModels('anthropic', 'sk-ant-parse-test');
    expect(cached).toContain('claude-sonnet-4-20250514');
    expect(cached).not.toContain('claude-instant-1');
    expect(cached).not.toContain('claude-2.1');
  });

  it('parses OpenAI response format', () => {
    const json = {
      data: [
        { id: 'gpt-4o', created: 2000 },
        { id: 'gpt-3.5-turbo', created: 1000 }, // excluded
      ],
    };
    parseAndCacheModels('openai', 'sk-parse-openai', json);
    const cached = getCachedModels('openai', 'sk-parse-openai');
    expect(cached).toContain('gpt-4o');
    expect(cached).not.toContain('gpt-3.5-turbo');
  });

  it('does not throw on malformed JSON', () => {
    expect(() => parseAndCacheModels('anthropic', 'sk-ant-bad', null)).not.toThrow();
    expect(() => parseAndCacheModels('anthropic', 'sk-ant-bad', { no_data: true })).not.toThrow();
  });
});

// ─── getAvailableModels ──────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => { mockFetch.mockReset(); });

describe('getAvailableModels', () => {
  it('returns cached models without fetching', async () => {
    const models = ['claude-sonnet-4-20250514'];
    setCachedModels('anthropic', 'sk-ant-cached', models);
    const result = await getAvailableModels('anthropic', 'sk-ant-cached');
    expect(result).toEqual(models);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fetches from Anthropic API on cache miss', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: 'claude-sonnet-4-20250514' }, { id: 'claude-instant-1' }],
      }),
    });
    const result = await getAvailableModels('anthropic', 'sk-ant-fetch-test');
    expect(result).toContain('claude-sonnet-4-20250514');
    expect(result).not.toContain('claude-instant-1');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('fetches from OpenAI API on cache miss', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: 'gpt-4o' }, { id: 'gpt-3.5-turbo' }],
      }),
    });
    const result = await getAvailableModels('openai', 'sk-openai-fetch');
    expect(result).toContain('gpt-4o');
    expect(result).not.toContain('gpt-3.5-turbo');
  });

  it('returns [] on fetch error (never throws)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await getAvailableModels('anthropic', 'sk-ant-network-error');
    expect(result).toEqual([]);
  });

  it('returns [] for google provider (not supported)', async () => {
    const result = await getAvailableModels('google', 'AIzaKey');
    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns [] for local provider', async () => {
    const result = await getAvailableModels('local', 'http://localhost:11434');
    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('populates cache after fetch so second call is free', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ id: 'gpt-4o' }] }),
    });
    await getAvailableModels('openai', 'sk-cache-after-fetch');
    await getAvailableModels('openai', 'sk-cache-after-fetch'); // second call
    expect(mockFetch).toHaveBeenCalledOnce(); // still only one fetch
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd /home/arianeguay/dev/src/Studio
pnpm --filter @studio-foundation/cli test -- --reporter=verbose 2>&1 | head -30
```

Expected: FAIL — `models-cache.ts` does not exist yet.

**Step 3: Implement `models-cache.ts`**

```typescript
// cli/src/models-cache.ts

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

interface RawModel {
  id: string;
  created?: number;
  created_at?: string;
}

interface CacheEntry {
  models: string[];
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(provider: string, apiKey: string): string {
  return `${provider}:${apiKey.slice(0, 8)}`;
}

export function setCachedModels(provider: string, apiKey: string, models: string[]): void {
  cache.set(cacheKey(provider, apiKey), { models, fetchedAt: Date.now() });
}

export function getCachedModels(provider: string, apiKey: string): string[] | null {
  const key = cacheKey(provider, apiKey);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.models;
}

export function filterModels(provider: string, models: RawModel[]): string[] {
  if (provider === 'anthropic') {
    return models
      .filter(
        (m) =>
          m.id.startsWith('claude-') &&
          !m.id.startsWith('claude-instant') &&
          !m.id.startsWith('claude-2')
      )
      .map((m) => m.id);
  }
  if (provider === 'openai') {
    return models
      .filter(
        (m) =>
          m.id.startsWith('gpt-4') ||
          m.id.startsWith('o1') ||
          m.id.startsWith('o3')
      )
      .map((m) => m.id);
  }
  return models.map((m) => m.id);
}

export function sortModels(modelIds: string[], rawModels: RawModel[]): string[] {
  const tsMap = new Map<string, number>();
  for (const m of rawModels) {
    if (m.created !== undefined) {
      tsMap.set(m.id, m.created);
    } else if (m.created_at) {
      tsMap.set(m.id, new Date(m.created_at).getTime());
    }
  }
  return [...modelIds].sort((a, b) => {
    const ta = tsMap.get(a) ?? 0;
    const tb = tsMap.get(b) ?? 0;
    if (ta !== tb) return tb - ta;
    return b.localeCompare(a);
  });
}

export function parseAndCacheModels(provider: string, apiKey: string, json: unknown): void {
  try {
    const data = ((json as Record<string, unknown>).data ?? []) as RawModel[];
    const filtered = filterModels(provider, data);
    const sorted = sortModels(filtered, data);
    setCachedModels(provider, apiKey, sorted);
  } catch {
    // ignore malformed responses
  }
}

const SUPPORTED_PROVIDERS = new Set(['anthropic', 'openai']);

async function fetchModelsFromProvider(provider: string, apiKey: string): Promise<string[]> {
  if (!SUPPORTED_PROVIDERS.has(provider)) return [];

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 5000);

  try {
    let url: string;
    let headers: Record<string, string>;

    if (provider === 'anthropic') {
      url = 'https://api.anthropic.com/v1/models';
      headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
    } else {
      url = 'https://api.openai.com/v1/models';
      headers = { Authorization: `Bearer ${apiKey}` };
    }

    const res = await fetch(url, { signal: abort.signal, headers });
    if (!res.ok) return [];

    const json = await res.json();
    const data = ((json as Record<string, unknown>).data ?? []) as RawModel[];
    const filtered = filterModels(provider, data);
    const sorted = sortModels(filtered, data);
    setCachedModels(provider, apiKey, sorted);
    return sorted;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function getAvailableModels(provider: string, apiKey: string): Promise<string[]> {
  const cached = getCachedModels(provider, apiKey);
  if (cached !== null) return cached;
  return fetchModelsFromProvider(provider, apiKey);
}
```

**Step 4: Run tests to verify they pass**

```bash
pnpm --filter @studio-foundation/cli test -- --reporter=verbose 2>&1 | grep -E "(PASS|FAIL|models-cache)"
```

Expected: All `models-cache` tests PASS.

**Step 5: Commit**

```bash
git add cli/src/models-cache.ts cli/tests/models-cache.test.ts
git commit -m "feat(cli): STU-49 — add models-cache with filtering, sorting, TTL"
```

---

### Task 2: Create `provider-validator.ts` — validates key + silently populates cache

**Files:**
- Create: `cli/src/provider-validator.ts`
- Create: `cli/tests/provider-validator.test.ts`

**Step 1: Write the failing tests**

```typescript
// cli/tests/provider-validator.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateApiKeyLive } from '../../src/provider-validator.js';
import { getCachedModels } from '../../src/models-cache.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => { mockFetch.mockReset(); });

function mockResponse(status: number, body?: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body ?? {},
  } as Response;
}

// ─── Anthropic ───────────────────────────────────────────────────────────────

describe('validateApiKeyLive — anthropic', () => {
  it('returns valid when /v1/models returns 200', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, { data: [] }));
    const result = await validateApiKeyLive('anthropic', 'sk-ant-valid-key');
    expect(result.status).toBe('valid');
  });

  it('calls GET https://api.anthropic.com/v1/models with x-api-key header', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, { data: [] }));
    await validateApiKeyLive('anthropic', 'sk-ant-mykey');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/models');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-ant-mykey');
  });

  it('populates models cache on 200', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(200, {
        data: [
          { id: 'claude-sonnet-4-20250514' },
          { id: 'claude-instant-1' }, // excluded by filter
        ],
      })
    );
    await validateApiKeyLive('anthropic', 'sk-ant-cache-pop');
    const cached = getCachedModels('anthropic', 'sk-ant-cache-pop');
    expect(cached).toContain('claude-sonnet-4-20250514');
    expect(cached).not.toContain('claude-instant-1');
  });

  it('returns invalid with error message when 401', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(401));
    const result = await validateApiKeyLive('anthropic', 'sk-ant-bad');
    expect(result.status).toBe('invalid');
    expect('error' in result && result.error).toContain('401');
  });

  it('returns invalid when 403', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(403));
    const result = await validateApiKeyLive('anthropic', 'sk-ant-bad');
    expect(result.status).toBe('invalid');
  });

  it('returns warning on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await validateApiKeyLive('anthropic', 'sk-ant-key');
    expect(result.status).toBe('warning');
    expect('message' in result && result.message).toMatch(/Could not validate/i);
  });

  it('returns warning on abort (timeout)', async () => {
    const err = Object.assign(new Error('abort'), { name: 'AbortError' });
    mockFetch.mockRejectedValueOnce(err);
    const result = await validateApiKeyLive('anthropic', 'sk-ant-key');
    expect(result.status).toBe('warning');
    expect('message' in result && result.message).toMatch(/timed out/i);
  });
});

// ─── OpenAI ──────────────────────────────────────────────────────────────────

describe('validateApiKeyLive — openai', () => {
  it('returns valid when /v1/models returns 200', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, { data: [] }));
    const result = await validateApiKeyLive('openai', 'sk-proj-valid');
    expect(result.status).toBe('valid');
  });

  it('calls GET https://api.openai.com/v1/models with Authorization Bearer header', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, { data: [] }));
    await validateApiKeyLive('openai', 'sk-proj-mykey');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/models');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-proj-mykey');
  });

  it('populates models cache on 200', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(200, { data: [{ id: 'gpt-4o' }, { id: 'gpt-3.5-turbo' }] })
    );
    await validateApiKeyLive('openai', 'sk-openai-cache');
    const cached = getCachedModels('openai', 'sk-openai-cache');
    expect(cached).toContain('gpt-4o');
    expect(cached).not.toContain('gpt-3.5-turbo');
  });

  it('returns invalid when 401', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(401));
    const result = await validateApiKeyLive('openai', 'sk-bad');
    expect(result.status).toBe('invalid');
    expect('error' in result && result.error).toContain('401');
  });
});

// ─── Google ──────────────────────────────────────────────────────────────────

describe('validateApiKeyLive — google', () => {
  it('returns valid when models endpoint returns 200', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200));
    const result = await validateApiKeyLive('google', 'AIzaValid');
    expect(result.status).toBe('valid');
  });

  it('includes API key as query param in URL', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200));
    await validateApiKeyLive('google', 'AIzaMyKey');
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('AIzaMyKey');
    expect(url).toContain('generativelanguage.googleapis.com');
  });

  it('does NOT populate models cache (Google not supported)', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200));
    await validateApiKeyLive('google', 'AIzaCache');
    expect(getCachedModels('google', 'AIzaCache')).toBeNull();
  });

  it('returns invalid when 400 or 403', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(400));
    const result = await validateApiKeyLive('google', 'AIzaBad');
    expect(result.status).toBe('invalid');
  });
});

// ─── Local ───────────────────────────────────────────────────────────────────

describe('validateApiKeyLive — local', () => {
  it('returns valid when Ollama /api/tags returns 200', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200));
    const result = await validateApiKeyLive('local', '', { baseUrl: 'http://localhost:11434' });
    expect(result.status).toBe('valid');
  });

  it('uses default http://localhost:11434 when no baseUrl', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200));
    await validateApiKeyLive('local', '');
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('localhost:11434');
  });

  it('uses custom baseUrl when provided', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200));
    await validateApiKeyLive('local', '', { baseUrl: 'http://my-ollama:8080' });
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('my-ollama:8080');
  });

  it('returns warning on connection refused', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await validateApiKeyLive('local', '', { baseUrl: 'http://localhost:11434' });
    expect(result.status).toBe('warning');
  });
});

// ─── Unknown provider ────────────────────────────────────────────────────────

describe('validateApiKeyLive — unknown provider', () => {
  it('returns warning for unrecognized providers', async () => {
    const result = await validateApiKeyLive('future-provider', 'some-key');
    expect(result.status).toBe('warning');
    expect('message' in result && result.message).toMatch(/cannot validate/i);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
pnpm --filter @studio-foundation/cli test -- --reporter=verbose 2>&1 | head -20
```

Expected: FAIL — `provider-validator.ts` does not exist yet.

**Step 3: Implement `provider-validator.ts`**

```typescript
// cli/src/provider-validator.ts
import { parseAndCacheModels } from './models-cache.js';

export type ValidationResult =
  | { status: 'valid' }
  | { status: 'invalid'; error: string }
  | { status: 'warning'; message: string };

export interface ValidateOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

export async function validateApiKeyLive(
  provider: string,
  apiKey: string,
  options: ValidateOptions = {}
): Promise<ValidationResult> {
  const abort = new AbortController();
  const timer = setTimeout(
    () => abort.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );

  try {
    if (provider === 'anthropic') {
      return await validateAnthropicKey(apiKey, abort.signal);
    } else if (provider === 'openai') {
      return await validateOpenAIKey(apiKey, abort.signal);
    } else if (provider === 'google') {
      return await validateGoogleKey(apiKey, abort.signal);
    } else if (provider === 'local') {
      return await validateLocalOllama(
        options.baseUrl ?? 'http://localhost:11434',
        abort.signal
      );
    } else {
      return { status: 'warning', message: `Cannot validate unknown provider '${provider}'` };
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { status: 'warning', message: 'Validation timed out — proceeding anyway' };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'warning', message: `Could not validate key: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}

async function validateAnthropicKey(
  apiKey: string,
  signal: AbortSignal
): Promise<ValidationResult> {
  const res = await fetch('https://api.anthropic.com/v1/models', {
    signal,
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
  });
  if (res.status === 200) {
    try { parseAndCacheModels('anthropic', apiKey, await res.json()); } catch { /* ignore */ }
    return { status: 'valid' };
  }
  if (res.status === 401 || res.status === 403) {
    return { status: 'invalid', error: `Invalid key (${res.status} Unauthorized)` };
  }
  return { status: 'warning', message: `Unexpected response ${res.status} — proceeding anyway` };
}

async function validateOpenAIKey(
  apiKey: string,
  signal: AbortSignal
): Promise<ValidationResult> {
  const res = await fetch('https://api.openai.com/v1/models', {
    signal,
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (res.status === 200) {
    try { parseAndCacheModels('openai', apiKey, await res.json()); } catch { /* ignore */ }
    return { status: 'valid' };
  }
  if (res.status === 401 || res.status === 403) {
    return { status: 'invalid', error: `Invalid key (${res.status} Unauthorized)` };
  }
  return { status: 'warning', message: `Unexpected response ${res.status} — proceeding anyway` };
}

async function validateGoogleKey(
  apiKey: string,
  signal: AbortSignal
): Promise<ValidationResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, { signal });
  if (res.status === 200) return { status: 'valid' };
  if (res.status === 400 || res.status === 403) {
    return { status: 'invalid', error: `Invalid key (${res.status})` };
  }
  return { status: 'warning', message: `Unexpected response ${res.status} — proceeding anyway` };
}

async function validateLocalOllama(
  baseUrl: string,
  signal: AbortSignal
): Promise<ValidationResult> {
  const url = baseUrl.replace(/\/$/, '') + '/api/tags';
  const res = await fetch(url, { signal });
  if (res.status === 200) return { status: 'valid' };
  return { status: 'warning', message: `Ollama returned ${res.status} — proceeding anyway` };
}
```

**Step 4: Run tests to verify they pass**

```bash
pnpm --filter @studio-foundation/cli test -- --reporter=verbose 2>&1 | grep -E "(PASS|FAIL|provider-validator|models-cache)"
```

Expected: All tests PASS.

**Step 5: Commit**

```bash
git add cli/src/provider-validator.ts cli/tests/provider-validator.test.ts
git commit -m "feat(cli): STU-49 — add validateApiKeyLive, silently populates models cache"
```

---

### Task 3: Integrate into `config add-provider` — validation + model select

**Files:**
- Modify: `cli/src/commands/config.ts`

**Context:** Two paths in `configCommand`:
1. **Wizard** (`configAddProviderWizard`): add re-prompt loop after key input, then model select when setting as default
2. **Direct mode** (`add-provider` case): fail-fast live validation after format check

**Step 1: Add imports to `config.ts`**

At the top of `cli/src/commands/config.ts`, add:

```typescript
import ora from 'ora';
import { validateApiKeyLive } from '../provider-validator.js';
import { getAvailableModels } from '../models-cache.js';
```

**Step 2: Replace Step 3 in `configAddProviderWizard` with a re-prompt loop**

Find (around line 155):
```typescript
  // Step 3: Ask for API key (or base URL for local)
  let apiKey = '';
  if (providerId === 'local') {
    apiKey = await input({
      message: 'Ollama base URL:',
      default: 'http://localhost:11434',
    });
  } else {
    const providerLabel = PROVIDERS.find((p) => p.id === providerId)?.label ?? providerId;
    apiKey = await password({
      message: `${providerLabel} API Key:`,
      validate: (value: string) => validateApiKeyForProvider(providerId, value),
    });
  }
```

Replace with:
```typescript
  // Step 3: Ask for API key (or base URL for local)
  let apiKey = '';
  if (providerId === 'local') {
    apiKey = await input({
      message: 'Ollama base URL:',
      default: 'http://localhost:11434',
    });
    const spinner = ora('Validating connection...').start();
    const result = await validateApiKeyLive('local', '', { baseUrl: apiKey });
    if (result.status === 'valid') spinner.succeed('Connected');
    else if (result.status === 'warning') spinner.warn(result.message);
    else spinner.fail(result.error);
  } else {
    const providerLabel = PROVIDERS.find((p) => p.id === providerId)?.label ?? providerId;
    while (true) {
      apiKey = await password({
        message: `${providerLabel} API Key:`,
        validate: (value: string) => validateApiKeyForProvider(providerId, value),
      });
      const spinner = ora('Validating...').start();
      const result = await validateApiKeyLive(providerId, apiKey);
      spinner.stop();
      if (result.status === 'valid') {
        console.log(chalk.green('  ✓ Valid'));
        break;
      } else if (result.status === 'warning') {
        console.log(chalk.yellow(`  ⚠ ${result.message}`));
        break;
      } else {
        console.log(chalk.red(`  ✗ ${result.error}`));
        console.log(chalk.gray('  Please try again.'));
      }
    }
  }
```

**Step 3: Add model select step in `configAddProviderWizard` (between Step 4 and Step 5)**

Find the section starting with `// Step 4: Set as default?` and ending with `// Step 5: Write config`. Insert a model selection step between them.

After the `setDefault` variable is determined, add:

```typescript
  // Step 4b: Choose default model (if setting as default and models are available)
  let defaultModel: string | undefined;
  if (setDefault && providerId !== 'local') {
    const models = await getAvailableModels(providerId, apiKey);
    const meta = PROVIDERS.find((p) => p.id === providerId);
    const fallbackModel = meta?.defaultModel ?? 'claude-sonnet-4-20250514';

    if (models.length > 0) {
      const choices = [
        ...models.map((m) => ({ value: m, name: m })),
        { value: '__custom__', name: 'Enter custom model ID' },
      ];
      const selected = await select<string>({
        message: 'Default model:',
        choices,
        default: models.includes(fallbackModel) ? fallbackModel : models[0],
      });
      if (selected === '__custom__') {
        defaultModel = await input({ message: 'Model ID:', default: fallbackModel });
      } else {
        defaultModel = selected;
      }
    } else {
      defaultModel = await input({ message: 'Default model:', default: fallbackModel });
    }
  }
```

Then update the call to `addProviderConfig` to pass the custom model. Currently:
```typescript
  await addProviderConfig(configFile, providerId, apiKey, setDefault);
```

Change `addProviderConfig` signature to accept optional model, or set the model separately. The simplest approach: after `addProviderConfig`, if `defaultModel` is set, read the config and update `defaults.model`.

Actually, simpler: update `addProviderConfig` to accept an optional `model` parameter:

In `addProviderConfig` (around line 44):
```typescript
export async function addProviderConfig(
  configFile: string,
  provider: string,
  apiKey: string,
  setDefault: boolean,
  model?: string  // new optional param
): Promise<void> {
  // ...
  if (setDefault) {
    const meta = PROVIDERS.find((p) => p.id === provider);
    config.defaults = {
      provider,
      model: model ?? meta?.defaultModel ?? 'claude-sonnet-4-20250514',
    };
  }
```

Then in the wizard call:
```typescript
  await addProviderConfig(configFile, providerId, apiKey, setDefault, defaultModel);
```

**Step 4: Add live validation in direct mode**

In the `add-provider` direct mode case, after the format validation block (around line 272), add:

```typescript
        if (provider !== 'local') {
          const validation = validateApiKeyForProvider(provider, apiKey);
          if (validation !== true) {
            console.error(`Error: ${validation}`);
            process.exit(1);
          }
          process.stdout.write('Validating...');
          const result = await validateApiKeyLive(provider, apiKey);
          if (result.status === 'valid') {
            console.log(chalk.green(' ✓ Valid'));
          } else if (result.status === 'warning') {
            console.log(chalk.yellow(` ⚠ ${result.message}`));
          } else {
            console.error(chalk.red(` ✗ ${result.error}`));
            process.exit(1);
          }
        } else {
          process.stdout.write('Validating connection...');
          const result = await validateApiKeyLive('local', '', {
            baseUrl: apiKey || 'http://localhost:11434',
          });
          const msg = 'message' in result ? result.message : result.status === 'valid' ? 'Connected' : '';
          if (result.status === 'valid') {
            console.log(chalk.green(' ✓ Connected'));
          } else {
            console.log(chalk.yellow(` ⚠ ${msg}`));
          }
        }
```

**Step 5: Build**

```bash
cd /home/arianeguay/dev/src/Studio
pnpm build 2>&1 | tail -15
```

Expected: No TypeScript errors.

**Step 6: Run all CLI tests**

```bash
pnpm --filter @studio-foundation/cli test 2>&1 | tail -20
```

Expected: All tests pass.

**Step 7: Commit**

```bash
git add cli/src/commands/config.ts
git commit -m "feat(cli): STU-49 — live validation + model select in config add-provider"
```

---

### Task 4: Integrate into `studio init` — validation + model select

**Files:**
- Modify: `cli/src/commands/init.ts`

**Step 1: Add imports to `init.ts`**

```typescript
import { validateApiKeyLive } from '../provider-validator.js';
import { getAvailableModels } from '../models-cache.js';
```

**Step 2: Replace Step 5 (API key) in wizard with a re-prompt loop**

Find (around line 314):
```typescript
    // Step 5: API Key
    let apiKey: string | undefined;
    if (provider !== 'later') {
      const providerLabel = provider === 'anthropic' ? 'Anthropic' : 'OpenAI';
      apiKey = await password({
        message: `${providerLabel} API Key:`,
        validate: (value: string) => validateApiKeyFormat(provider, value),
      });
    }
```

Replace with:
```typescript
    // Step 5: API Key
    let apiKey: string | undefined;
    if (provider !== 'later') {
      const providerLabel = provider === 'anthropic' ? 'Anthropic' : 'OpenAI';
      while (true) {
        apiKey = await password({
          message: `${providerLabel} API Key:`,
          validate: (value: string) => validateApiKeyFormat(provider, value),
        });
        const spinner = ora('Validating...').start();
        const result = await validateApiKeyLive(provider, apiKey);
        spinner.stop();
        if (result.status === 'valid') {
          console.log(chalk.green('  ✓ Valid'));
          break;
        } else if (result.status === 'warning') {
          console.log(chalk.yellow(`  ⚠ ${result.message}`));
          break;
        } else {
          console.log(chalk.red(`  ✗ ${result.error}`));
          console.log(chalk.gray('  Please try again.'));
        }
      }
    }
```

**Step 3: Add model select step after API key (before Step 6 "Create structure")**

After the API key section and before `// Step 6: Create structure`, add:

```typescript
    // Step 5b: Choose default model
    let selectedModel: string | undefined;
    if (provider !== 'later' && apiKey) {
      const models = await getAvailableModels(provider, apiKey);
      const DEFAULT_MODELS: Record<string, string> = {
        anthropic: 'claude-sonnet-4-20250514',
        openai: 'gpt-4o',
      };
      const fallback = DEFAULT_MODELS[provider] ?? 'claude-sonnet-4-20250514';

      if (models.length > 0) {
        const choices = [
          ...models.map((m) => ({ value: m, name: m })),
          { value: '__custom__', name: 'Enter custom model ID' },
        ];
        const chosen = await select<string>({
          message: 'Default model:',
          choices,
          default: models.includes(fallback) ? fallback : models[0],
        });
        if (chosen === '__custom__') {
          selectedModel = await input({ message: 'Model ID:', default: fallback });
        } else {
          selectedModel = chosen;
        }
      } else {
        selectedModel = await input({ message: 'Default model:', default: fallback });
      }
    }
```

Then update `writeProviderToConfig` call to use `selectedModel`. Currently:
```typescript
      await writeProviderToConfig(studioDir, provider, apiKey);
```

Update `writeProviderToConfig` signature to accept optional model:

```typescript
export async function writeProviderToConfig(
  studioDir: string,
  provider: string,
  apiKey: string,
  model?: string  // new optional param
): Promise<void> {
  // ...
  parsed.defaults = {
    provider,
    model: model ?? DEFAULT_MODELS[provider] ?? 'claude-sonnet-4-20250514',
  };
```

Call it with the selected model:
```typescript
      await writeProviderToConfig(studioDir, provider, apiKey, selectedModel);
```

**Step 4: Add live validation in direct mode**

In `initCommand` direct mode block, after the `validateApiKeyFormat` check (around line 230), add:

```typescript
      if (options.provider !== 'later' && options.apiKey) {
        const validation = validateApiKeyFormat(options.provider!, options.apiKey);
        if (validation !== true) {
          console.error(`Error: ${validation}`);
          process.exit(1);
        }
        process.stdout.write('Validating API key...');
        const result = await validateApiKeyLive(options.provider!, options.apiKey);
        if (result.status === 'valid') {
          console.log(chalk.green(' ✓'));
        } else if (result.status === 'warning') {
          console.log(chalk.yellow(` ⚠ ${result.message}`));
        } else {
          console.error(chalk.red(` ✗ ${result.error}`));
          process.exit(1);
        }
      }
```

**Step 5: Build**

```bash
pnpm build 2>&1 | tail -15
```

Expected: No TypeScript errors.

**Step 6: Run all CLI tests**

```bash
pnpm --filter @studio-foundation/cli test 2>&1 | tail -20
```

Expected: All tests pass.

**Step 7: Commit**

```bash
git add cli/src/commands/init.ts
git commit -m "feat(cli): STU-49 — live validation + model select in studio init"
```

---

### Task 5: Interactive `studio config set defaults.model`

**Files:**
- Modify: `cli/src/commands/config.ts`

**Context:** When the user runs `studio config set defaults.model` without a value, trigger an interactive model selection backed by `getAvailableModels`.

**Step 1: Add the special case in the `set` handler**

In `configCommand` `set` case, after the provider convenience block (around line 238), add a special case before the generic path/value handling:

```typescript
      // Special case: interactive model selection when no value provided
      if (path === 'defaults.model' && value === undefined) {
        const rawConfig = await loadRawConfig(configFile);
        const defaults = rawConfig.defaults as { provider?: string; model?: string } | undefined;
        const provider = defaults?.provider;
        const providerConfig =
          provider && rawConfig.providers
            ? (rawConfig.providers as Record<string, { apiKey: string }>)[provider]
            : undefined;
        const apiKey = providerConfig?.apiKey ?? '';

        if (!provider) {
          console.error('Error: no default provider configured. Run studio config add-provider first.');
          process.exit(1);
        }

        const spinner = ora(`Fetching models for ${provider}...`).start();
        const models = await getAvailableModels(provider, apiKey);
        spinner.stop();

        if (models.length === 0) {
          console.error(
            `Error: could not fetch models for provider '${provider}'. ` +
            `Provide the model ID directly: studio config set defaults.model <model-id>`
          );
          process.exit(1);
        }

        const selectedModel = await select<string>({
          message: 'Default model:',
          choices: models.map((m) => ({ value: m, name: m })),
          default: defaults?.model && models.includes(defaults.model) ? defaults.model : models[0],
        });

        setConfigValue(rawConfig, 'defaults.model', selectedModel);
        await saveConfig(configFile, rawConfig);
        console.log(chalk.green(`✓ Set defaults.model = ${selectedModel}`));
        break;
      }
```

**Step 2: Build**

```bash
pnpm build 2>&1 | tail -10
```

Expected: No errors.

**Step 3: Run all CLI tests**

```bash
pnpm --filter @studio-foundation/cli test 2>&1 | tail -20
```

Expected: All tests pass.

**Step 4: Commit**

```bash
git add cli/src/commands/config.ts
git commit -m "feat(cli): STU-49 — interactive model select for studio config set defaults.model"
```

---

### Task 6: Final verification

**Step 1: Full monorepo build**

```bash
cd /home/arianeguay/dev/src/Studio
pnpm build 2>&1 | tail -10
```

Expected: Zero errors.

**Step 2: Full test suite**

```bash
pnpm test 2>&1 | tail -30
```

Expected: All packages pass.

**Step 3: Smoke test the validator module**

```bash
node --input-type=module <<'EOF'
import { validateApiKeyLive } from './cli/dist/provider-validator.js';
import { getCachedModels } from './cli/dist/models-cache.js';

// This key is fake — expect 'invalid' (401) or 'warning' (network timeout)
const result = await validateApiKeyLive('anthropic', 'sk-ant-obviously-fake-key');
console.log('Validation result:', JSON.stringify(result));

const cached = getCachedModels('anthropic', 'sk-ant-obviously-fake-key');
console.log('Cached models:', cached);
EOF
```

Expected: `{ status: 'invalid', error: '...' }` (if network reachable) or `{ status: 'warning', ... }`.

**Step 4: Final commit if any fixes needed**

```bash
git log --oneline -6
```

---

## Summary

| Task | New files | Modified files |
|------|-----------|----------------|
| 1 | `cli/src/models-cache.ts`, `cli/tests/models-cache.test.ts` | — |
| 2 | `cli/src/provider-validator.ts`, `cli/tests/provider-validator.test.ts` | — |
| 3 | — | `cli/src/commands/config.ts` |
| 4 | — | `cli/src/commands/init.ts` |
| 5 | — | `cli/src/commands/config.ts` |
| 6 | — | — (verification only) |

**Key invariants:**
- `validateApiKeyLive` never throws — always returns `ValidationResult`
- `getAvailableModels` never throws — returns `[]` on any error
- `parseAndCacheModels` never throws — silently ignores malformed responses
- Public API of `validateApiKeyLive` is unchanged — still returns `{ status, error?, message? }`
- Google and Local providers: validation works, no model cache entry created
