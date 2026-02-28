// Fastify server builder — takes deps via injection for testability
// buildServer(deps) → FastifyInstance, ready to listen

import Fastify from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { RunStore } from '@studio/engine';
import type { RunLauncher } from './launcher.js';
import type { WebhookStore } from './webhook-store.js';
import { runsRoutes } from './routes/runs.js';
import { projectsRoutes } from './routes/projects.js';
import { contractsRoutes } from './routes/contracts.js';
import { pipelinesRoutes } from './routes/pipelines.js';
import { toolsRoutes } from './routes/tools.js';
import { agentsRoutes } from './routes/agents.js';
import { configRoutes } from './routes/config.js';
import { skillsRoutes } from './routes/skills.js';
import { validateRoutes } from './routes/validate.js';
import { webhooksRoutes } from './routes/webhooks.js';
import { linearWebhookRoute } from './routes/linear-webhook.js';

export interface ApiConfig {
  key?: string;
  port?: number;
  linear_webhook_secret?: string;
}

export type MaskedConfig = {
  defaults?: { provider?: string; model?: string };
  providers: string[];
};

export interface ServerDeps {
  store: RunStore;
  launcher: RunLauncher;
  configsDir: string;
  projectName: string;
  apiConfig: ApiConfig;
  studioVersion: string;
  maskedConfig: MaskedConfig;
  webhookStore: WebhookStore;
}

export function buildServer(deps: ServerDeps) {
  const fastify = Fastify({ logger: false });

  // Register text/plain parser so PUT routes that accept YAML bodies work correctly.
  // Without this, Fastify v5 cannot parse text/plain and body validation fails with 400.
  fastify.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });

  void fastify.register(cors, { origin: true });

  if (process.env['NODE_ENV'] !== 'production') {
    void fastify.register(swagger, {
      openapi: {
        info: {
          title: 'Studio API',
          description: 'REST API for Studio pipeline orchestration',
          version: '1.0.0',
        },
      },
    });
    void fastify.register(swaggerUi, {
      routePrefix: '/api/docs',
    });
  }

  // Auth hook — only active if api key is configured
  // Skips /api/integrations/* routes (they use their own auth mechanism, e.g. HMAC)
  if (deps.apiConfig.key) {
    const expectedKey = deps.apiConfig.key;
    fastify.addHook('onRequest', async (request, reply) => {
      const path = request.url.split('?')[0];
      if (path.startsWith('/api/integrations/')) return;
      const auth = request.headers['authorization'];
      if (!auth || auth !== `Bearer ${expectedKey}`) {
        await reply.status(401).send({ error: 'Unauthorized' });
      }
    });
  }

  void fastify.register(runsRoutes, { prefix: '/api', deps });
  void fastify.register(projectsRoutes, { prefix: '/api', deps });
  void fastify.register(contractsRoutes, { prefix: '/api', deps });
  void fastify.register(pipelinesRoutes, { prefix: '/api', deps });
  void fastify.register(toolsRoutes, { prefix: '/api', deps });
  void fastify.register(agentsRoutes, { prefix: '/api', deps });
  void fastify.register(configRoutes, { prefix: '/api', deps });
  void fastify.register(skillsRoutes, { prefix: '/api', deps });
  void fastify.register(validateRoutes, { prefix: '/api', deps });
  void fastify.register(webhooksRoutes, { prefix: '/api', deps });
  void fastify.register(linearWebhookRoute, { prefix: '/api', deps });

  return fastify;
}
