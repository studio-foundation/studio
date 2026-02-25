import { readdir, readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import type { FastifyInstance } from 'fastify';
import type { ServerDeps } from '../server.js';

export async function agentsRoutes(
  fastify: FastifyInstance,
  options: { deps: ServerDeps }
): Promise<void> {
  const agentsDir = join(options.deps.configsDir, 'agents');

  const errorSchema = { type: 'object', properties: { error: { type: 'string' } } };

  // GET /api/agents
  fastify.get('/agents', {
    schema: {
      tags: ['agents'],
      summary: 'List all agent names',
      response: {
        200: {
          type: 'object',
          properties: {
            agents: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  }, async (_request, reply) => {
    let entries: string[];
    try {
      entries = await readdir(agentsDir);
    } catch {
      return reply.send({ agents: [] });
    }
    const agents = entries
      .filter(f => f.endsWith('.agent.yaml'))
      .map(f => f.slice(0, -'.agent.yaml'.length));
    return reply.send({ agents });
  });

  // GET /api/agents/:name
  fastify.get<{ Params: { name: string } }>('/agents/:name', {
    schema: {
      tags: ['agents'],
      summary: 'Get an agent by name',
      params: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      response: {
        200: { type: 'object', additionalProperties: true },
        404: errorSchema,
      },
    },
  }, async (request, reply) => {
    const filePath = join(agentsDir, `${request.params.name}.agent.yaml`);
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      return reply.status(404).send({ error: 'Agent not found' });
    }
    return reply.send(yaml.load(content));
  });

  // PUT /api/agents/:name
  fastify.put<{
    Params: { name: string };
    Body: Record<string, unknown>;
  }>('/agents/:name', {
    schema: {
      tags: ['agents'],
      summary: 'Create or update an agent',
      params: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      body: { type: 'object' },
      response: {
        200: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            content: { type: 'object', additionalProperties: true },
          },
        },
        400: errorSchema,
      },
    },
  }, async (request, reply) => {
    const body = request.body;

    if (!body['name'] || typeof body['name'] !== 'string') {
      return reply.status(400).send({ error: "Agent must have a 'name' field (string)" });
    }

    await mkdir(agentsDir, { recursive: true });
    const filePath = join(agentsDir, `${request.params.name}.agent.yaml`);
    await writeFile(filePath, yaml.dump(body), 'utf-8');

    return reply.send({ name: request.params.name, content: body });
  });

  // DELETE /api/agents/:name
  fastify.delete<{ Params: { name: string } }>('/agents/:name', {
    schema: {
      tags: ['agents'],
      summary: 'Delete an agent',
      params: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      response: {
        204: { type: 'null', description: 'No content' },
        404: errorSchema,
      },
    },
  }, async (request, reply) => {
    const filePath = join(agentsDir, `${request.params.name}.agent.yaml`);
    try {
      await unlink(filePath);
    } catch {
      return reply.status(404).send({ error: 'Agent not found' });
    }
    return reply.status(204).send();
  });
}
