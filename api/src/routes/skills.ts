import { readdir, readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ServerDeps } from '../server.js';

export async function skillsRoutes(
  fastify: FastifyInstance,
  options: { deps: ServerDeps }
): Promise<void> {
  const skillsDir = join(options.deps.configsDir, 'skills');

  // GET /api/skills
  fastify.get('/skills', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            skills: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  }, async (_request, reply) => {
    let entries: string[];
    try {
      entries = await readdir(skillsDir);
    } catch {
      return reply.send({ skills: [] });
    }
    const skills = entries
      .filter(f => f.endsWith('.skill.md'))
      .map(f => f.slice(0, -'.skill.md'.length));
    return reply.send({ skills });
  });

  // GET /api/skills/:name
  fastify.get<{ Params: { name: string } }>('/skills/:name', {
    schema: {
      params: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            content: { type: 'string' },
          },
        },
        404: {
          type: 'object',
          properties: { error: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    const filePath = join(skillsDir, `${request.params.name}.skill.md`);
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      return reply.status(404).send({ error: 'Skill not found' });
    }
    return reply.send({ name: request.params.name, content });
  });

  // PUT /api/skills/:name
  fastify.put<{
    Params: { name: string };
    Body: Record<string, unknown>;
  }>('/skills/:name', {
    schema: {
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
            content: { type: 'string' },
          },
        },
        400: {
          type: 'object',
          properties: { error: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    const { content } = request.body;

    if (typeof content !== 'string') {
      return reply.status(400).send({ error: "Skill must have a 'content' field (string)" });
    }

    await mkdir(skillsDir, { recursive: true });
    const filePath = join(skillsDir, `${request.params.name}.skill.md`);
    await writeFile(filePath, content, 'utf-8');

    return reply.send({ name: request.params.name, content });
  });

  // DELETE /api/skills/:name
  fastify.delete<{ Params: { name: string } }>('/skills/:name', {
    schema: {
      params: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
  }, async (request, reply) => {
    const filePath = join(skillsDir, `${request.params.name}.skill.md`);
    try {
      await unlink(filePath);
    } catch {
      return reply.status(404).send({ error: 'Skill not found' });
    }
    return reply.status(204).send();
  });
}
