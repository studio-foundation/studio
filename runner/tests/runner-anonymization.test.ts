import { describe, it, expect } from 'vitest';
import { runAgent } from '../src/runner.js';
import type { Provider } from '../src/providers/provider.js';
import type { LLMRequest, LLMResponse } from '@studio-foundation/contracts';
import { ProviderRegistry } from '../src/providers/registry.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { AnonymizationMiddleware } from '../src/middleware/anonymization.js';

class MockProvider implements Provider {
  readonly name = 'mock';
  capturedRequests: LLMRequest[] = [];
  private response: string;

  constructor(response: string) { this.response = response; }

  async call(req: LLMRequest): Promise<LLMResponse> {
    this.capturedRequests.push(req);
    return {
      content: this.response,
      tool_calls: [],
      finish_reason: 'stop',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
  }
}

describe('runAgent with anonymization', () => {
  it('anonymizes task description before LLM sees it', async () => {
    const provider = new MockProvider('{"result": "done"}');
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(provider);
    const middleware = new AnonymizationMiddleware();

    await runAgent({
      agent: { name: 'test', provider: 'mock', model: 'x' },
      task: { description: 'Process mc@acme.com data' },
      context: {},
      toolRegistry: new ToolRegistry(),
      providerRegistry,
      anonymizationMiddleware: middleware,
    });

    const messages = provider.capturedRequests[0].messages;
    const fullText = messages.map(m => m.content).join(' ');
    expect(fullText).not.toContain('mc@acme.com');
    expect(fullText).toContain('EMAIL_1');
  });

  it('deanonymizes LLM output so caller gets real values', async () => {
    // Middleware already has EMAIL_1 = mc@acme.com in its keymap
    const middleware = new AnonymizationMiddleware();
    middleware.anonymize('mc@acme.com'); // seeds keymap: EMAIL_1 → mc@acme.com

    const provider = new MockProvider('{"email": "EMAIL_1"}');
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(provider);

    const result = await runAgent({
      agent: { name: 'test', provider: 'mock', model: 'x' },
      task: { description: 'Test' },
      context: {},
      toolRegistry: new ToolRegistry(),
      providerRegistry,
      anonymizationMiddleware: middleware,
    });

    const output = result.output as { email: string };
    expect(output.email).toBe('mc@acme.com');
  });

  it('works identically when no middleware provided (regression)', async () => {
    const provider = new MockProvider('{"result": "ok"}');
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(provider);

    const result = await runAgent({
      agent: { name: 'test', provider: 'mock', model: 'x' },
      task: { description: 'Normal task mc@acme.com' },
      context: {},
      toolRegistry: new ToolRegistry(),
      providerRegistry,
      // No anonymizationMiddleware
    });

    expect(result.output).toEqual({ result: 'ok' });
    const fullText = provider.capturedRequests[0].messages.map(m => m.content).join(' ');
    expect(fullText).toContain('mc@acme.com');
  });
});
