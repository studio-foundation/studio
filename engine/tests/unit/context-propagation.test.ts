import { describe, it, expect } from 'vitest';
import {
  getContextForStage,
  createInitialContext,
} from '../../src/pipeline/context-propagation.js';
import type { StageDefinition } from '@studio/contracts';

const makeStage = (name: string, includes: string[]): StageDefinition => ({
  name,
  kind: 'analysis',
  agent: 'test-agent',
  context: { include: includes },
});

describe('getContextForStage — stage_name', () => {
  it('injects stage_name when included', () => {
    const ctx = createInitialContext({ userId: 'u1' });
    const stage = makeStage('recipe-1', ['stage_name']);

    const agentCtx = getContextForStage(ctx, stage);

    expect(agentCtx.stage_name).toBe('recipe-1');
  });

  it('does not inject stage_name when not included', () => {
    const ctx = createInitialContext({ userId: 'u1' });
    const stage = makeStage('recipe-1', ['input']);

    const agentCtx = getContextForStage(ctx, stage);

    expect(agentCtx.stage_name).toBeUndefined();
  });

  it('injects correct name for each stage', () => {
    const ctx = createInitialContext('input data');
    const stages = ['recipe-1', 'recipe-2', 'recipe-5'].map(n =>
      makeStage(n, ['stage_name'])
    );

    for (const stage of stages) {
      const agentCtx = getContextForStage(ctx, stage);
      expect(agentCtx.stage_name).toBe(stage.name);
    }
  });
});
