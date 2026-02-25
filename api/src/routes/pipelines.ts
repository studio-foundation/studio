import { readdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';
import type { FastifyInstance } from 'fastify';
import type { ServerDeps } from '../server.js';

function pipelinePath(configsDir: string, name: string): string {
  return join(configsDir, 'pipelines', `${name}.pipeline.yaml`);
}

export async function pipelinesRoutes(
  fastify: FastifyInstance,
  options: { deps: ServerDeps }
): Promise<void> {
  const { configsDir } = options.deps;

  // GET /api/pipelines — list all pipeline names
  fastify.get('/pipelines', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            pipelines: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  }, async (_request, reply) => {
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

  // GET /api/pipelines/:name — read a pipeline (YAML parsed to JSON)
  fastify.get<{ Params: { name: string } }>('/pipelines/:name', {
    schema: {
      params: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      response: {
        200: { type: 'object', additionalProperties: true },
        404: {
          type: 'object',
          properties: { error: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params;
    let content: string;
    try {
      content = await readFile(pipelinePath(configsDir, name), 'utf-8');
    } catch {
      return reply.status(404).send({ error: `Pipeline '${name}' not found` });
    }
    const parsed = yaml.load(content);
    return reply.send(parsed);
  });

  // PUT /api/pipelines/:name — create or update a pipeline (YAML or JSON body)
  fastify.put<{ Params: { name: string }; Body: unknown }>(
    '/pipelines/:name',
    {
      schema: {
        params: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
        response: {
          200: {
            type: 'object',
            properties: { name: { type: 'string' } },
          },
          400: {
            type: 'object',
            properties: { error: { type: 'string' } },
          },
        },
      },
    },
    async (request, reply) => {
      const { name } = request.params;
      const contentType = request.headers['content-type'] ?? '';

      let yamlContent: string;
      if (contentType.includes('application/json')) {
        yamlContent = yaml.dump(request.body);
      } else {
        yamlContent = request.body as string;
      }

      try {
        yaml.load(yamlContent);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid YAML';
        return reply.status(400).send({ error: message });
      }

      await writeFile(pipelinePath(configsDir, name), yamlContent, 'utf-8');
      return reply.send({ name });
    }
  );

  // DELETE /api/pipelines/:name — delete a pipeline
  fastify.delete<{ Params: { name: string } }>('/pipelines/:name', {
    schema: {
      params: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      response: {
        200: {
          type: 'object',
          properties: { deleted: { type: 'string' } },
        },
        404: {
          type: 'object',
          properties: { error: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params;
    try {
      await unlink(pipelinePath(configsDir, name));
    } catch {
      return reply.status(404).send({ error: `Pipeline '${name}' not found` });
    }
    return reply.send({ deleted: name });
  });
}
