import { readdir, readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import type { FastifyInstance } from 'fastify';
import type { ServerDeps } from '../server.js';

export async function contractsRoutes(
  fastify: FastifyInstance,
  options: { deps: ServerDeps }
): Promise<void> {
  const contractsDir = join(options.deps.configsDir, 'contracts');

  // GET /api/contracts
  fastify.get('/contracts', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            contracts: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  }, async (_request, reply) => {
    let entries: string[];
    try {
      entries = await readdir(contractsDir);
    } catch {
      return reply.send({ contracts: [] });
    }
    const contracts = entries
      .filter(f => f.endsWith('.contract.yaml'))
      .map(f => f.slice(0, -'.contract.yaml'.length));
    return reply.send({ contracts });
  });

  // GET /api/contracts/:name
  fastify.get<{ Params: { name: string } }>('/contracts/:name', {
    schema: {
      params: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
  }, async (request, reply) => {
    const filePath = join(contractsDir, `${request.params.name}.contract.yaml`);
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      return reply.status(404).send({ error: 'Contract not found' });
    }
    return reply.send(yaml.load(content));
  });

  // PUT /api/contracts/:name
  fastify.put<{
    Params: { name: string };
    Body: Record<string, unknown>;
  }>('/contracts/:name', {
    schema: {
      params: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      body: { type: 'object' },
    },
  }, async (request, reply) => {
    const body = request.body;

    if (!body['name'] || typeof body['name'] !== 'string') {
      return reply.status(400).send({ error: "Contract must have a 'name' field (string)" });
    }
    if (body['version'] === undefined) {
      return reply.status(400).send({ error: "Contract must have a 'version' field" });
    }

    await mkdir(contractsDir, { recursive: true });
    const filePath = join(contractsDir, `${request.params.name}.contract.yaml`);
    await writeFile(filePath, yaml.dump(body), 'utf-8');

    return reply.send({ name: request.params.name, content: body });
  });
}
