import { describe, it, expect } from 'vitest';
import {
  createInitialContext,
  addStageOutput,
  addStageToolResults,
  getContextForStage,
  setGroupFeedback,
  clearGroupFeedback,
  type GroupFeedback,
} from '../src/pipeline/context-propagation.js';
import type { StageDefinition, ToolCall } from '@studio/contracts';

function makeStage(overrides: Partial<StageDefinition> = {}): StageDefinition {
  return {
    name: 'test-stage',
    kind: 'analysis',
    agent: 'analyst',
    ...overrides,
  } as StageDefinition;
}

describe('createInitialContext', () => {
  it('creates context with input', () => {
    const ctx = createInitialContext('Build a FAQ page');
    expect(ctx.input).toBe('Build a FAQ page');
    expect(ctx.stageOutputs.size).toBe(0);
  });

  it('optionally includes repoPath', () => {
    const ctx = createInitialContext('test', '/path/to/repo');
    expect(ctx.repoPath).toBe('/path/to/repo');
  });
});

describe('addStageOutput', () => {
  it('adds stage output to context', () => {
    const ctx = createInitialContext('test');
    addStageOutput(ctx, 'brief-analysis', { summary: 'done' });

    expect(ctx.stageOutputs.get('brief-analysis')).toEqual({ summary: 'done' });
  });

  it('accumulates multiple stage outputs', () => {
    const ctx = createInitialContext('test');
    addStageOutput(ctx, 'stage-1', { result: 'a' });
    addStageOutput(ctx, 'stage-2', { result: 'b' });

    expect(ctx.stageOutputs.size).toBe(2);
    expect(ctx.stageOutputs.get('stage-1')).toEqual({ result: 'a' });
    expect(ctx.stageOutputs.get('stage-2')).toEqual({ result: 'b' });
  });
});

describe('structured input', () => {
  it('passes structured input as YAML string in additional_context', () => {
    const structuredInput = {
      brief_summary: 'Add FAQ to About page',
      target_page: 'src/pages/about.tsx',
      acceptance_criteria: ['FAQ section appears', 'Accordion style'],
    };
    const context = createInitialContext(structuredInput);
    const agentCtx = getContextForStage(context, {
      name: 'test',
      kind: 'analysis',
      agent: 'test-agent',
      context: { include: ['input'] },
    });
    // Structured input should be serialized as YAML in additional_context
    expect(agentCtx.additional_context).toContain('brief_summary');
    expect(agentCtx.additional_context).toContain('Add FAQ to About page');
    expect(agentCtx.additional_context).toContain('target_page');
  });

  it('passes string input unchanged', () => {
    const context = createInitialContext('Simple string input');
    const agentCtx = getContextForStage(context, {
      name: 'test',
      kind: 'analysis',
      agent: 'test-agent',
      context: { include: ['input'] },
    });
    expect(agentCtx.additional_context).toBe('Simple string input');
  });
});

describe('getContextForStage', () => {
  it('with "input" includes user input as additional_context', () => {
    const ctx = createInitialContext('Build a FAQ');
    const stage = makeStage({ context: { include: ['input'] } });

    const agentCtx = getContextForStage(ctx, stage);
    expect(agentCtx.additional_context).toBe('Build a FAQ');
  });

  it('with "previous_stage_output" includes the last stage output', () => {
    const ctx = createInitialContext('test');
    addStageOutput(ctx, 'analysis', { summary: 'looks good' });
    addStageOutput(ctx, 'planning', { steps: [1, 2, 3] });

    const stage = makeStage({ context: { include: ['previous_stage_output'] } });
    const agentCtx = getContextForStage(ctx, stage, 'planning');

    expect(agentCtx.previous_outputs).toEqual({
      planning: { steps: [1, 2, 3] },
    });
  });

  it('with "all_stage_outputs" includes all accumulated outputs', () => {
    const ctx = createInitialContext('test');
    addStageOutput(ctx, 'stage-1', { result: 'a' });
    addStageOutput(ctx, 'stage-2', { result: 'b' });

    const stage = makeStage({ context: { include: ['all_stage_outputs'] } });
    const agentCtx = getContextForStage(ctx, stage);

    expect(agentCtx.previous_outputs).toEqual({
      'stage-1': { result: 'a' },
      'stage-2': { result: 'b' },
    });
  });

  it('with "repo_files" sets repo_files to empty array (engine fills later)', () => {
    const ctx = createInitialContext('test', '/repo');
    const stage = makeStage({ context: { include: ['repo_files'] } });

    const agentCtx = getContextForStage(ctx, stage);
    expect(agentCtx.repo_files).toEqual([]);
  });

  it('defaults to "input" when no context.include specified', () => {
    const ctx = createInitialContext('default input');
    const stage = makeStage({});

    const agentCtx = getContextForStage(ctx, stage);
    expect(agentCtx.additional_context).toBe('default input');
  });

  it('combines multiple includes', () => {
    const ctx = createInitialContext('user input');
    addStageOutput(ctx, 'prev', { data: 42 });

    const stage = makeStage({
      context: { include: ['input', 'previous_stage_output', 'repo_files'] },
    });
    const agentCtx = getContextForStage(ctx, stage, 'prev');

    expect(agentCtx.additional_context).toBe('user input');
    expect(agentCtx.previous_outputs).toEqual({ prev: { data: 42 } });
    expect(agentCtx.repo_files).toEqual([]);
  });
});

describe('group feedback', () => {
  it('setGroupFeedback adds feedback to context', () => {
    const ctx = createInitialContext('test');
    const feedback: GroupFeedback = {
      iteration: 1,
      max_iterations: 3,
      rejection_reason: 'Missing error handling',
    };
    setGroupFeedback(ctx, feedback);
    expect(ctx.groupFeedback).toEqual(feedback);
  });

  it('clearGroupFeedback removes feedback from context', () => {
    const ctx = createInitialContext('test');
    setGroupFeedback(ctx, {
      iteration: 1,
      max_iterations: 3,
      rejection_reason: 'test',
    });
    clearGroupFeedback(ctx);
    expect(ctx.groupFeedback).toBeUndefined();
  });

  it('getContextForStage injects group_feedback into additional_context', () => {
    const ctx = createInitialContext('Build a FAQ');
    setGroupFeedback(ctx, {
      iteration: 1,
      max_iterations: 3,
      rejection_reason: 'Props not passed to component',
      rejection_details: ['Missing onClick handler', 'Wrong prop type'],
    });

    const stage = makeStage({
      context: { include: ['input', 'group_feedback'] },
    });
    const agentCtx = getContextForStage(ctx, stage);

    expect(agentCtx.additional_context).toContain('Build a FAQ');
    expect(agentCtx.additional_context).toContain('FEEDBACK');
    expect(agentCtx.additional_context).toContain('Iteration 2/3');
    expect(agentCtx.additional_context).toContain('Props not passed to component');
    expect(agentCtx.additional_context).toContain('Missing onClick handler');
    expect(agentCtx.additional_context).toContain('Wrong prop type');
    expect(agentCtx.additional_context).toContain('Address all issues');
  });

  it('group_feedback is ignored when no feedback is set', () => {
    const ctx = createInitialContext('Build a FAQ');
    const stage = makeStage({
      context: { include: ['input', 'group_feedback'] },
    });
    const agentCtx = getContextForStage(ctx, stage);

    // Only input is present, no feedback text
    expect(agentCtx.additional_context).toBe('Build a FAQ');
  });
});

describe('addStageToolResults', () => {
  it('stores tool calls by stage name', () => {
    const ctx = createInitialContext('test');
    const toolCalls: ToolCall[] = [
      { id: '1', name: 'search-search_codebase', arguments: { pattern: 'about' }, result: { matches: [] } },
    ];
    addStageToolResults(ctx, 'brief-analysis', toolCalls);
    expect(ctx.stageToolResults.get('brief-analysis')).toEqual(toolCalls);
  });

  it('accumulates tool results across stages', () => {
    const ctx = createInitialContext('test');
    addStageToolResults(ctx, 'stage-1', [{ id: '1', name: 'tool-a', arguments: {}, result: 'r1' }]);
    addStageToolResults(ctx, 'stage-2', [{ id: '2', name: 'tool-b', arguments: {}, result: 'r2' }]);
    expect(ctx.stageToolResults.size).toBe(2);
  });
});

describe('getContextForStage — previous_stage_tool_results', () => {
  it('includes tool calls from the previous stage', () => {
    const ctx = createInitialContext('test');
    const toolCalls: ToolCall[] = [
      { id: '1', name: 'search-search_codebase', arguments: { pattern: 'about' }, result: { matches: ['about.tsx'] } },
    ];
    addStageToolResults(ctx, 'brief-analysis', toolCalls);

    const stage = makeStage({ context: { include: ['previous_stage_tool_results'] } });
    const agentCtx = getContextForStage(ctx, stage, 'brief-analysis');

    expect(agentCtx.previous_tool_results).toEqual({ 'brief-analysis': toolCalls });
  });

  it('returns empty when no previous stage tool results', () => {
    const ctx = createInitialContext('test');
    const stage = makeStage({ context: { include: ['previous_stage_tool_results'] } });
    const agentCtx = getContextForStage(ctx, stage, 'nonexistent');
    expect(agentCtx.previous_tool_results).toBeUndefined();
  });
});

describe('getContextForStage — all_stage_tool_results', () => {
  it('includes tool calls from all stages', () => {
    const ctx = createInitialContext('test');
    const tc1: ToolCall[] = [{ id: '1', name: 'tool-a', arguments: {}, result: 'r1' }];
    const tc2: ToolCall[] = [{ id: '2', name: 'tool-b', arguments: {}, result: 'r2' }];
    addStageToolResults(ctx, 'stage-1', tc1);
    addStageToolResults(ctx, 'stage-2', tc2);

    const stage = makeStage({ context: { include: ['all_stage_tool_results'] } });
    const agentCtx = getContextForStage(ctx, stage);

    expect(agentCtx.previous_tool_results).toEqual({ 'stage-1': tc1, 'stage-2': tc2 });
  });
});
