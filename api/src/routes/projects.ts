import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ServerDeps } from '../server.js';

function projectId(configsDir: string): string {
  return createHash('sha256').update(configsDir).digest('hex').slice(0, 12);
}

export async function projectsRoutes(
  fastify: FastifyInstance,
  options: { deps: ServerDeps }
): Promise<void> {
  const { configsDir, projectName } = options.deps;
  const id = projectId(configsDir);

  // GET /api/projects — returns the single project this API serves
  fastify.get('/projects', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            projects: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  pipelines_dir: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  }, async (_request, reply) => {
    return reply.send({
      projects: [
        {
          id,
          name: projectName,
          pipelines_dir: join(configsDir, 'pipelines'),
        },
      ],
    });
  });

  // GET /api/projects/:id/pipelines
  fastify.get<{ Params: { id: string } }>('/projects/:id/pipelines', {
    schema: {
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            pipelines: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  }, async (request, reply) => {
    if (request.params.id !== id) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    const pipelinesDir = join(configsDir, 'pipelines');
    let entries: string[];
    try {
      entries = await readdir(pipelinesDir);
    } catch {
      return reply.send({ pipelines: [] });
    }

    const pipelines = entries
      .filter(f => f.endsWith('.pipeline.yaml'))
      .map(f => f.replace('.pipeline.yaml', ''));

    return reply.send({ pipelines });
  });
}
