// Fastify server builder — takes deps via injection for testability
// buildServer(deps) → FastifyInstance, ready to listen

import Fastify from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { RunStore } from '@studio/engine';
import type { RunLauncher } from './launcher.js';
import { runsRoutes } from './routes/runs.js';
import { projectsRoutes } from './routes/projects.js';
import { pipelinesRoutes } from './routes/pipelines.js';

export interface ApiConfig {
  key?: string;
  port?: number;
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
}

export function buildServer(deps: ServerDeps) {
  const fastify = Fastify({ logger: false });

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
  if (deps.apiConfig.key) {
    const expectedKey = deps.apiConfig.key;
    fastify.addHook('onRequest', async (request, reply) => {
      const auth = request.headers['authorization'];
      if (!auth || auth !== `Bearer ${expectedKey}`) {
        await reply.status(401).send({ error: 'Unauthorized' });
      }
    });
  }

  void fastify.register(runsRoutes, { prefix: '/api', deps });
  void fastify.register(projectsRoutes, { prefix: '/api', deps });
  void fastify.register(pipelinesRoutes, { prefix: '/api', deps });

  return fastify;
}
