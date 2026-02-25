import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { WebhookStore, type WebhookRegistration, type WebhookDelivery } from '../src/webhook-store.js';

describe('WebhookStore', () => {
  let store: WebhookStore;

  beforeEach(() => {
    const dbDir = resolve('/tmp', `.studio-webhook-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dbDir, { recursive: true });
    store = new WebhookStore(resolve(dbDir, 'runs.db'));
  });

  afterEach(() => {
    store.close();
  });

  test('saves and retrieves a webhook', () => {
    const webhook: WebhookRegistration = {
      id: 'wh-1',
      url: 'https://example.com/webhook',
      events: ['pipeline_complete', 'stage_failed'],
      secret: 'secret123',
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    };
    store.saveWebhook(webhook);
    expect(store.getWebhook('wh-1')).toEqual(webhook);
  });

  test('returns null for unknown webhook', () => {
    expect(store.getWebhook('nonexistent')).toBeNull();
  });

  test('lists all webhooks', () => {
    store.saveWebhook({ id: 'wh-1', url: 'https://a.com', events: ['pipeline_complete'], status: 'active', created_at: '2026-01-01T00:00:00.000Z' });
    store.saveWebhook({ id: 'wh-2', url: 'https://b.com', events: ['stage_failed'], status: 'active', created_at: '2026-01-02T00:00:00.000Z' });
    const webhooks = store.listWebhooks();
    expect(webhooks).toHaveLength(2);
    expect(webhooks.map(w => w.id)).toContain('wh-1');
    expect(webhooks.map(w => w.id)).toContain('wh-2');
  });

  test('returns empty list when no webhooks', () => {
    expect(store.listWebhooks()).toHaveLength(0);
  });

  test('deletes a webhook and returns true', () => {
    store.saveWebhook({ id: 'wh-1', url: 'https://a.com', events: [], status: 'active', created_at: '2026-01-01T00:00:00.000Z' });
    expect(store.deleteWebhook('wh-1')).toBe(true);
    expect(store.getWebhook('wh-1')).toBeNull();
  });

  test('deleteWebhook returns false for unknown id', () => {
    expect(store.deleteWebhook('does-not-exist')).toBe(false);
  });

  test('marks webhook as failed', () => {
    store.saveWebhook({ id: 'wh-1', url: 'https://a.com', events: [], status: 'active', created_at: '2026-01-01T00:00:00.000Z' });
    store.markWebhookFailed('wh-1');
    expect(store.getWebhook('wh-1')?.status).toBe('failed');
  });

  test('saves a delivery without error', () => {
    store.saveWebhook({ id: 'wh-1', url: 'https://a.com', events: [], status: 'active', created_at: '2026-01-01T00:00:00.000Z' });
    const delivery: WebhookDelivery = {
      id: 'del-1',
      webhook_id: 'wh-1',
      event: 'pipeline_complete',
      run_id: 'run-1',
      status: 'pending',
      attempt: 1,
      created_at: '2026-01-01T00:00:00.000Z',
    };
    expect(() => store.saveDelivery(delivery)).not.toThrow();
  });

  test('updates a delivery status without error', () => {
    store.saveWebhook({ id: 'wh-1', url: 'https://a.com', events: [], status: 'active', created_at: '2026-01-01T00:00:00.000Z' });
    store.saveDelivery({
      id: 'del-1',
      webhook_id: 'wh-1',
      event: 'pipeline_complete',
      run_id: 'run-1',
      status: 'pending',
      attempt: 1,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    expect(() => store.updateDelivery('del-1', 'success')).not.toThrow();
  });

  test('persists events array as JSON', () => {
    store.saveWebhook({ id: 'wh-1', url: 'https://a.com', events: ['pipeline_start', 'pipeline_complete'], status: 'active', created_at: '2026-01-01T00:00:00.000Z' });
    const result = store.getWebhook('wh-1');
    expect(result?.events).toEqual(['pipeline_start', 'pipeline_complete']);
  });
});
