import { describe, it, expect } from 'vitest';
import {
  createInitialContext,
  getContextForStage,
  addStageOutput,
} from './context-propagation.js';
import type { StageDefinition } from '@studio/contracts';

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
