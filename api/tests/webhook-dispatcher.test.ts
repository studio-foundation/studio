import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { WebhookStore } from '../src/webhook-store.js';
import { WebhookDispatcher } from '../src/webhook-dispatcher.js';

type FetchCall = { url: string; options: RequestInit };

function makeStore(): { store: WebhookStore; cleanup: () => void } {
  const dir = resolve('/tmp', `.studio-dispatcher-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const store = new WebhookStore(resolve(dir, 'runs.db'));
  return { store, cleanup: () => store.close() };
}

function makeFetch(status = 200): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const mockFetch = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    calls.push({ url: url.toString(), options: options ?? {} });
    return new Response('OK', { status });
  }) as unknown as typeof fetch;
  return { fetch: mockFetch, calls };
}

describe('WebhookDispatcher', () => {
  let store: WebhookStore;
  let cleanup: () => void;

  beforeEach(() => {
    ({ store, cleanup } = makeStore());
  });

  afterEach(() => {
    cleanup();
  });

  test('dispatches pipeline_complete to matching webhook', async () => {
    store.saveWebhook({ id: 'wh-1', url: 'https://hook.example.com/cb', events: ['pipeline_complete'], status: 'active', created_at: '2026-01-01T00:00:00.000Z' });
    const { fetch, calls } = makeFetch();
    const dispatcher = new WebhookDispatcher(store, 'my-project', fetch);

    await dispatcher.handleBusEvent('run-1', 'pipeline_complete', {
      pipeline_name: 'feature-builder',
      run_id: 'run-1',
      status: 'success',
      duration_ms: 1000,
      total_tokens: 100,
      total_tool_calls: 2,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://hook.example.com/cb');
  });

  test('does not dispatch when event type does not match webhook subscription', async () => {
    store.saveWebhook({ id: 'wh-1', url: 'https://hook.example.com/cb', events: ['stage_failed'], status: 'active', created_at: '2026-01-01T00:00:00.000Z' });
    const { fetch, calls } = makeFetch();
    const dispatcher = new WebhookDispatcher(store, 'my-project', fetch);

    await dispatcher.handleBusEvent('run-1', 'pipeline_complete', { status: 'success' });

    expect(calls).toHaveLength(0);
  });

  test('includes X-Studio-Event header', async () => {
    store.saveWebhook({ id: 'wh-1', url: 'https://hook.example.com/cb', events: ['pipeline_complete'], status: 'active', created_at: '2026-01-01T00:00:00.000Z' });
    const { fetch, calls } = makeFetch();
    const dispatcher = new WebhookDispatcher(store, 'my-project', fetch);

    await dispatcher.handleBusEvent('run-1', 'pipeline_complete', { status: 'success' });

    const headers = calls[0].options.headers as Record<string, string>;
    expect(headers['X-Studio-Event']).toBe('pipeline_complete');
  });

  test('includes X-Studio-Signature header when webhook has a secret', async () => {
    store.saveWebhook({ id: 'wh-1', url: 'https://hook.example.com/cb', events: ['pipeline_complete'], secret: 'mysecret', status: 'active', created_at: '2026-01-01T00:00:00.000Z' });
    const { fetch, calls } = makeFetch();
    const dispatcher = new WebhookDispatcher(store, 'my-project', fetch);

    await dispatcher.handleBusEvent('run-1', 'pipeline_complete', { status: 'success' });

    const headers = calls[0].options.headers as Record<string, string>;
    expect(headers['X-Studio-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  test('does not include X-Studio-Signature when no secret configured', async () => {
    store.saveWebhook({ id: 'wh-1', url: 'https://hook.example.com/cb', events: ['pipeline_complete'], status: 'active', created_at: '2026-01-01T00:00:00.000Z' });
    const { fetch, calls } = makeFetch();
    const dispatcher = new WebhookDispatcher(store, 'my-project', fetch);

    await dispatcher.handleBusEvent('run-1', 'pipeline_complete', { status: 'success' });

    const headers = calls[0].options.headers as Record<string, string>;
    expect(headers['X-Studio-Signature']).toBeUndefined();
  });

  test('payload contains run_id, event, ts fields', async () => {
    store.saveWebhook({ id: 'wh-1', url: 'https://hook.example.com/cb', events: ['pipeline_complete'], status: 'active', created_at: '2026-01-01T00:00:00.000Z' });
    const { fetch, calls } = makeFetch();
    const dispatcher = new WebhookDispatcher(store, 'my-project', fetch);

    await dispatcher.handleBusEvent('run-42', 'pipeline_complete', { status: 'success' });

    const body = JSON.parse(calls[0].options.body as string);
    expect(body.run_id).toBe('run-42');
    expect(body.event).toBe('pipeline_complete');
    expect(body.ts).toBeDefined();
  });

  test('maps stage_complete with rejected status to stage_rejected webhook event', async () => {
    store.saveWebhook({ id: 'wh-1', url: 'https://hook.example.com/cb', events: ['stage_rejected'], status: 'active', created_at: '2026-01-01T00:00:00.000Z' });
    const { fetch, calls } = makeFetch();
    const dispatcher = new WebhookDispatcher(store, 'my-project', fetch);

    await dispatcher.handleBusEvent('run-1', 'stage_complete', { stage_name: 'qa', status: 'rejected' });

    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0].options.body as string);
    expect(body.event).toBe('stage_rejected');
  });

  test('maps stage_complete with failed status to stage_failed webhook event', async () => {
    store.saveWebhook({ id: 'wh-1', url: 'https://hook.example.com/cb', events: ['stage_failed'], status: 'active', created_at: '2026-01-01T00:00:00.000Z' });
    const { fetch, calls } = makeFetch();
    const dispatcher = new WebhookDispatcher(store, 'my-project', fetch);

    await dispatcher.handleBusEvent('run-1', 'stage_complete', { stage_name: 'code', status: 'failed' });

    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0].options.body as string);
    expect(body.event).toBe('stage_failed');
  });

  test('maps stage_complete with success status to stage_complete webhook event', async () => {
    store.saveWebhook({ id: 'wh-1', url: 'https://hook.example.com/cb', events: ['stage_complete'], status: 'active', created_at: '2026-01-01T00:00:00.000Z' });
    const { fetch, calls } = makeFetch();
    const dispatcher = new WebhookDispatcher(store, 'my-project', fetch);

    await dispatcher.handleBusEvent('run-1', 'stage_complete', { stage_name: 'code', status: 'success' });

    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0].options.body as string);
    expect(body.event).toBe('stage_complete');
  });

  test('does not dispatch to failed webhooks', async () => {
    store.saveWebhook({ id: 'wh-1', url: 'https://hook.example.com/cb', events: ['pipeline_complete'], status: 'failed', created_at: '2026-01-01T00:00:00.000Z' });
    const { fetch, calls } = makeFetch();
    const dispatcher = new WebhookDispatcher(store, 'my-project', fetch);

    await dispatcher.handleBusEvent('run-1', 'pipeline_complete', { status: 'success' });

    expect(calls).toHaveLength(0);
  });

  test('dispatches to multiple matching webhooks', async () => {
    store.saveWebhook({ id: 'wh-1', url: 'https://a.example.com/hook', events: ['pipeline_complete'], status: 'active', created_at: '2026-01-01T00:00:00.000Z' });
    store.saveWebhook({ id: 'wh-2', url: 'https://b.example.com/hook', events: ['pipeline_complete', 'stage_failed'], status: 'active', created_at: '2026-01-01T00:00:00.000Z' });
    const { fetch, calls } = makeFetch();
    const dispatcher = new WebhookDispatcher(store, 'my-project', fetch);

    await dispatcher.handleBusEvent('run-1', 'pipeline_complete', { status: 'success' });

    expect(calls).toHaveLength(2);
  });

  test('retries on HTTP 5xx and marks webhook failed after 3 failed retries', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const failingFetch = vi.fn(async () => {
      callCount++;
      return new Response('Error', { status: 500 });
    }) as unknown as typeof fetch;

    const { store: s, cleanup: c } = makeStore();
    s.saveWebhook({ id: 'wh-fail', url: 'https://fail.example.com/hook', events: ['pipeline_complete'], status: 'active', created_at: '2026-01-01T00:00:00.000Z' });
    const dispatcher = new WebhookDispatcher(s, 'test', failingFetch);

    await dispatcher.handleBusEvent('run-1', 'pipeline_complete', { status: 'success' });

    // Advance through all retry delays: 30s + 5min + 15min
    await vi.advanceTimersByTimeAsync(30_001);
    await vi.advanceTimersByTimeAsync(5 * 60_001);
    await vi.advanceTimersByTimeAsync(15 * 60_001);

    expect(callCount).toBe(4); // 1 original + 3 retries
    expect(s.getWebhook('wh-fail')?.status).toBe('failed');

    c();
    vi.useRealTimers();
  });

  test('does not retry on successful delivery', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const successFetch = vi.fn(async () => {
      callCount++;
      return new Response('OK', { status: 200 });
    }) as unknown as typeof fetch;

    const { store: s, cleanup: c } = makeStore();
    s.saveWebhook({ id: 'wh-ok', url: 'https://ok.example.com/hook', events: ['pipeline_complete'], status: 'active', created_at: '2026-01-01T00:00:00.000Z' });
    const dispatcher = new WebhookDispatcher(s, 'test', successFetch);

    await dispatcher.handleBusEvent('run-1', 'pipeline_complete', { status: 'success' });
    await vi.runAllTimersAsync();

    expect(callCount).toBe(1);

    c();
    vi.useRealTimers();
  });
});
