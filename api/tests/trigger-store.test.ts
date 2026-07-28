import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { TriggerStore } from '../src/trigger-store.js';

let dir: string;
let store: TriggerStore;

beforeEach(() => {
  dir = resolve('/tmp', `.studio-trigger-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  store = new TriggerStore(resolve(dir, 'runs.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function record(over: Partial<Parameters<TriggerStore['insert']>[0]> = {}) {
  return {
    id: 'r1',
    trigger_name: 'alpha',
    received_at: '2026-01-01T00:00:00.000Z',
    pipeline: 'p',
    status: 'success' as const,
    ...over,
  };
}

describe('TriggerStore', () => {
  test('returns an empty list for a trigger with no deliveries', () => {
    expect(store.list('alpha')).toEqual([]);
  });

  test('round-trips a delivery with its optional fields', () => {
    store.insert(record({
      external_id: 'x1',
      external_label: 'ABC-1 — title',
      external_url: 'https://example.test/x1',
      run_id: 'run-1',
    }));

    expect(store.list('alpha')).toEqual([{
      id: 'r1',
      trigger_name: 'alpha',
      received_at: '2026-01-01T00:00:00.000Z',
      external_id: 'x1',
      external_label: 'ABC-1 — title',
      external_url: 'https://example.test/x1',
      pipeline: 'p',
      run_id: 'run-1',
      status: 'success',
    }]);
  });

  test('omits absent optional fields rather than returning nulls', () => {
    store.insert(record());
    const [row] = store.list('alpha');
    expect('external_id' in row).toBe(false);
    expect('run_id' in row).toBe(false);
  });

  test('partitions by trigger name', () => {
    store.insert(record({ id: 'a', trigger_name: 'alpha' }));
    store.insert(record({ id: 'b', trigger_name: 'beta' }));

    expect(store.list('alpha').map(r => r.id)).toEqual(['a']);
    expect(store.list('beta').map(r => r.id)).toEqual(['b']);
  });

  test('returns the most recent deliveries first, honouring the limit', () => {
    store.insert(record({ id: 'old', received_at: '2026-01-01T00:00:00.000Z' }));
    store.insert(record({ id: 'new', received_at: '2026-06-01T00:00:00.000Z' }));

    expect(store.list('alpha').map(r => r.id)).toEqual(['new', 'old']);
    expect(store.list('alpha', 1).map(r => r.id)).toEqual(['new']);
  });
});
