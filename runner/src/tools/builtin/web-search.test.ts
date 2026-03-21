/**
 * Tests for the web_search builtin tool
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createWebSearchTools, WEB_SEARCH_PROMPT_SNIPPET } from './web-search.js';

describe('createWebSearchTools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.TAVILY_API_KEY;
  });

  it('returns a single tool named web_search-search', () => {
    const tools = createWebSearchTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('web_search-search');
  });

  it('requires query parameter', () => {
    const [tool] = createWebSearchTools();
    const schema = tool.parameters as { required: string[] };
    expect(schema.required).toContain('query');
  });

  it('returns error when TAVILY_API_KEY is not set', async () => {
    const [tool] = createWebSearchTools();
    const result = await tool.execute({ query: 'test' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/TAVILY_API_KEY/);
  });

  it('calls Tavily API and returns results', async () => {
    process.env.TAVILY_API_KEY = 'test-key';
    const mockResponse = {
      results: [
        { title: 'Result 1', url: 'https://example.com/1', content: 'Content 1', score: 0.9 },
        { title: 'Result 2', url: 'https://example.com/2', content: 'Content 2', score: 0.8 },
      ],
      answer: 'A direct answer'
    };

    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockResponse), { status: 200 })
    );

    const [tool] = createWebSearchTools();
    const result = await tool.execute({ query: 'test query', max_results: 2 });

    expect(result.success).toBe(true);
    const output = result.output as {
      query: string;
      results: Array<{ title: string; url: string }>;
      answer: string;
      count: number;
    };
    expect(output.query).toBe('test query');
    expect(output.results).toHaveLength(2);
    expect(output.results[0].title).toBe('Result 1');
    expect(output.answer).toBe('A direct answer');
    expect(output.count).toBe(2);
  });

  it('passes max_results to Tavily API', async () => {
    process.env.TAVILY_API_KEY = 'test-key';
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [], answer: null }), { status: 200 })
    );

    const [tool] = createWebSearchTools();
    await tool.execute({ query: 'test', max_results: 3 });

    const [, options] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.max_results).toBe(3);
  });

  it('defaults max_results to 5 when not provided', async () => {
    process.env.TAVILY_API_KEY = 'test-key';
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [] }), { status: 200 })
    );

    const [tool] = createWebSearchTools();
    await tool.execute({ query: 'test' });

    const [, options] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.max_results).toBe(5);
  });

  it('returns error on non-ok API response', async () => {
    process.env.TAVILY_API_KEY = 'test-key';
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401 })
    );

    const [tool] = createWebSearchTools();
    const result = await tool.execute({ query: 'test' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/401/);
  });

  it('returns error on network failure', async () => {
    process.env.TAVILY_API_KEY = 'test-key';
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('Network error'));

    const [tool] = createWebSearchTools();
    const result = await tool.execute({ query: 'test' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Network error/);
  });
});

describe('WEB_SEARCH_PROMPT_SNIPPET', () => {
  it('is a non-empty string', () => {
    expect(typeof WEB_SEARCH_PROMPT_SNIPPET).toBe('string');
    expect(WEB_SEARCH_PROMPT_SNIPPET.length).toBeGreaterThan(0);
  });
});
