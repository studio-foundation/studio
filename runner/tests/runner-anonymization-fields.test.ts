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
    return { content: this.response, tool_calls: [], finish_reason: 'stop',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
  }
}

function registryWith(provider: Provider): ProviderRegistry {
  const r = new ProviderRegistry();
  r.register(provider);
  return r;
}

describe('runAgent with structured-field anonymization', () => {
  it('anonymizes fields before prompt assembly; the prompt holds only tokens', async () => {
    const provider = new MockProvider('{"result":"ok"}');
    await runAgent({
      agent: { name: 'test', provider: 'mock', model: 'x' },
      task: {
        description: '',
        fields: { from: 'mc@acme.com', body: 'Reply to mc@acme.com please' },
      },
      context: {},
      toolRegistry: new ToolRegistry(),
      providerRegistry: registryWith(provider),
      anonymizationMiddleware: new AnonymizationMiddleware(),
    });

    const promptText = provider.capturedRequests[0].messages.map(m => m.content).join(' ');
    // Real PII never reaches the prompt
    expect(promptText).not.toContain('mc@acme.com');
    // Shared keymap: same email in both fields → single token, no EMAIL_2
    expect(promptText).toContain('EMAIL_1');
    expect(promptText).not.toContain('EMAIL_2');
  });

  it('deanonymizes the LLM output back to real field values', async () => {
    // LLM echoes the token it saw; runner must restore the real email
    const provider = new MockProvider('{"normalized":"EMAIL_1"}');
    const result = await runAgent({
      agent: { name: 'test', provider: 'mock', model: 'x' },
      task: { description: '', fields: { from: 'mc@acme.com' } },
      context: {},
      toolRegistry: new ToolRegistry(),
      providerRegistry: registryWith(provider),
      anonymizationMiddleware: new AnonymizationMiddleware(),
    });
    expect((result.output as { normalized: string }).normalized).toBe('mc@acme.com');
  });

  it('leaves the flat-description path unchanged when no fields are present', async () => {
    const provider = new MockProvider('{"result":"ok"}');
    await runAgent({
      agent: { name: 'test', provider: 'mock', model: 'x' },
      task: { description: 'Process mc@acme.com data' },
      context: {},
      toolRegistry: new ToolRegistry(),
      providerRegistry: registryWith(provider),
      anonymizationMiddleware: new AnonymizationMiddleware(),
    });
    const promptText = provider.capturedRequests[0].messages.map(m => m.content).join(' ');
    expect(promptText).not.toContain('mc@acme.com');
    expect(promptText).toContain('EMAIL_1');
  });

  it('AC5: out-of-scope field reaches the prompt as cleartext (deterministic stage survives)', async () => {
    const provider = new MockProvider('{"result":"ok"}');
    await runAgent({
      agent: { name: 'test', provider: 'mock', model: 'x' },
      task: {
        description: '',
        fields: { from: 'mc@acme.com', body: 'Reply to jane@acme.com' },
        anonymize_fields: ['body'], // only body in scope; from stays clear
      },
      context: {},
      toolRegistry: new ToolRegistry(),
      providerRegistry: registryWith(provider),
      anonymizationMiddleware: new AnonymizationMiddleware(),
    });

    const promptText = provider.capturedRequests[0].messages.map(m => m.content).join(' ');
    // from is out of scope → its real address is present for a cleartext pass
    expect(promptText).toContain('mc@acme.com');
    // body is in scope → tokenized, real address absent
    expect(promptText).toContain('EMAIL_1');
    expect(promptText).not.toContain('jane@acme.com');
  });
});
