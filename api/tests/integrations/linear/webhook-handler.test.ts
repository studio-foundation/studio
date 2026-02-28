import { describe, test, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { LinearWebhookHandler } from '../../../src/integrations/linear/webhook-handler.js';
import { IntegrationStore } from '../../../src/integration-store.js';
import type { IntegrationPluginDef } from '@studio/contracts';

const WEBHOOK_SECRET = 'test-secret-abc';

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
}

function makeInProgressBody(overrides: Record<string, unknown> = {}) {
  return {
    type: 'Issue', action: 'update',
    data: {
      id: 'abc-123', identifier: 'STU-42', title: 'Add dark mode',
      description: 'Users want dark mode.', state: { name: 'In Progress' },
      ...overrides,
    },
  };
}

function makeContext(opts: {
  withSecret?: boolean;
  active?: boolean;
  body?: object;
  signatureOverride?: string;
} = {}) {
  const dir = resolve('/tmp', `.studio-wh-handler-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const store = new IntegrationStore(resolve(dir, 'runs.db'));
  store.patchConfig('linear', { active: opts.active ?? true });

  const launched: Array<{ pipeline: string; input: Record<string, unknown>; meta?: Record<string, unknown> }> = [];
  const launcher = {
    launch: vi.fn(async (cfg: { pipeline: string; input: Record<string, unknown>; meta?: Record<string, unknown>; runId: string }) => {
      launched.push({ pipeline: cfg.pipeline, input: cfg.input, meta: cfg.meta });
      return { run_id: cfg.runId };
    }),
    cancel: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
  };

  const bodyObj = opts.body ?? makeInProgressBody();
  const bodyStr = JSON.stringify(bodyObj);
  const rawBody = Buffer.from(bodyStr);

  const integration: IntegrationPluginDef = {
    name: 'linear',
    version: 1,
    webhook: {
      ...(opts.withSecret ? { hmac: { header: 'linear-signature', secret_env: 'LINEAR_WEBHOOK_SECRET' } } : {}),
      handler: 'linear-webhook',
    },
  };

  const headers: Record<string, string | undefined> = { 'content-type': 'application/json' };
  if (opts.signatureOverride !== undefined) {
    headers['linear-signature'] = opts.signatureOverride;
  } else if (opts.withSecret) {
    headers['linear-signature'] = sign(bodyStr, WEBHOOK_SECRET);
  }

  const ctx = {
    rawBody,
    headers,
    integration,
    store,
    launcher,
    configsDir: dir,
    projectsDir: undefined,
    apiConfig: {},
    integrationConfig: opts.withSecret ? { LINEAR_WEBHOOK_SECRET: WEBHOOK_SECRET } : {},
  };

  const reply = {
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };

  return { ctx, reply, launched, store, cleanup: () => store.close() };
}

describe('LinearWebhookHandler', () => {
  const handler = new LinearWebhookHandler();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('accepts "In Progress" transition and launches pipeline', async () => {
    const { ctx, reply, launched, cleanup } = makeContext();
    await handler.handle(ctx as never, reply as never);

    expect(reply.status).toHaveBeenCalledWith(202);
    expect(launched).toHaveLength(1);
    expect(launched[0].pipeline).toBe('feature-builder');
    expect(launched[0].input['brief_summary']).toBe('STU-42 — Add dark mode');
    expect(launched[0].input['description']).toBe('Users want dark mode.');
    expect(launched[0].meta?.['linear_issue_id']).toBe('abc-123');
    expect(launched[0].meta?.['linear_issue_identifier']).toBe('STU-42');
    expect(launched[0].meta?.['linear_issue_url']).toBe('https://linear.app/studioag/issue/STU-42');

    // Check that a trigger record was stored
    const triggers = ctx.store.listTriggers('linear');
    expect(triggers).toHaveLength(1);
    expect(triggers[0].status).toBe('success');
    expect(triggers[0].external_id).toBe('abc-123');

    cleanup();
  });

  test('ignores non-"In Progress" state', async () => {
    const { ctx, reply, launched, cleanup } = makeContext({
      body: makeInProgressBody({ state: { name: 'Done' } }),
    });
    await handler.handle(ctx as never, reply as never);

    expect(reply.status).toHaveBeenCalledWith(200);
    const sendArg = (reply.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as { ignored: boolean; reason: string };
    expect(sendArg.ignored).toBe(true);
    expect(sendArg.reason).toContain('Done');
    expect(launched).toHaveLength(0);
    cleanup();
  });

  test('ignores non-update actions', async () => {
    const { ctx, reply, launched, cleanup } = makeContext({
      body: { ...makeInProgressBody(), action: 'create' },
    });
    await handler.handle(ctx as never, reply as never);
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(launched).toHaveLength(0);
    cleanup();
  });

  test('ignores when integration is inactive', async () => {
    const { ctx, reply, launched, cleanup } = makeContext({ active: false });
    await handler.handle(ctx as never, reply as never);
    expect(reply.status).toHaveBeenCalledWith(200);
    const sendArg = (reply.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as { reason: string };
    expect(sendArg.reason).toContain('inactive');
    expect(launched).toHaveLength(0);
    cleanup();
  });

  test('accepts valid HMAC signature', async () => {
    const { ctx, reply, launched, cleanup } = makeContext({ withSecret: true });
    await handler.handle(ctx as never, reply as never);
    expect(reply.status).toHaveBeenCalledWith(202);
    expect(launched).toHaveLength(1);
    cleanup();
  });

  test('rejects invalid HMAC signature', async () => {
    const { ctx, reply, cleanup } = makeContext({ withSecret: true, signatureOverride: 'deadbeef' });
    await handler.handle(ctx as never, reply as never);
    expect(reply.status).toHaveBeenCalledWith(401);
    cleanup();
  });

  test('rejects missing signature header when HMAC configured', async () => {
    const { ctx, reply, cleanup } = makeContext({ withSecret: true, signatureOverride: undefined });
    // Remove the auto-added signature to simulate missing header
    delete (ctx.headers as Record<string, unknown>)['linear-signature'];
    await handler.handle(ctx as never, reply as never);
    expect(reply.status).toHaveBeenCalledWith(401);
    cleanup();
  });

  test('returns 400 for invalid JSON', async () => {
    const dir = resolve('/tmp', `.studio-wh-json-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const store = new IntegrationStore(resolve(dir, 'runs.db'));
    store.patchConfig('linear', { active: true });
    const launcher = { launch: vi.fn(), cancel: vi.fn(), subscribe: vi.fn(() => () => {}) };
    const ctx = {
      rawBody: Buffer.from('not-json{'),
      headers: {},
      integration: { name: 'linear', version: 1, webhook: { handler: 'linear-webhook' } },
      store, launcher, configsDir: dir, projectsDir: undefined, apiConfig: {}, integrationConfig: {},
    };
    const reply = { status: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis() };
    await handler.handle(ctx as never, reply as never);
    expect(reply.status).toHaveBeenCalledWith(400);
    store.close();
  });
});
