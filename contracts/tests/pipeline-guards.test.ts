import { describe, it, expect } from 'vitest';
import { isCallStage, isMapStage, isStageGroup } from '../src/index.js';
import type {
  CallStage,
  MapStage,
  PipelineEntry,
  StageDefinition,
  StageGroup,
} from '../src/index.js';

const stage: StageDefinition = {
  name: 'code-generation',
  agent: 'coder',
  contract: 'code-generation',
};

const scriptStage: StageDefinition = {
  name: 'export',
  executor: 'script',
  script: 'scripts/export.py',
  runtime: 'python',
};

const group: StageGroup = {
  group: 'build-and-review',
  max_iterations: 3,
  stages: [stage],
};

const mapStage: MapStage = {
  map: 'per-page',
  over: 'stages.plan.output.pages',
  pipeline: 'page-builder',
  as: 'page',
};

const callStage: CallStage = {
  call: 'wiki-resolution',
};

const entries: Array<[string, PipelineEntry]> = [
  ['stage', stage],
  ['script stage', scriptStage],
  ['group', group],
  ['map', mapStage],
  ['call', callStage],
];

describe('pipeline entry guards', () => {
  it('identifies each entry shape', () => {
    expect(isStageGroup(group)).toBe(true);
    expect(isMapStage(mapStage)).toBe(true);
    expect(isCallStage(callStage)).toBe(true);
  });

  // The engine dispatches on these guards in an arbitrary order, so at most one
  // may ever match an entry — otherwise the dispatch result depends on the order
  // the checks happen to be written in.
  it.each(entries)('matches at most one guard for a %s', (_label, entry) => {
    const matched = [
      isStageGroup(entry) && 'group',
      isMapStage(entry) && 'map',
      isCallStage(entry) && 'call',
    ].filter(Boolean);

    expect(matched.length).toBeLessThanOrEqual(1);
  });

  it('matches no guard for a plain stage', () => {
    for (const entry of [stage, scriptStage]) {
      expect(isStageGroup(entry)).toBe(false);
      expect(isMapStage(entry)).toBe(false);
      expect(isCallStage(entry)).toBe(false);
    }
  });

  it('requires both discriminant keys for a group', () => {
    expect(isStageGroup({ group: 'g', max_iterations: 1 } as unknown as PipelineEntry)).toBe(false);
    expect(isStageGroup({ name: 's', stages: [] } as unknown as PipelineEntry)).toBe(false);
  });

  it('requires both discriminant keys for a map', () => {
    expect(isMapStage({ map: 'm', pipeline: 'p' } as unknown as PipelineEntry)).toBe(false);
    expect(isMapStage({ over: 'input.items', pipeline: 'p' } as unknown as PipelineEntry)).toBe(false);
  });

  it('accepts a call stage without an explicit pipeline', () => {
    expect(isCallStage({ call: 'wiki-export' })).toBe(true);
  });

  it('reads present-but-undefined keys as present', () => {
    // `in` is a key check, not a value check: a YAML loader emitting `over: null`
    // still produces a map entry, and the guard must not silently reclassify it.
    expect(isMapStage({ map: 'm', over: undefined } as unknown as PipelineEntry)).toBe(true);
  });
});
