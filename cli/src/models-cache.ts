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
