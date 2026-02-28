// api/src/integration-runtime.ts
import type { FastifyInstance } from 'fastify';
import type { IntegrationPluginDef } from '@studio/contracts';
import type { IntegrationStore } from './integration-store.js';
import type { RunLauncher } from './launcher.js';
import type { RunEventBus } from './event-bus.js';
import type { ApiConfig } from './server.js';
import { WEBHOOK_HANDLERS, FAILURE_HANDLERS } from './integrations/registry.js';
import type { FailureHandlerContext } from './integrations/types.js';
import type { GroupFeedbackEvent } from '@studio/engine';

export interface IntegrationRuntimeDeps {
  integrations: IntegrationPluginDef[];
  store: IntegrationStore;
  launcher: RunLauncher;
  configsDir: string;
  projectsDir?: string;
  apiConfig: ApiConfig;
  integrationConfigs: Record<string, Record<string, unknown>>;
}

export class IntegrationRuntime {
  constructor(private deps: IntegrationRuntimeDeps) {}

  setupEventBus(bus: RunEventBus): void {
    bus.subscribeAll((runId, event) => {
      if (event.type !== 'pipeline_complete') return;

      const data = event.data as {
        status: string;
        duration_ms: number;
        meta?: Record<string, unknown>;
        last_group_feedback?: GroupFeedbackEvent;
      };

      if (data.status === 'success') return;

      for (const integration of this.deps.integrations) {
        if (!integration.on_failure?.handler) continue;
        const handler = FAILURE_HANDLERS[integration.on_failure.handler];
        if (!handler) continue;

        const ctx: FailureHandlerContext = {
          runId,
          durationMs: data.duration_ms,
          status: data.status,
          meta: data.meta ?? {},
          lastGroupFeedback: data.last_group_feedback,
          integration,
          integrationConfig: this.deps.integrationConfigs[integration.name] ?? {},
        };

        void handler.handleFailure(ctx);
      }
    });
  }

  registerRoutes(fastify: FastifyInstance, prefix: string): void {
    for (const integration of this.deps.integrations) {
      if (!integration.webhook?.handler) continue;
      const webhookHandler = WEBHOOK_HANDLERS[integration.webhook.handler];
      if (!webhookHandler) continue;

      const name = integration.name;
      const { store, launcher, configsDir, projectsDir, apiConfig, integrationConfigs } = this.deps;
      const integrationConfig = integrationConfigs[name] ?? {};
      const errorSchema = { type: 'object', properties: { error: { type: 'string' } } };

      void fastify.register(async (scope) => {
        scope.addContentTypeParser(
          'application/json',
          { parseAs: 'buffer' },
          (_req, body, done) => done(null, body),
        );

        // GET /api/integrations/{name}
        scope.get(`${prefix}/integrations/${name}`, {
          schema: {
            tags: ['integrations'],
            summary: `Get ${name} integration config and trigger log`,
            response: {
              200: {
                type: 'object',
                properties: {
                  webhook_url: { type: 'string' },
                  pipeline: { type: ['string', 'null'] },
                  active: { type: 'boolean' },
                  triggers: { type: 'array' },
                },
              },
            },
          },
        }, async (request, reply) => {
          const config = store.getConfig(name);
          const triggers = store.listTriggers(name, 50);
          const baseUrl = process.env['STUDIO_BASE_URL'] ?? `${request.protocol}://${request.hostname}`;
          return reply.status(200).send({
            webhook_url: `${baseUrl}/api/integrations/${name}/webhook`,
            pipeline: config.pipeline ?? null,
            active: config.active,
            triggers,
          });
        });

        // PATCH /api/integrations/{name}
        scope.patch(`${prefix}/integrations/${name}`, {
          schema: {
            tags: ['integrations'],
            summary: `Update ${name} integration config`,
            body: {
              type: 'object',
              properties: {
                pipeline: { type: 'string' },
                active: { type: 'boolean' },
              },
            },
            response: {
              200: {
                type: 'object',
                properties: {
                  webhook_url: { type: 'string' },
                  pipeline: { type: ['string', 'null'] },
                  active: { type: 'boolean' },
                },
              },
              400: errorSchema,
            },
          },
        }, async (request, reply) => {
          let data: { pipeline?: string; active?: boolean };
          try {
            data = JSON.parse((request.body as Buffer).toString('utf-8')) as typeof data;
          } catch {
            return reply.status(400).send({ error: 'Invalid JSON' });
          }
          store.patchConfig(name, data);
          const updated = store.getConfig(name);
          const baseUrl = process.env['STUDIO_BASE_URL'] ?? `${request.protocol}://${request.hostname}`;
          return reply.status(200).send({
            webhook_url: `${baseUrl}/api/integrations/${name}/webhook`,
            pipeline: updated.pipeline ?? null,
            active: updated.active,
          });
        });

        // POST /api/integrations/{name}/webhook
        scope.post(`${prefix}/integrations/${name}/webhook`, {
          schema: {
            tags: ['integrations'],
            summary: `Receive ${name} webhook event`,
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
            },
          },
        }, async (request, reply) => {
          return webhookHandler.handle({
            rawBody: request.body as Buffer,
            headers: request.headers,
            integration,
            store,
            launcher,
            configsDir,
            projectsDir,
            apiConfig,
            integrationConfig,
          }, reply);
        });
      });
    }
  }
}
