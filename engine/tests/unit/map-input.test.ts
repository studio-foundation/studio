import { describe, it, expect } from 'vitest';
import { buildItemInput } from '../../src/pipeline/map-input.js';
import type { MapStage } from '@studio-foundation/contracts';

function mapStage(partial: Partial<MapStage>): MapStage {
  return { map: 'gen', over: 'input.items', pipeline: 'child', ...partial };
}

describe('buildItemInput', () => {
  it('as: shorthand wraps the item under the given key', () => {
    const m = mapStage({ as: 'entity' });
    expect(buildItemInput(m, { id: 1 }, 0, {})).toEqual({ entity: { id: 1 } });
  });

  it('passes an object item straight through when neither input nor as is set', () => {
    const m = mapStage({});
    expect(buildItemInput(m, { title: 'A' }, 0, {})).toEqual({ title: 'A' });
  });

  it('throws for a scalar item without as/input', () => {
    const m = mapStage({});
    expect(() => buildItemInput(m, 'plain-string', 2, {})).toThrow(/index 2/);
  });

  it('input template: a sole {{item}} keeps the native object type', () => {
    const m = mapStage({ input: { entity: '{{item}}' } });
    const out = buildItemInput(m, { name: 'X', nested: { a: 1 } }, 0, {});
    expect(out).toEqual({ entity: { name: 'X', nested: { a: 1 } } });
  });

  it('input template: resolves {{item.field}}, {{index}}, {{input.field}}', () => {
    const m = mapStage({
      input: {
        name: '{{item.name}}',
        i: '{{index}}',
        book: '{{input.book}}',
      },
    });
    const out = buildItemInput(m, { name: 'Alice' }, 3, { book: 'Dune' });
    expect(out).toEqual({ name: 'Alice', i: 3, book: 'Dune' });
  });

  it('input template: mixed strings interpolate to text', () => {
    const m = mapStage({ input: { label: 'item-{{index}}: {{item.name}}' } });
    const out = buildItemInput(m, { name: 'Bob' }, 5, {});
    expect(out).toEqual({ label: 'item-5: Bob' });
  });

  it('input template: unresolved refs become empty strings in mixed text', () => {
    const m = mapStage({ input: { label: 'x={{item.missing}}' } });
    expect(buildItemInput(m, {}, 0, {})).toEqual({ label: 'x=' });
  });

  it('input template: non-string values pass through unchanged', () => {
    const m = mapStage({ input: { flag: true, count: 7 } as Record<string, unknown> });
    expect(buildItemInput(m, {}, 0, {})).toEqual({ flag: true, count: 7 });
  });

  it('input takes precedence over as', () => {
    const m = mapStage({ as: 'entity', input: { x: '{{item}}' } });
    expect(buildItemInput(m, 'v', 0, {})).toEqual({ x: 'v' });
  });
});
