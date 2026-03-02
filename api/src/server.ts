// Fastify server builder — takes deps via injection for testability
// buildServer(deps) → FastifyInstance, ready to listen

import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { AnyRunStore } from '@studio/engine';
import type { RunLauncher } from './launcher.js';
import type { WebhookStore } from './webhook-store.js';
import type { IntegrationStore } from './integration-store.js';
import type { IntegrationRuntime } from './integration-runtime.js';
import type { UserStore } from './user-store.js';
import type { PgUserStore } from './user-store-pg.js';
import { getPlanLimits, DEFAULT_PLANS, type PlansConfig } from './plans.js';
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

export interface ApiConfig {
  key?: string;
  port?: number;
}

export type MaskedConfig = {
  defaults?: { provider?: string; model?: string };
  providers: string[];
};

export interface ServerDeps {
  store: AnyRunStore;
  launcher: RunLauncher;
  configsDir: string;
  /** Raw projects_dir from config (may contain ~). Used by route handlers for repo cloning. */
  projectsDir?: string;
  projectName: string;
  apiConfig: ApiConfig;
  studioVersion: string;
  maskedConfig: MaskedConfig;
  webhookStore: WebhookStore;
  integrationStore: IntegrationStore;
  integrationRuntime: IntegrationRuntime;
  userStore?: UserStore | PgUserStore;
  plans?: PlansConfig;
  /** true when at least one user exists in the DB — computed at bootstrap time to avoid per-request DB calls */
  hasUsers?: boolean;
}

// request.user type augmentation for Fastify
declare module 'fastify' {
  interface FastifyRequest {
    user?: import('./user-store.js').User;
  }
}

export function buildServer(deps: ServerDeps) {
  const fastify = Fastify({ logger: false });

  // Register text/plain parser so PUT routes that accept YAML bodies work correctly.
  // Without this, Fastify v5 cannot parse text/plain and body validation fails with 400.
  fastify.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });

  void fastify.register(cors, { origin: true });

  void fastify.register(rateLimit, {
    global: true,
    max: (req: FastifyRequest) => {
      const planName = req.user?.plan ?? 'free';
      const plans = deps.plans ?? DEFAULT_PLANS;
      return getPlanLimits(plans, planName).rate_limit_per_minute;
    },
    timeWindow: '1 minute',
    keyGenerator: (req: FastifyRequest) => req.user?.id ?? req.ip ?? 'anonymous',
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
    },
    allowList: (req: FastifyRequest) => req.url.startsWith('/api/integrations/'),
  });

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

  // Auth hook — supports three modes:
  //   1. Multi-user: userStore provided + hasUsers=true → lookup by api_key
  //   2. Legacy single-key: hasUsers=false + api.key configured → Bearer check
  //   3. Open/dev: no users, no api.key → allow all (local dev only)
  fastify.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (path.startsWith('/api/integrations/')) return;

    const auth = request.headers['authorization'];
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;

    if (deps.userStore && deps.hasUsers) {
      // Multi-user mode: look up user by api_key
      const user = token ? await deps.userStore.getUserByApiKey(token) : null;
      if (!user) {
        await reply.status(401).send({ error: 'Unauthorized' });
        return;
      }
      request.user = user;
      return;
    }

    // Legacy single-key mode
    if (deps.apiConfig.key) {
      if (!auth || auth !== `Bearer ${deps.apiConfig.key}`) {
        await reply.status(401).send({ error: 'Unauthorized' });
      }
      return;
    }

    // No userStore with users, no api.key → open (local dev)
  });

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
  deps.integrationRuntime.registerRoutes(fastify, '/api');

  return fastify;
}
