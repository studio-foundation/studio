import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ServerDeps } from '../server.js';

function projectId(configsDir: string): string {
  return createHash('sha256').update(configsDir).digest('hex').slice(0, 12);
}

async function listResources(dir: string, suffix: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries
      .filter(f => f.endsWith(suffix))
      .map(f => f.slice(0, -suffix.length));
  } catch {
    return [];
  }
}

export async function projectsRoutes(
  fastify: FastifyInstance,
  options: { deps: ServerDeps }
): Promise<void> {
  const { configsDir, projectName, studioVersion, maskedConfig } = options.deps;
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
  // GET /api/projects/:id/inputs
  fastify.get<{ Params: { id: string } }>('/projects/:id/inputs', {
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
            inputs: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  }, async (request, reply) => {
    if (request.params.id !== id) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    const inputsDir = join(configsDir, 'inputs');
    let entries: string[];
    try {
      entries = await readdir(inputsDir);
    } catch {
      return reply.send({ inputs: [] });
    }

    const inputs = entries
      .filter(f => f.endsWith('.input.yaml'))
      .map(f => f.replace('.input.yaml', ''));

    return reply.send({ inputs });
  });


  // GET /api/projects/:id/inputs/:name — read an input file (YAML parsed to JSON)
  fastify.get<{ Params: { id: string; name: string } }>('/projects/:id/inputs/:name', {
    schema: {
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
        },
        required: ['id', 'name'],
      },
    },
  }, async (request, reply) => {
    if (request.params.id !== id) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    const filePath = join(configsDir, 'inputs', `${request.params.name}.input.yaml`);
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      return reply.status(404).send({ error: 'Input not found' });
    }
    return reply.send(yaml.load(content));
  });

  // GET /api/project — full introspection of the current Studio project
  fastify.get('/project', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            studio_version: { type: 'string' },
            studio_dir: { type: 'string' },
            config: {
              type: 'object',
              properties: {
                defaults: {
                  type: 'object',
                  properties: {
                    provider: { type: 'string' },
                    model: { type: 'string' },
                  },
                },
                providers: { type: 'array', items: { type: 'string' } },
              },
            },
            pipelines: { type: 'array', items: { type: 'string' } },
            contracts: { type: 'array', items: { type: 'string' } },
            agents: { type: 'array', items: { type: 'string' } },
            tools: { type: 'array', items: { type: 'string' } },
            skills: { type: 'array', items: { type: 'string' } },
            inputs: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  }, async (_request, reply) => {
    const [pipelines, contracts, agents, tools, skills, inputs] = await Promise.all([
      listResources(join(configsDir, 'pipelines'), '.pipeline.yaml'),
      listResources(join(configsDir, 'contracts'), '.contract.yaml'),
      listResources(join(configsDir, 'agents'), '.agent.yaml'),
      listResources(join(configsDir, 'tools'), '.tool.yaml'),
      listResources(join(configsDir, 'skills'), '.skill.md'),
      listResources(join(configsDir, 'inputs'), '.input.yaml'),
    ]);

    return reply.send({
      studio_version: studioVersion,
      studio_dir: configsDir,
      config: maskedConfig,
      pipelines,
      contracts,
      agents,
      tools,
      skills,
      inputs,
    });
  });
}
