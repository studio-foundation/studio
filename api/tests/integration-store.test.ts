import { describe, test, expect } from 'vitest';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { IntegrationStore } from '../src/integration-store.js';

function makeStore() {
  const dir = resolve('/tmp', `.studio-int-store-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const store = new IntegrationStore(resolve(dir, 'runs.db'));
  return { store, cleanup: () => store.close() };
}

describe('IntegrationStore', () => {
  test('getConfig returns defaults for unknown integration', () => {
    const { store, cleanup } = makeStore();
    const config = store.getConfig('linear');
    expect(config).toEqual({ active: false });
    cleanup();
  });

  test('patchConfig stores and retrieves pipeline and active', () => {
    const { store, cleanup } = makeStore();
    store.patchConfig('linear', { pipeline: 'feature-builder', active: true });
    expect(store.getConfig('linear')).toEqual({ pipeline: 'feature-builder', active: true });
    cleanup();
  });

  test('patchConfig for one integration does not affect another', () => {
    const { store, cleanup } = makeStore();
    store.patchConfig('linear', { active: true });
    expect(store.getConfig('slack').active).toBe(false);
    cleanup();
  });

  test('insertTrigger and listTriggers are partitioned by integration_name', () => {
    const { store, cleanup } = makeStore();
    store.insertTrigger({
      id: 'trig-1',
      integration_name: 'linear',
      received_at: new Date().toISOString(),
      pipeline: 'feature-builder',
      run_id: 'run-1',
      status: 'success',
    });
    store.insertTrigger({
      id: 'trig-2',
      integration_name: 'slack',
      received_at: new Date().toISOString(),
      pipeline: 'feature-builder',
      run_id: 'run-2',
      status: 'success',
    });
    expect(store.listTriggers('linear')).toHaveLength(1);
    expect(store.listTriggers('linear')[0].id).toBe('trig-1');
    expect(store.listTriggers('slack')).toHaveLength(1);
    cleanup();
  });

  test('listTriggers returns most recent first', () => {
    const { store, cleanup } = makeStore();
    store.insertTrigger({ id: 'a', integration_name: 'linear', received_at: '2024-01-01T00:00:00Z', pipeline: 'p', status: 'success' });
    store.insertTrigger({ id: 'b', integration_name: 'linear', received_at: '2024-01-02T00:00:00Z', pipeline: 'p', status: 'success' });
    expect(store.listTriggers('linear')[0].id).toBe('b');
    cleanup();
  });
});
