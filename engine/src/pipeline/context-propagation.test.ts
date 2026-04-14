import { describe, it, expect } from 'vitest';
import {
  createInitialContext,
  getContextForStage,
  addStageOutput,
  buildContextKeys,
  buildContextContent,
} from './context-propagation.js';
import type { StageDefinition, ToolCall } from '@studio-foundation/contracts';
import type { AgentContext } from '@studio-foundation/runner';

const makeStage = (include: string[]): StageDefinition => ({
  name: 'test-stage',
  kind: 'analysis',
  agent: 'analyst',
  context: { include },
});

describe('getContextForStage — pipeline_start_context', () => {
  it('injects startup_context when stage includes pipeline_start_context', () => {
    const ctx = createInitialContext('my input');
    ctx.startupContext = { git_status: 'M src/foo.ts', recent_commits: 'abc123 feat: stuff' };

    const agentCtx = getContextForStage(ctx, makeStage(['pipeline_start_context']));
    expect(agentCtx.startup_context).toEqual({
      git_status: 'M src/foo.ts',
      recent_commits: 'abc123 feat: stuff',
    });
  });

  it('does not inject startup_context when not in include list', () => {
    const ctx = createInitialContext('my input');
    ctx.startupContext = { git_status: 'M src/foo.ts' };

    const agentCtx = getContextForStage(ctx, makeStage(['input']));
    expect(agentCtx.startup_context).toBeUndefined();
  });

  it('does not inject startup_context when startupContext is empty', () => {
    const ctx = createInitialContext('my input');
    ctx.startupContext = {};

    const agentCtx = getContextForStage(ctx, makeStage(['pipeline_start_context']));
    expect(agentCtx.startup_context).toBeUndefined();
  });
});

describe('addStageOutput — size tracking', () => {
  it('tracks serialized size when output is added', () => {
    const ctx = createInitialContext('input');
    const output = { summary: 'hello', items: [1, 2, 3] };
    addStageOutput(ctx, 'my-stage', output);

    const expectedSize = JSON.stringify(output).length;
    expect(ctx.stageOutputSizes.get('my-stage')).toBe(expectedSize);
  });

  it('tracks size for each stage independently', () => {
    const ctx = createInitialContext('input');
    const out1 = { a: 'short' };
    const out2 = { b: 'a much longer value here', c: [1, 2, 3, 4, 5] };
    addStageOutput(ctx, 'stage-1', out1);
    addStageOutput(ctx, 'stage-2', out2);

    expect(ctx.stageOutputSizes.get('stage-1')).toBe(JSON.stringify(out1).length);
    expect(ctx.stageOutputSizes.get('stage-2')).toBe(JSON.stringify(out2).length);
  });

  it('createInitialContext initializes stageOutputSizes as empty map', () => {
    const ctx = createInitialContext('input');
    expect(ctx.stageOutputSizes).toBeInstanceOf(Map);
    expect(ctx.stageOutputSizes.size).toBe(0);
  });
});

describe('buildContextKeys', () => {
  it('returns empty object for empty AgentContext', () => {
    const ctx: AgentContext = {};
    expect(buildContextKeys(ctx, new Map())).toEqual({});
  });

  it('includes input key when additional_context is set', () => {
    const ctx: AgentContext = { additional_context: 'hello world' };
    const keys = buildContextKeys(ctx, new Map());
    expect(keys.input).toBe('hello world'.length);
  });

  it('includes previous_stage_output with total size from size map', () => {
    const ctx: AgentContext = {
      previous_outputs: { 'brief-analysis': { summary: 'ok' } },
    };
    const sizes = new Map([['brief-analysis', 42]]);
    const keys = buildContextKeys(ctx, sizes);
    expect(keys.previous_stage_output).toBe(42);
  });

  it('sums sizes for multiple previous outputs', () => {
    const ctx: AgentContext = {
      previous_outputs: {
        'stage-a': { x: 1 },
        'stage-b': { y: 2 },
      },
    };
    const sizes = new Map([['stage-a', 10], ['stage-b', 20]]);
    const keys = buildContextKeys(ctx, sizes);
    expect(keys.previous_stage_output).toBe(30);
  });

  it('includes group_feedback key', () => {
    const feedback = { iteration: 1, max_iterations: 3, rejection_reason: 'nope' };
    const ctx: AgentContext = { group_feedback: feedback };
    const keys = buildContextKeys(ctx, new Map());
    expect(keys.group_feedback).toBe(JSON.stringify(feedback).length);
  });

  it('expands startup_context keys individually', () => {
    const ctx: AgentContext = {
      startup_context: {
        git_status: 'M src/foo.ts',
        recent_commits: 'abc def',
      },
    };
    const keys = buildContextKeys(ctx, new Map());
    expect(keys.git_status).toBe('M src/foo.ts'.length);
    expect(keys.recent_commits).toBe('abc def'.length);
    expect(keys.input).toBeUndefined();
  });

  it('includes context packs by name with total section chars', () => {
    const ctx: AgentContext = {
      context_packs: [
        {
          name: 'api-docs',
          sections: [
            { title: 'intro', content: 'hello' },
            { title: 'details', content: 'world!' },
          ],
        },
      ],
    };
    const keys = buildContextKeys(ctx, new Map());
    expect(keys['api-docs']).toBe('hello'.length + 'world!'.length);
  });

  it('omits absent keys', () => {
    const ctx: AgentContext = { additional_context: 'x' };
    const keys = buildContextKeys(ctx, new Map());
    expect(Object.keys(keys)).toEqual(['input']);
  });
});

const WRITE_TOOL_CALL: ToolCall = {
  id: '1',
  name: 'repo_manager-write_file',
  arguments: { path: 'src/foo.ts', content: 'const x = 1;' },
  result: { written: true },
};

describe('buildContextKeys — previous_tool_results', () => {
  it('includes previous_stage_tool_results key with total serialized byte size', () => {
    const ctx: AgentContext = { previous_tool_results: { 'code-generation': [WRITE_TOOL_CALL] } };
    const keys = buildContextKeys(ctx, new Map());
    expect(keys['previous_stage_tool_results']).toBe(JSON.stringify([WRITE_TOOL_CALL]).length);
  });

  it('sums sizes across multiple stages', () => {
    const tc2: ToolCall = { id: '2', name: 'repo_manager-read_file', arguments: { path: 'src/bar.ts' }, result: { path: 'src/bar.ts', content: 'hi' } };
    const ctx: AgentContext = {
      previous_tool_results: {
        'stage-a': [WRITE_TOOL_CALL],
        'stage-b': [tc2],
      },
    };
    const keys = buildContextKeys(ctx, new Map());
    expect(keys['previous_stage_tool_results']).toBe(
      JSON.stringify([WRITE_TOOL_CALL]).length + JSON.stringify([tc2]).length
    );
  });

  it('omits previous_stage_tool_results when previous_tool_results is absent', () => {
    const keys = buildContextKeys({}, new Map());
    expect(keys['previous_stage_tool_results']).toBeUndefined();
  });

  it('omits previous_stage_tool_results when previous_tool_results is empty', () => {
    const keys = buildContextKeys({ previous_tool_results: {} }, new Map());
    expect(keys['previous_stage_tool_results']).toBeUndefined();
  });
});

describe('buildContextContent — previous_tool_results', () => {
  it('maps previous_stage_tool_results to the previous_tool_results object', () => {
    const ctx: AgentContext = { previous_tool_results: { 'code-generation': [WRITE_TOOL_CALL] } };
    expect(buildContextContent(ctx)['previous_stage_tool_results']).toEqual({ 'code-generation': [WRITE_TOOL_CALL] });
  });

  it('omits previous_stage_tool_results when previous_tool_results is absent', () => {
    expect(buildContextContent({})['previous_stage_tool_results']).toBeUndefined();
  });

  it('omits previous_stage_tool_results when previous_tool_results is empty', () => {
    expect(buildContextContent({ previous_tool_results: {} })['previous_stage_tool_results']).toBeUndefined();
  });
});

describe('buildContextContent', () => {
  it('returns empty object for empty AgentContext', () => {
    expect(buildContextContent({})).toEqual({});
  });

  it('maps input key to additional_context value', () => {
    const ctx: AgentContext = { additional_context: 'my input' };
    expect(buildContextContent(ctx).input).toBe('my input');
  });

  it('maps previous_stage_output to previous_outputs object', () => {
    const ctx: AgentContext = { previous_outputs: { 'stage-a': { x: 1 } } };
    expect(buildContextContent(ctx).previous_stage_output).toEqual({ 'stage-a': { x: 1 } });
  });

  it('maps group_feedback key', () => {
    const fb = { iteration: 1, max_iterations: 3, rejection_reason: 'fail' };
    const ctx: AgentContext = { group_feedback: fb };
    expect(buildContextContent(ctx).group_feedback).toEqual(fb);
  });

  it('expands startup_context keys individually', () => {
    const ctx: AgentContext = { startup_context: { git_status: 'clean' } };
    expect(buildContextContent(ctx).git_status).toBe('clean');
  });

  it('maps each context pack by name to its pack object', () => {
    const pack = { name: 'api-docs', sections: [{ title: 'h', content: 'c' }] };
    const ctx: AgentContext = { context_packs: [pack] };
    expect(buildContextContent(ctx)['api-docs']).toEqual(pack);
  });
});
