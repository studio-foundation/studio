import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import Fastify from 'fastify';
import type { TriggerDef } from '@studio-foundation/contracts';
import { TriggerRuntime } from '../src/trigger-runtime.js';
import { TriggerStore } from '../src/trigger-store.js';

const SECRET = 'shh';
const PAYLOAD = { type: 'Issue', action: 'update', data: { id: 'i1', identifier: 'ABC-1', title: 'Ship it', description: 'do it', url: 'https://example.test/ABC-1', state: { name: 'In Progress' } } };

function makeTrigger(over: Partial<TriggerDef> = {}): TriggerDef {
  return {
    name: 'alpha',
    version: 1,
    pipeline: 'feature-builder',
    webhook: {
      hmac: { header: 'x-signature', secret: SECRET },
      when: ['payload.type == "Issue"', 'payload.data.state.name == "In Progress"'],
    },
    input: {
      brief_summary: '{{payload.data.identifier}} — {{payload.data.title}}',
      description: '{{payload.data.description}}',
      acceptance_criteria: [],
    },
    meta: { issue_id: '{{payload.data.id}}' },
    log: {
      external_id: '{{payload.data.id}}',
      external_label: '{{payload.data.identifier}}',
      external_url: '{{payload.data.url}}',
    },
    ...over,
  };
}

let dir: string;
let store: TriggerStore;

beforeEach(() => {
  dir = resolve('/tmp', `.studio-trigger-rt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  store = new TriggerStore(resolve(dir, 'runs.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeRuntime(triggers: TriggerDef[]) {
  const launcher = { launch: vi.fn().mockResolvedValue({ run_id: 'x' }), cancel: vi.fn() };
  const runtime = new TriggerRuntime({
    triggers,
    store,
    launcher: launcher as never,
    configsDir: dir,
    triggersDir: dir,
  });
  return { runtime, launcher };
}

async function serve(runtime: TriggerRuntime) {
  const fastify = Fastify();
  runtime.registerRoutes(fastify, '/api');
  await fastify.ready();
  return fastify;
}

function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
}

function post(fastify: Awaited<ReturnType<typeof serve>>, body: unknown, headers: Record<string, string> = {}, name = 'alpha') {
  const raw = JSON.stringify(body);
  return fastify.inject({
    method: 'POST',
    url: `/api/triggers/${name}/webhook`,
    headers: { 'content-type': 'application/json', 'x-signature': sign(raw), ...headers },
    payload: raw,
  });
}

describe('TriggerRuntime routes', () => {
  test('registers nothing when no trigger is configured', async () => {
    const { runtime } = makeRuntime([]);
    const fastify = await serve(runtime);

    expect((await fastify.inject({ method: 'GET', url: '/api/triggers/alpha' })).statusCode).toBe(404);
    await fastify.close();
  });

  test('GET returns the trigger, its pipeline and its webhook URL', async () => {
    const { runtime } = makeRuntime([makeTrigger()]);
    const fastify = await serve(runtime);

    const res = await fastify.inject({ method: 'GET', url: '/api/triggers/alpha' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ name: string; pipeline: string; webhook_url: string; deliveries: unknown[] }>();
    expect(body.name).toBe('alpha');
    expect(body.pipeline).toBe('feature-builder');
    expect(body.webhook_url).toContain('/api/triggers/alpha/webhook');
    expect(body.deliveries).toEqual([]);

    await fastify.close();
  });

  test('GET 404s an unknown trigger', async () => {
    const { runtime } = makeRuntime([makeTrigger()]);
    const fastify = await serve(runtime);

    expect((await fastify.inject({ method: 'GET', url: '/api/triggers/nope' })).statusCode).toBe(404);
    await fastify.close();
  });

  test('a matching signed delivery launches the run and logs it', async () => {
    const { runtime, launcher } = makeRuntime([makeTrigger()]);
    const fastify = await serve(runtime);

    const res = await post(fastify, PAYLOAD);
    expect(res.statusCode).toBe(202);
    expect(res.json<{ run_id: string }>().run_id).toBeTruthy();

    expect(launcher.launch).toHaveBeenCalledTimes(1);
    const call = launcher.launch.mock.calls[0][0] as {
      pipeline: string; input: Record<string, unknown>; meta: Record<string, unknown>;
    };
    expect(call.pipeline).toBe('feature-builder');
    expect(call.input).toEqual({
      brief_summary: 'ABC-1 — Ship it',
      description: 'do it',
      acceptance_criteria: [],
    });
    expect(call.meta).toEqual({ issue_id: 'i1', studio_trigger: 'alpha' });

    const [delivery] = store.list('alpha');
    expect(delivery).toMatchObject({
      trigger_name: 'alpha',
      external_id: 'i1',
      external_label: 'ABC-1',
      external_url: 'https://example.test/ABC-1',
      status: 'success',
    });

    await fastify.close();
  });

  test('rejects a delivery signed with the wrong secret', async () => {
    const { runtime, launcher } = makeRuntime([makeTrigger()]);
    const fastify = await serve(runtime);

    const raw = JSON.stringify(PAYLOAD);
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/triggers/alpha/webhook',
      headers: { 'content-type': 'application/json', 'x-signature': sign(raw, 'wrong') },
      payload: raw,
    });

    expect(res.statusCode).toBe(401);
    expect(launcher.launch).not.toHaveBeenCalled();
    await fastify.close();
  });

  test('rejects a delivery with no signature header', async () => {
    const { runtime } = makeRuntime([makeTrigger()]);
    const fastify = await serve(runtime);

    const raw = JSON.stringify(PAYLOAD);
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/triggers/alpha/webhook',
      headers: { 'content-type': 'application/json' },
      payload: raw,
    });

    expect(res.statusCode).toBe(401);
    await fastify.close();
  });

  test('ignores a delivery that does not match when:', async () => {
    const { runtime, launcher } = makeRuntime([makeTrigger()]);
    const fastify = await serve(runtime);

    const res = await post(fastify, { ...PAYLOAD, data: { ...PAYLOAD.data, state: { name: 'Done' } } });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ ignored: boolean }>().ignored).toBe(true);
    expect(launcher.launch).not.toHaveBeenCalled();
    expect(store.list('alpha')).toEqual([]);

    await fastify.close();
  });

  test('rejects a body that is not JSON', async () => {
    const { runtime } = makeRuntime([makeTrigger()]);
    const fastify = await serve(runtime);

    const res = await fastify.inject({
      method: 'POST',
      url: '/api/triggers/alpha/webhook',
      headers: { 'content-type': 'application/json', 'x-signature': sign('nope') },
      payload: 'nope',
    });

    expect(res.statusCode).toBe(400);
    await fastify.close();
  });

  test('skips signature checking when the trigger declares no hmac', async () => {
    const { runtime, launcher } = makeRuntime([makeTrigger({ webhook: { when: ['payload.type == "Issue"'] } })]);
    const fastify = await serve(runtime);

    const raw = JSON.stringify(PAYLOAD);
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/triggers/alpha/webhook',
      headers: { 'content-type': 'application/json' },
      payload: raw,
    });

    expect(res.statusCode).toBe(202);
    expect(launcher.launch).toHaveBeenCalledTimes(1);
    await fastify.close();
  });

  test('logs a failed delivery when the launcher throws', async () => {
    const { runtime, launcher } = makeRuntime([makeTrigger()]);
    launcher.launch.mockRejectedValue(new Error('boom'));
    const fastify = await serve(runtime);

    const res = await post(fastify, PAYLOAD);
    expect(res.statusCode).toBe(500);
    expect(store.list('alpha')[0]).toMatchObject({ status: 'failed' });

    await fastify.close();
  });
});

describe('TriggerRuntime.setupEventBus', () => {
  /** Captures the bus callback so a pipeline_complete event can be delivered directly. */
  function captureBus(runtime: TriggerRuntime) {
    let handler!: (runId: string, event: { type: string; data: unknown }) => void;
    runtime.setupEventBus({ subscribeAll: (cb: typeof handler) => { handler = cb; } } as never);
    return (runId: string, data: unknown) => handler(runId, { type: 'pipeline_complete', data });
  }

  const onFailure = { command: 'printenv > env.txt' };
  const outPath = () => resolve(dir, 'env.txt');

  test('runs on_failure with run and meta values in the environment', async () => {
    const { runtime } = makeRuntime([makeTrigger({ on_failure: onFailure })]);
    const emit = captureBus(runtime);

    emit('run-1', {
      status: 'failed',
      meta: { studio_trigger: 'alpha', issue_id: 'i1' },
      last_group_feedback: { rejection_reason: 'QA said no', rejection_details: ['a', 'b'] },
    });

    // The shell creates the redirect target before printenv writes to it, so wait
    // on the content rather than the file.
    const env = await vi.waitFor(() => {
      const content = existsSync(outPath()) ? readFileSync(outPath(), 'utf-8') : '';
      expect(content).toContain('STUDIO_TRIGGER=alpha');
      return content;
    });
    expect(env).toContain('STUDIO_RUN_ID=run-1');
    expect(env).toContain('STUDIO_RUN_STATUS=failed');
    expect(env).toContain('STUDIO_REJECTION_REASON=QA said no');
    expect(env).toContain('STUDIO_REJECTION_DETAILS=["a","b"]');
    expect(env).toContain('"issue_id":"i1"');
  });

  test('does not run on_failure for a successful run', async () => {
    const { runtime } = makeRuntime([makeTrigger({ on_failure: onFailure })]);
    const emit = captureBus(runtime);

    emit('run-1', { status: 'success', meta: { studio_trigger: 'alpha' } });

    await new Promise(r => setTimeout(r, 100));
    expect(existsSync(outPath())).toBe(false);
  });

  test('does not run on_failure for a run another trigger launched', async () => {
    const { runtime } = makeRuntime([makeTrigger({ on_failure: onFailure })]);
    const emit = captureBus(runtime);

    emit('run-1', { status: 'failed', meta: { studio_trigger: 'beta' } });

    await new Promise(r => setTimeout(r, 100));
    expect(existsSync(outPath())).toBe(false);
  });

  test('does not run on_failure for a run no trigger launched', async () => {
    const { runtime } = makeRuntime([makeTrigger({ on_failure: onFailure })]);
    const emit = captureBus(runtime);

    emit('run-1', { status: 'failed', meta: {} });

    await new Promise(r => setTimeout(r, 100));
    expect(existsSync(outPath())).toBe(false);
  });
});
