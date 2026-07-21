import { describe, it, expect } from 'vitest';
import { parsePipelineYaml } from '../../src/pipeline/loader.js';
import { isCallStage } from '@studio-foundation/contracts';

const base = (callBlock: string) => `
name: t
description: d
version: 1
stages:
${callBlock}
`;

describe('loader — call (one-shot sub-pipeline) stage', () => {
  it('parses a full call stage', () => {
    const p = parsePipelineYaml(base(`  - call: extraction
    pipeline: wiki-extraction
    condition: input.enabled == true
    input:
      book: "{{input.book}}"
      splits: "{{stages.plan.output.splits}}"`));

    expect(p.stages).toHaveLength(1);
    const entry = p.stages[0];
    expect(isCallStage(entry)).toBe(true);
    if (!isCallStage(entry)) throw new Error('not a call stage');
    expect(entry.call).toBe('extraction');
    expect(entry.pipeline).toBe('wiki-extraction');
    expect(entry.condition).toBe('input.enabled == true');
    expect(entry.input).toEqual({ book: '{{input.book}}', splits: '{{stages.plan.output.splits}}' });
  });

  it('defaults pipeline to the stage name when omitted', () => {
    const p = parsePipelineYaml(base(`  - call: wiki-extraction`));
    const entry = p.stages[0];
    if (!isCallStage(entry)) throw new Error('not a call stage');
    expect(entry.call).toBe('wiki-extraction');
    expect(entry.pipeline).toBeUndefined();
    expect(entry.input).toBeUndefined();
  });

  it('expresses a 4-pipeline sequence in one YAML', () => {
    const p = parsePipelineYaml(base(`  - call: wiki-extraction
  - call: wiki-resolution
  - call: wiki-preparation
  - call: pages-export`));
    expect(p.stages).toHaveLength(4);
    expect(p.stages.every(isCallStage)).toBe(true);
    expect(p.stages.map(s => (s as any).call)).toEqual([
      'wiki-extraction', 'wiki-resolution', 'wiki-preparation', 'pages-export',
    ]);
  });

  it('rejects unknown fields (fail-loud)', () => {
    expect(() => parsePipelineYaml(base(`  - call: x
    over: input.items`))).toThrow(/Unknown field 'over'/);
  });

  it('rejects a non-string pipeline', () => {
    expect(() => parsePipelineYaml(base(`  - call: x
    pipeline: 3`))).toThrow(/'pipeline' must be a string/);
  });

  it('rejects a non-object input', () => {
    expect(() => parsePipelineYaml(base(`  - call: x
    input: "not an object"`))).toThrow(/'input' must be an object/);
  });

  it('parses on_failure and defaults it to absent', () => {
    const p = parsePipelineYaml(base(`  - call: x
    on_failure: continue`));
    const entry = p.stages[0];
    if (!isCallStage(entry)) throw new Error('not a call stage');
    expect(entry.on_failure).toBe('continue');

    const q = parsePipelineYaml(base(`  - call: x`));
    if (!isCallStage(q.stages[0])) throw new Error('not a call stage');
    expect((q.stages[0] as any).on_failure).toBeUndefined();
  });

  it('rejects an unknown on_failure value (fail-loud)', () => {
    expect(() => parsePipelineYaml(base(`  - call: x
    on_failure: degrade`))).toThrow(/'on_failure' must be 'fail' or 'continue'/);
  });

  it('coexists with normal stages, groups and map stages in one pipeline', () => {
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
  - call: sub
    pipeline: child
  - map: gen
    over: stages.plan.output.items
    pipeline: child
    as: item
`);
    expect(p.stages).toHaveLength(3);
    expect(isCallStage(p.stages[0])).toBe(false);
    expect(isCallStage(p.stages[1])).toBe(true);
    expect(isCallStage(p.stages[2])).toBe(false);
  });
});
