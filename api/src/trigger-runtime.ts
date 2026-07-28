// api/src/trigger-runtime.ts
// Serves `.studio/triggers/*.trigger.yaml`: one webhook endpoint per trigger that
// verifies the signature, matches the payload, launches a run, and reports back
// when that run does not succeed. Names no external product — everything specific
// to one lives in its YAML.

import { exec } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TriggerDef } from '@studio-foundation/contracts';
import { loadPipelineByName } from '@studio-foundation/engine';
import type { GroupFeedbackEvent } from '@studio-foundation/engine';
import { resolveRepoPath } from './utils/repo-resolver.js';
import type { TriggerStore } from './trigger-store.js';
import type { RunLauncher } from './launcher.js';
import type { RunEventBus } from './event-bus.js';
import { verifyHmac, matchesPayload, renderTemplate } from './triggers/webhook.js';

const execAsync = promisify(exec);
const DEFAULT_FAILURE_TIMEOUT_MS = 30_000;

/** Meta key recording which trigger launched a run, so on_failure reaches only it. */
const TRIGGER_META_KEY = 'studio_trigger';

export interface TriggerRuntimeDeps {
  triggers: TriggerDef[];
  store: TriggerStore;
  launcher: RunLauncher;
  configsDir: string;
  triggersDir: string;
  projectsDir?: string;
}

export class TriggerRuntime {
  constructor(private deps: TriggerRuntimeDeps) {}

  setupEventBus(bus: RunEventBus): void {
    bus.subscribeAll((runId, event) => {
      if (event.type !== 'pipeline_complete') return;

      const data = event.data as {
        status: string;
        meta?: Record<string, unknown>;
        last_group_feedback?: GroupFeedbackEvent;
      };
      if (data.status === 'success') return;

      const meta = data.meta ?? {};
      const trigger = this.deps.triggers.find(t => t.name === meta[TRIGGER_META_KEY]);
      if (!trigger?.on_failure) return;

      void this.runFailureCommand(trigger, runId, data.status, meta, data.last_group_feedback);
    });
  }

  /**
   * Values reach the command through the environment rather than the command
   * string: they come from a webhook payload, and interpolating them into a
   * shell command would make the sender able to run anything.
   */
  private async runFailureCommand(
    trigger: TriggerDef,
    runId: string,
    status: string,
    meta: Record<string, unknown>,
    feedback: GroupFeedbackEvent | undefined,
  ): Promise<void> {
    const onFailure = trigger.on_failure;
    if (!onFailure) return;

    try {
      await execAsync(onFailure.command, {
        cwd: this.deps.triggersDir,
        timeout: onFailure.timeout_ms ?? DEFAULT_FAILURE_TIMEOUT_MS,
        env: {
          ...process.env,
          STUDIO_TRIGGER: trigger.name,
          STUDIO_RUN_ID: runId,
          STUDIO_RUN_STATUS: status,
          STUDIO_META: JSON.stringify(meta),
          STUDIO_REJECTION_REASON: feedback?.rejection_reason ?? '',
          STUDIO_REJECTION_DETAILS: JSON.stringify(feedback?.rejection_details ?? []),
        },
      });
    } catch (err) {
      console.error(`[trigger:${trigger.name}] on_failure command failed:`, err);
    }
  }

  private async handleWebhook(
    trigger: TriggerDef,
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    reply: FastifyReply,
  ): Promise<unknown> {
    // The loader refuses an hmac block with no secret, so declaring one always verifies.
    const hmac = trigger.webhook?.hmac;
    if (hmac) {
      const signature = headers[hmac.header];
      if (typeof signature !== 'string') {
        return reply.status(401).send({ error: `Missing ${hmac.header} header` });
      }
      if (!verifyHmac(rawBody, signature, hmac.secret)) {
        return reply.status(401).send({ error: 'Invalid signature' });
      }
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf-8'));
    } catch {
      return reply.status(400).send({ error: 'Invalid JSON' });
    }

    if (!matchesPayload(trigger, payload)) {
      return reply.status(200).send({ ignored: true, reason: 'payload did not match when:' });
    }

    const { store, launcher, configsDir, projectsDir } = this.deps;
    const pipeline = trigger.pipeline;

    // Resolve the repo from the pipeline YAML — mirrors CLI behaviour. A pipeline
    // that fails to load falls through; launcher.launch() reports it properly.
    let repoUrl: string | undefined;
    let repoBranch: string | undefined;
    try {
      const pipelineDef = await loadPipelineByName(pipeline, join(configsDir, 'pipelines'));
      repoUrl = pipelineDef.repo?.url;
      repoBranch = pipelineDef.repo?.branch;
    } catch {
      // Reported by launcher.launch() below
    }

    let repoPath: string;
    try {
      repoPath = await resolveRepoPath({
        repoUrl,
        rawProjectsDir: projectsDir,
        pipelineName: pipeline,
        branch: repoBranch,
      });
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }

    const input = renderTemplate(trigger.input, payload);
    const meta = { ...renderTemplate(trigger.meta, payload), [TRIGGER_META_KEY]: trigger.name };
    const log = renderTemplate(trigger.log, payload);

    const runId = randomUUID();
    const record = {
      id: randomUUID(),
      trigger_name: trigger.name,
      received_at: new Date().toISOString(),
      ...(log['external_id'] ? { external_id: String(log['external_id']) } : {}),
      ...(log['external_label'] ? { external_label: String(log['external_label']) } : {}),
      ...(log['external_url'] ? { external_url: String(log['external_url']) } : {}),
      pipeline,
      run_id: runId,
    };

    try {
      await launcher.launch({ runId, pipeline, input, configsDir, repoPath, meta });
    } catch (err) {
      store.insert({ ...record, status: 'failed' });
      throw err;
    }

    store.insert({ ...record, status: 'success' });
    return reply.status(202).send({ run_id: runId, stream_url: `/api/runs/${runId}/stream` });
  }

  registerRoutes(fastify: FastifyInstance, prefix: string): void {
    const { triggers, store } = this.deps;
    if (triggers.length === 0) return;

    const byName = new Map(triggers.map(t => [t.name, t]));
    const errorSchema = { type: 'object', properties: { error: { type: 'string' } } };

    void fastify.register(async (scope) => {
      scope.addContentTypeParser(
        'application/json',
        { parseAs: 'buffer' },
        (_req, body, done) => done(null, body),
      );

      scope.get(`${prefix}/triggers/:name`, {
        schema: {
          tags: ['triggers'],
          summary: 'Get a trigger and its recent deliveries',
          params: { type: 'object', properties: { name: { type: 'string' } } },
          response: {
            200: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                pipeline: { type: 'string' },
                webhook_url: { type: 'string' },
                deliveries: { type: 'array' },
              },
            },
            404: errorSchema,
          },
        },
      }, async (request, reply) => {
        const { name } = request.params as { name: string };
        const trigger = byName.get(name);
        if (!trigger) return reply.status(404).send({ error: `Trigger '${name}' not found` });

        const baseUrl = process.env['STUDIO_BASE_URL'] ?? `${request.protocol}://${request.hostname}`;
        return reply.status(200).send({
          name: trigger.name,
          pipeline: trigger.pipeline,
          webhook_url: `${baseUrl}${prefix}/triggers/${name}/webhook`,
          deliveries: store.list(name, 50),
        });
      });

      scope.post(`${prefix}/triggers/:name/webhook`, {
        schema: {
          tags: ['triggers'],
          summary: 'Receive a webhook delivery for a trigger',
          params: { type: 'object', properties: { name: { type: 'string' } } },
          response: {
            202: {
              type: 'object',
              properties: { run_id: { type: 'string' }, stream_url: { type: 'string' } },
            },
            200: {
              type: 'object',
              properties: { ignored: { type: 'boolean' }, reason: { type: 'string' } },
            },
            400: errorSchema,
            401: errorSchema,
            404: errorSchema,
          },
        },
      }, async (request, reply) => {
        const { name } = request.params as { name: string };
        const trigger = byName.get(name);
        if (!trigger) return reply.status(404).send({ error: `Trigger '${name}' not found` });

        return this.handleWebhook(trigger, request.body as Buffer, request.headers, reply);
      });
    });
  }
}
