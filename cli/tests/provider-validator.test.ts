import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { validateApiKeyLive } from '../src/provider-validator.js';
import { getCachedModels } from '../src/models-cache.js';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
const mockSpawnSync = vi.mocked(spawnSync);

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => { mockFetch.mockReset(); mockSpawnSync.mockReset(); });

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

// ─── Ollama ──────────────────────────────────────────────────────────────────

describe('validateApiKeyLive — ollama', () => {
  it('returns valid when Ollama /api/tags returns 200', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200));
    const result = await validateApiKeyLive('ollama', '', { baseUrl: 'http://localhost:11434' });
    expect(result.status).toBe('valid');
  });

  it('uses default http://localhost:11434 when no baseUrl', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200));
    await validateApiKeyLive('ollama', '');
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('localhost:11434');
  });

  it('uses custom baseUrl when provided', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200));
    await validateApiKeyLive('ollama', '', { baseUrl: 'http://my-ollama:8080' });
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('my-ollama:8080');
  });

  it('returns warning on connection refused', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await validateApiKeyLive('ollama', '', { baseUrl: 'http://localhost:11434' });
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

// ─── Claude Code ─────────────────────────────────────────────────────────────

describe('validateApiKeyLive — claude-code', () => {
  it('returns invalid when claude binary is not found', async () => {
    mockSpawnSync.mockReturnValueOnce({ status: 1, stdout: Buffer.from(''), stderr: Buffer.from(''), error: undefined } as never);
    const result = await validateApiKeyLive('claude-code', '');
    expect(result.status).toBe('invalid');
    expect('error' in result && result.error).toMatch(/claude CLI not found/i);
  });

  it('returns valid when claude -p responds with exit 0', async () => {
    mockSpawnSync
      .mockReturnValueOnce({ status: 0, stdout: Buffer.from('/usr/local/bin/claude'), stderr: Buffer.from(''), error: undefined } as never)
      .mockReturnValueOnce({ status: 0, stdout: Buffer.from('OK'), stderr: Buffer.from(''), error: undefined } as never);
    const result = await validateApiKeyLive('claude-code', '');
    expect(result.status).toBe('valid');
  });

  it('returns invalid when claude -p exits non-zero (session inactive)', async () => {
    mockSpawnSync
      .mockReturnValueOnce({ status: 0, stdout: Buffer.from('/usr/local/bin/claude'), stderr: Buffer.from(''), error: undefined } as never)
      .mockReturnValueOnce({ status: 1, stdout: Buffer.from(''), stderr: Buffer.from('not logged in'), error: undefined } as never);
    const result = await validateApiKeyLive('claude-code', '');
    expect(result.status).toBe('invalid');
    expect('error' in result && result.error).toMatch(/session inactive/i);
  });
});
