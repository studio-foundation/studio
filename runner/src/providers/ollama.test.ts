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

  it('streaming: usage is undefined (Ollama does not return usage in streaming)', async () => {
    async function* fakeStream() {
      yield { choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] };
    }
    createMock.mockReturnValueOnce(fakeStream());

    const provider = new OllamaProvider();
    const result = await provider.call(
      { model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }] },
      () => {},
    );

    expect(result.usage).toBeUndefined();
  });

  it('aborts streaming when signal fires mid-iteration', async () => {
    async function* slowStream() {
      await new Promise((r) => setTimeout(r, 20));
      yield { choices: [{ delta: { content: 'hello' }, finish_reason: null }] };
      await new Promise((r) => setTimeout(r, 20));
      yield { choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }] };
    }
    createMock.mockReturnValueOnce(slowStream());

    const provider = new OllamaProvider();
    const controller = new AbortController();

    const callPromise = provider.call(
      { model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }] },
      () => {},
      controller.signal,
    );

    setTimeout(() => controller.abort(), 10);

    await expect(callPromise).rejects.toSatisfy(
      (e: unknown) => e instanceof DOMException && (e as DOMException).name === 'AbortError',
    );
  });
});
