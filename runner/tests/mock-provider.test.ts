import { describe, it, expect, vi } from 'vitest';
import { MockProvider } from '../src/providers/mock.js';

const stagesMap = new Map([
  ['brief-analysis', {
    output: { summary: 'mock summary', requirements: ['req1'] },
    tool_calls: [],
  }],
  ['code-generation', {
    output: { summary: 'mock code', files_changed: ['foo.ts'] },
    tool_calls: [
      { name: 'repo_manager-write_file', arguments: { path: 'foo.ts', content: '// mock' } },
    ],
  }],
]);

describe('MockProvider', () => {
  it('returns predefined output for a known stage', async () => {
    const provider = new MockProvider(stagesMap);
    const executeTool = vi.fn().mockResolvedValue({ result: 'ok' });

    const result = await provider.runAgentLoop(
      {
        model: 'mock',
        messages: [],
        stage_name: 'brief-analysis',
      },
      executeTool
    );

    expect(result.content).toBe(JSON.stringify({ summary: 'mock summary', requirements: ['req1'] }));
    expect(result.tool_calls).toHaveLength(0);
    expect(result.finish_reason).toBe('stop');
    expect(result.usage?.total_tokens).toBe(0);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('calls executeTool for each tool call in config', async () => {
    const provider = new MockProvider(stagesMap);
    const executeTool = vi.fn().mockResolvedValue({ result: 'written' });

    const result = await provider.runAgentLoop(
      {
        model: 'mock',
        messages: [],
        stage_name: 'code-generation',
      },
      executeTool
    );

    expect(executeTool).toHaveBeenCalledOnce();
    expect(executeTool).toHaveBeenCalledWith(
      'repo_manager-write_file',
      { path: 'foo.ts', content: '// mock' },
      expect.any(String)
    );
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0].name).toBe('repo_manager-write_file');
  });

  it('throws a clear error for unknown stage', async () => {
    const provider = new MockProvider(stagesMap);

    await expect(
      provider.runAgentLoop({ model: 'mock', messages: [], stage_name: 'unknown-stage' }, vi.fn())
    ).rejects.toThrow('Unknown mock stage: "unknown-stage"');
  });

  it('throws when stage_name is missing', async () => {
    const provider = new MockProvider(stagesMap);

    await expect(
      provider.runAgentLoop({ model: 'mock', messages: [] }, vi.fn())
    ).rejects.toThrow('MockProvider requires stage_name');
  });
});
