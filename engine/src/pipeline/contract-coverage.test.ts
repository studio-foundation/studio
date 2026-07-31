import { describe, it, expect } from 'vitest';
import type { PipelineEntry } from '@studio-foundation/contracts';
import {
  findUnvalidatedStages,
  formatUnvalidatedStages,
} from './contract-coverage.js';

describe('findUnvalidatedStages', () => {
  it('returns nothing when every stage declares a contract', () => {
    const entries: PipelineEntry[] = [
      { name: 'plan', agent: 'planner', contract: 'plan' },
      { name: 'code', agent: 'coder', contract: 'code-generation' },
    ];
    expect(findUnvalidatedStages(entries)).toEqual([]);
  });

  it('reports a simple stage with no contract', () => {
    const entries: PipelineEntry[] = [
      { name: 'plan', agent: 'planner', contract: 'plan' },
      { name: 'code', agent: 'coder' },
    ];
    expect(findUnvalidatedStages(entries)).toEqual([{ stage: 'code' }]);
  });

  it('reports stages inside a group, naming the group', () => {
    const entries: PipelineEntry[] = [
      {
        group: 'implementation-review',
        max_iterations: 3,
        stages: [
          { name: 'code', agent: 'coder' },
          { name: 'qa', agent: 'analyst', contract: 'qa-review' },
        ],
      },
    ];
    expect(findUnvalidatedStages(entries)).toEqual([
      { stage: 'code', group: 'implementation-review' },
    ]);
  });

  it('reports a script stage with no contract', () => {
    const entries: PipelineEntry[] = [
      { name: 'export', executor: 'script', script: 'export.py', runtime: 'python' },
    ];
    expect(findUnvalidatedStages(entries)).toEqual([{ stage: 'export' }]);
  });

  it('ignores map and call entries — they carry no contract field', () => {
    const entries: PipelineEntry[] = [
      { map: 'pages', over: 'stages.plan.output.items', pipeline: 'page-item', on_item_failure: 'fail-fast' },
      { call: 'publish', pipeline: 'publisher' },
    ];
    expect(findUnvalidatedStages(entries)).toEqual([]);
  });

  it('keeps pipeline order across mixed entries', () => {
    const entries: PipelineEntry[] = [
      { name: 'first', agent: 'a' },
      { map: 'fan', over: 'stages.first.output.items', pipeline: 'item', on_item_failure: 'fail-fast' },
      { group: 'g', max_iterations: 2, stages: [{ name: 'second', agent: 'b' }, { name: 'third', agent: 'c', contract: 'x' }] },
      { name: 'fourth', agent: 'd' },
    ];
    expect(findUnvalidatedStages(entries)).toEqual([
      { stage: 'first' },
      { stage: 'second', group: 'g' },
      { stage: 'fourth' },
    ]);
  });
});

describe('formatUnvalidatedStages', () => {
  it('names the stage', () => {
    expect(formatUnvalidatedStages([{ stage: 'code-generation' }])).toEqual([
      "stage 'code-generation' has no contract — output is not validated",
    ]);
  });

  it('names the enclosing group when there is one', () => {
    expect(formatUnvalidatedStages([{ stage: 'code', group: 'impl' }])).toEqual([
      "stage 'code' (in group 'impl') has no contract — output is not validated",
    ]);
  });
});
