import { describe, it, expect } from 'vitest';
import { formatMapItemStreamLine, MAP_ITEM_STREAM_TAG } from '../src/commands/run.js';

describe('--stream-items NDJSON line (STU-626)', () => {
  it('tags the line and carries the item output for a parent to render', () => {
    const line = formatMapItemStreamLine({
      map_name: 'discover-relationships',
      index: 3,
      total_items: 12,
      status: 'success',
      label: 'Chapter 4',
      output: { pairs: [{ a: 'Alice', b: 'Dodo', type: 'allies' }] },
    });

    expect(line.startsWith(MAP_ITEM_STREAM_TAG + ' ')).toBe(true);
    const payload = JSON.parse(line.slice(MAP_ITEM_STREAM_TAG.length + 1));
    expect(payload).toEqual({
      map: 'discover-relationships',
      index: 3,
      total: 12,
      label: 'Chapter 4',
      status: 'success',
      cached: false,
      output: { pairs: [{ a: 'Alice', b: 'Dodo', type: 'allies' }] },
    });
  });

  it('defaults cached to false and tolerates a missing output', () => {
    const payload = JSON.parse(
      formatMapItemStreamLine({
        map_name: 'wiki-pages',
        index: 0,
        total_items: 1,
        status: 'failed',
      }).slice(MAP_ITEM_STREAM_TAG.length + 1)
    );
    expect(payload.cached).toBe(false);
    expect(payload.output).toBeUndefined();
    expect(payload.status).toBe('failed');
  });
});
