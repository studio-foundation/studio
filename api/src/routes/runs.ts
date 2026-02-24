import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ServerDeps } from '../server.js';

export async function runsRoutes(
  fastify: FastifyInstance,
  options: { deps: ServerDeps }
): Promise<void> {
  const { store, launcher } = options.deps;

  // POST /api/runs — fire-and-forget
  fastify.post<{
    Body: { pipeline: string; input: Record<string, unknown>; provider?: string };
  }>('/runs', {
    schema: {
      body: {
        type: 'object',
        required: ['pipeline', 'input'],
        properties: {
          pipeline: { type: 'string' },
          input: { type: 'object' },
          provider: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { pipeline, input, provider } = request.body;
    const runId = randomUUID();

    const { run_id } = await launcher.launch({
      runId,
      pipeline,
      input,
      configsDir: options.deps.configsDir,
      providerOverride: provider,
    });

    return reply.status(201).send({
      run_id,
      status: 'running',
      stream_url: `/api/runs/${run_id}/stream`,
    });
  });

  // GET /api/runs
  fastify.get<{
    Querystring: { status?: string; limit?: string };
  }>('/runs', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          limit: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { status, limit } = request.query;
    const runs = store.listPipelineRuns({
      status,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    return reply.send({ runs });
  });

  // GET /api/runs/:id
  fastify.get<{ Params: { id: string } }>('/runs/:id', async (request, reply) => {
    const run = store.getPipelineRun(request.params.id);
    if (!run) {
      return reply.status(404).send({ error: 'Run not found' });
    }
    return reply.send(run);
  });

  // GET /api/runs/:id/logs
  fastify.get<{ Params: { id: string } }>('/runs/:id/logs', async (request, reply) => {
    const { id } = request.params;

    const run = store.getPipelineRun(id);
    if (!run) {
      return reply.status(404).send({ error: 'Run not found' });
    }

    const logPath = store.getLogPath(id);
    if (!logPath) {
      return reply.status(404).send({ error: 'Log not yet available' });
    }

    let content: string;
    try {
      content = await readFile(logPath, 'utf-8');
    } catch {
      return reply.status(404).send({ error: 'Log file not found' });
    }

    return reply.type('text/plain').send(content);
  });
}
