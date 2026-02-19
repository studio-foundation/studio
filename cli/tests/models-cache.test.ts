import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  setCachedModels,
  getCachedModels,
  parseAndCacheModels,
  getAvailableModels,
  filterModels,
  sortModels,
} from '../src/models-cache.js';

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
