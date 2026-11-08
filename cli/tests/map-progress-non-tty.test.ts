import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MapRenderer } from '../src/output/map-progress.js';

describe('MapRenderer on a non-TTY stdout (STU-2010)', () => {
  let logs: string[];
  let spy: ReturnType<typeof vi.spyOn>;
  const original = process.stdout.isTTY;

  beforeEach(() => {
    logs = [];
    spy = vi.spyOn(console, 'log').mockImplementation((s?: unknown) => { logs.push(String(s ?? '')); });
  });
  afterEach(() => {
    spy.mockRestore();
    process.stdout.isTTY = original;
  });

  function run(): string[] {
    const r = new MapRenderer();
    r.start('fan', 'child', 3, 1);
    for (let i = 0; i < 3; i++) {
      r.itemStart(i, `item-${i}`);
      r.itemComplete(i, 'success', `item-${i}`);
    }
    r.finish(3, 0, 'success');
    return logs.filter((l) => /\d+\/3 done/.test(l));
  }

  it('writes one progress line per completed item, ending on N/N done', () => {
    process.stdout.isTTY = false;
    const lines = run();
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('1/3 done');
    expect(lines[2]).toContain('3/3 done');
  });

  it('keeps the in-place spinner only on a TTY', () => {
    process.stdout.isTTY = true;
    expect(run()).toHaveLength(0);
  });
});
