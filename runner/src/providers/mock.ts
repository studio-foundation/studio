import { randomUUID } from 'node:crypto';
import type { LLMRequest, LLMResponse } from '@studio-foundation/contracts';
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

  async call(_request: LLMRequest, _onToken?: (token: string) => void, _signal?: AbortSignal): Promise<LLMResponse> {
    throw new Error('MockProvider: use runAgentLoop, not call()');
  }

  async runAgentLoop(
    request: LLMRequest,
    executeTool: (name: string, args: Record<string, unknown>, callId: string) => Promise<ToolCallOutcome>,
    onToken?: (token: string) => void,
    _signal?: AbortSignal
  ): Promise<AgentLoopResult> {
    // `request.stage_name` is actually the stage's *contract* name (runner.ts
    // populates it from `task.contract_name`) — mock.yaml is keyed by that, not
    // by the stage's own `name:`. A stage with no `contract:` field never
    // reaches this provider with anything to look up.
    if (!request.stage_name) {
      throw new Error(
        "MockProvider requires a 'contract:' on this stage — --provider mock looks up " +
        "its mock.yaml entry by the contract's name, not the stage's own name. Add " +
        "'contract: <name>' to the stage, and key mock.yaml with that same name."
      );
    }

    const config = this.stages.get(request.stage_name);
    if (!config) {
      throw new Error(
        `Unknown mock stage: "${request.stage_name}". mock.yaml must be keyed by the ` +
        `stage's *contract* name, not the stage's own name — add a "${request.stage_name}" ` +
        `entry to mock.yaml.`
      );
    }

    // Emit a fake token to exercise the streaming pipeline in tests
    onToken?.('...');

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
