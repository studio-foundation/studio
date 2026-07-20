import { describe, it, expect } from 'vitest';
import { parsePipelineYaml } from '../../src/pipeline/loader.js';
import { isMapStage } from '@studio-foundation/contracts';

const base = (mapBlock: string) => `
name: t
description: d
version: 1
stages:
${mapBlock}
`;

describe('loader — map (fan-out) stage', () => {
  it('parses a full map stage with defaults', () => {
    const p = parsePipelineYaml(base(`  - map: gen
    over: stages.plan.output.items
    pipeline: page-item
    as: entity
    concurrency: 4
    on_item_failure: collect-all`));

    expect(p.stages).toHaveLength(1);
    const entry = p.stages[0];
    expect(isMapStage(entry)).toBe(true);
    if (!isMapStage(entry)) throw new Error('not a map stage');
    expect(entry.map).toBe('gen');
    expect(entry.over).toBe('stages.plan.output.items');
    expect(entry.pipeline).toBe('page-item');
    expect(entry.as).toBe('entity');
    expect(entry.concurrency).toBe(4);
    expect(entry.on_item_failure).toBe('collect-all');
  });

  it('defaults on_item_failure to fail-fast', () => {
    const p = parsePipelineYaml(base(`  - map: gen
    over: input.items
    pipeline: child`));
    const entry = p.stages[0];
    if (!isMapStage(entry)) throw new Error('not a map stage');
    expect(entry.on_item_failure).toBe('fail-fast');
    expect(entry.concurrency).toBeUndefined();
  });

  it('accepts an input template block', () => {
    const p = parsePipelineYaml(base(`  - map: gen
    over: input.items
    pipeline: child
    input:
      entity: "{{item}}"
      book: "{{input.book}}"`));
    const entry = p.stages[0];
    if (!isMapStage(entry)) throw new Error('not a map stage');
    expect(entry.input).toEqual({ entity: '{{item}}', book: '{{input.book}}' });
  });

  it('rejects unknown fields (fail-loud)', () => {
    expect(() => parsePipelineYaml(base(`  - map: gen
    over: input.items
    pipeline: child
    parallelism: 4`))).toThrow(/Unknown field 'parallelism'/);
  });

  it('requires over', () => {
    expect(() => parsePipelineYaml(base(`  - map: gen
    pipeline: child`))).toThrow(/missing 'over'/);
  });

  it('requires pipeline', () => {
    expect(() => parsePipelineYaml(base(`  - map: gen
    over: input.items`))).toThrow(/missing 'pipeline'/);
  });

  it('rejects a non-positive concurrency', () => {
    expect(() => parsePipelineYaml(base(`  - map: gen
    over: input.items
    pipeline: child
    concurrency: 0`))).toThrow(/positive integer/);
  });

  it('rejects an invalid on_item_failure', () => {
    expect(() => parsePipelineYaml(base(`  - map: gen
    over: input.items
    pipeline: child
    on_item_failure: retry`))).toThrow(/fail-fast.*collect-all/);
  });

  it('parses resume: true and defaults it to absent', () => {
    const withResume = parsePipelineYaml(base(`  - map: gen
    over: input.items
    pipeline: child
    resume: true`));
    const a = withResume.stages[0];
    if (!isMapStage(a)) throw new Error('not a map stage');
    expect(a.resume).toBe(true);

    const without = parsePipelineYaml(base(`  - map: gen
    over: input.items
    pipeline: child`));
    const b = without.stages[0];
    if (!isMapStage(b)) throw new Error('not a map stage');
    expect(b.resume).toBeUndefined();
  });

  it('rejects a non-boolean resume', () => {
    expect(() => parsePipelineYaml(base(`  - map: gen
    over: input.items
    pipeline: child
    resume: sometimes`))).toThrow(/'resume' must be a boolean/);
  });

  it('coexists with normal stages and groups in one pipeline', () => {
    const p = parsePipelineYaml(`
name: t
description: d
version: 1
stages:
  - name: plan
    kind: planning
    agent: analyst
    ralph:
      max_attempts: 1
  - map: gen
    over: stages.plan.output.items
    pipeline: child
    as: item
`);
    expect(p.stages).toHaveLength(2);
    expect(isMapStage(p.stages[0])).toBe(false);
    expect(isMapStage(p.stages[1])).toBe(true);
  });
});
