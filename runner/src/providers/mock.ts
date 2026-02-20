import { randomUUID } from 'node:crypto';
import type { LLMRequest, LLMResponse } from '@studio/contracts';
import type { AgentLoopProvider, AgentLoopResult, ToolCallOutcome } from './provider.js';

export interface MockStageConfig {
  output: Record<string, unknown>;
  tool_calls: Array<{
    name: string;
    arguments: Record<string, unknown>;
  }>;
}

export class MockProvider implements AgentLoopProvider {
  readonly name = 'mock';

  constructor(private readonly stages: Map<string, MockStageConfig>) {}

  async call(_request: LLMRequest, _onToken?: (token: string) => void): Promise<LLMResponse> {
    throw new Error('MockProvider: use runAgentLoop, not call()');
  }

  async runAgentLoop(
    request: LLMRequest,
    executeTool: (name: string, args: Record<string, unknown>, callId: string) => Promise<ToolCallOutcome>,
    onToken?: (token: string) => void
  ): Promise<AgentLoopResult> {
    if (!request.stage_name) {
      throw new Error('MockProvider requires stage_name in LLMRequest');
    }

    const config = this.stages.get(request.stage_name);
    if (!config) {
      throw new Error(
        `Unknown mock stage: "${request.stage_name}". Add it to mock.yaml.`
      );
    }

    const toolCallResults: AgentLoopResult['tool_calls'] = [];

    for (const tc of config.tool_calls) {
      const callId = randomUUID();
      const outcome = await executeTool(tc.name, tc.arguments, callId);
      toolCallResults.push({ id: callId, name: tc.name, arguments: tc.arguments, ...outcome });
    }

    return {
      content: JSON.stringify(config.output),
      tool_calls: toolCallResults,
      finish_reason: 'stop',
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }
}
