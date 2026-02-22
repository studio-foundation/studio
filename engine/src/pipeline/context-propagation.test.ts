import { describe, it, expect } from 'vitest';
import {
  createInitialContext,
  getContextForStage,
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

    const agentCtx = getContextForStage(ctx, makeStage(['pipeline_start_context'])) as any;
    expect(agentCtx.startup_context).toEqual({
      git_status: 'M src/foo.ts',
      recent_commits: 'abc123 feat: stuff',
    });
  });

  it('does not inject startup_context when not in include list', () => {
    const ctx = createInitialContext('my input');
    ctx.startupContext = { git_status: 'M src/foo.ts' };

    const agentCtx = getContextForStage(ctx, makeStage(['input'])) as any;
    expect(agentCtx.startup_context).toBeUndefined();
  });

  it('does not inject startup_context when startupContext is empty', () => {
    const ctx = createInitialContext('my input');
    ctx.startupContext = {};

    const agentCtx = getContextForStage(ctx, makeStage(['pipeline_start_context'])) as any;
    expect(agentCtx.startup_context).toBeUndefined();
  });
});
