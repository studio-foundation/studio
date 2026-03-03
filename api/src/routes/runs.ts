import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ServerDeps } from '../server.js';
import { resolveRepoPath } from '../utils/repo-resolver.js';
import { loadPipelineByName } from '@studio/engine';

async function replayJsonl(
  logPath: string,
  send: (type: string, data: unknown) => void,
): Promise<void> {
  let content: string;
  try {
    content = await readFile(logPath, 'utf-8');
  } catch {
    return; // log not yet written or missing
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { event?: string } & Record<string, unknown>;
      if (parsed.event) send(parsed.event, parsed);
    } catch {
      // skip malformed lines
    }
  }
}

const stageRunSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    stage_name: { type: 'string' },
    status: { type: 'string' },
    started_at: { type: 'string' },
    completed_at: { type: 'string' },
    tasks: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
};

const pipelineRunSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    pipeline_name: { type: 'string' },
    status: { type: 'string', enum: ['pending', 'running', 'success', 'failed', 'rejected', 'skipped', 'cancelled'] },
    started_at: { type: 'string' },
    completed_at: { type: 'string' },
    stages: { type: 'array', items: stageRunSchema },
    parent_run_id: { type: 'string' },
  },
};

const errorSchema = { type: 'object', properties: { error: { type: 'string' } } };

export async function runsRoutes(
  fastify: FastifyInstance,
  options: { deps: ServerDeps }
): Promise<void> {
  const { store, launcher } = options.deps;

  // Shared cancel handler — used by both POST /runs/:id/cancel and DELETE /runs/:id
  const handleCancel = async (id: string, reply: FastifyReply): Promise<unknown> => {
    const run = await store.getPipelineRun(id);
    if (!run) {
      return reply.status(404).send({ error: 'Run not found' });
    }
    if (run.status !== 'running') {
      return reply.status(409).send({ error: `Run is not cancellable (status: ${run.status})` });
    }
    await launcher.cancel(id);
    return reply.send({ run_id: id });
  };

  // POST /api/runs — fire-and-forget
  fastify.post<{
    Body: { pipeline: string; input: Record<string, unknown>; provider?: string };
  }>('/runs', {
    schema: {
      tags: ['runs'],
      summary: 'Start a pipeline run',
      body: {
        type: 'object',
        required: ['pipeline', 'input'],
        properties: {
          pipeline: { type: 'string' },
          input: {
            type: 'object',
            description: 'Pipeline input. If input contains "repo_url", the repo is cloned before the run starts.',
          },
          provider: { type: 'string' },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            run_id: { type: 'string' },
            status: { type: 'string' },
            stream_url: { type: 'string' },
          },
        },
        400: errorSchema,
        429: errorSchema,
      },
    },
  }, async (request, reply) => {
    const { pipeline, provider } = request.body;
    const runId = randomUUID();
    const depth = parseInt((request.headers['x-studio-depth'] as string) ?? '0', 10) || 0;
    const parentRunId = request.headers['x-studio-parent-run-id'] as string | undefined;

    // Extract repo_url from input (like CLI does with --input-file), then strip it before passing to engine
    const input = { ...request.body.input };
    const inputRepoUrl = typeof input['repo_url'] === 'string' ? input['repo_url'] : undefined;
    if (inputRepoUrl !== undefined) delete input['repo_url'];

    // Fall back to pipeline YAML repo.url when not provided in input (mirrors CLI behaviour)
    let pipelineRepoUrl: string | undefined;
    let pipelineRepoBranch: string | undefined;
    try {
      const pipelineDef = await loadPipelineByName(pipeline, join(options.deps.configsDir, 'pipelines'));
      pipelineRepoUrl = pipelineDef.repo?.url;
      pipelineRepoBranch = pipelineDef.repo?.branch;
    } catch {
      // Pipeline not found — launcher.launch() will throw a proper error later
    }

    const repoUrl = inputRepoUrl ?? pipelineRepoUrl;
    let repoPath: string;
    try {
      repoPath = await resolveRepoPath({
        repoUrl,
        rawProjectsDir: options.deps.projectsDir,
        pipelineName: pipeline,
        branch: pipelineRepoBranch,
      });
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }

    let run_id: string;
    try {
      const result = await launcher.launch({
        runId,
        pipeline,
        input,
        configsDir: options.deps.configsDir,
        repoPath,
        providerOverride: provider,
        depth,
        parentRunId,
        userId: request.user?.id,
      });
      run_id = result.run_id;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'QUOTA_EXCEEDED') {
        return reply.status(429).send({ error: err instanceof Error ? err.message : String(err) });
      }
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }

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
      tags: ['runs'],
      summary: 'List pipeline runs',
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          limit: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            runs: { type: 'array', items: pipelineRunSchema },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { status, limit } = request.query;
    const runs = await store.listPipelineRuns({
      status,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    return reply.send({ runs });
  });

  // GET /api/runs/:id
  fastify.get<{ Params: { id: string } }>('/runs/:id', {
    schema: {
      tags: ['runs'],
      summary: 'Get a run by ID',
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      response: {
        200: pipelineRunSchema,
        404: errorSchema,
      },
    },
  }, async (request, reply) => {
    const run = await store.getPipelineRun(request.params.id);
    if (!run) {
      return reply.status(404).send({ error: 'Run not found' });
    }
    return reply.send(run);
  });

  // GET /api/runs/:id/logs
  fastify.get<{
    Params: { id: string };
    Querystring: { raw?: string };
  }>('/runs/:id/logs', {
    schema: {
      tags: ['runs'],
      summary: 'Get run logs (parsed JSONL or raw text)',
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      querystring: {
        type: 'object',
        properties: { raw: { type: 'string', description: 'Set to "true" for raw JSONL text' } },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            run_id: { type: 'string' },
            entries: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  event: { type: 'string' },
                  timestamp: { type: 'string' },
                  data: { type: 'object', additionalProperties: true },
                },
              },
            },
          },
        },
        404: errorSchema,
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const isRaw = request.query.raw === 'true';

    const run = await store.getPipelineRun(id);
    if (!run) {
      return reply.status(404).send({ error: 'Run not found' });
    }

    const logPath = await store.getLogPath(id);
    if (!logPath) {
      return reply.status(404).send({ error: 'Log not yet available' });
    }

    let content: string;
    try {
      content = await readFile(logPath, 'utf-8');
    } catch {
      return reply.status(404).send({ error: 'Log file not found' });
    }

    if (isRaw) {
      return reply.type('text/plain').send(content);
    }

    const entries: Array<{ event: string; timestamp: string; data: Record<string, unknown> }> = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const { event, ts, ...data } = parsed;
        if (typeof event !== 'string') continue;
        entries.push({ event, timestamp: typeof ts === 'string' ? ts : '', data });
      } catch {
        // skip malformed lines
      }
    }

    return reply.send({ run_id: id, entries });
  });


  // POST /api/runs/:id/cancel
  fastify.post<{ Params: { id: string } }>('/runs/:id/cancel', {
    schema: {
      tags: ['runs'],
      summary: 'Cancel a running pipeline',
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      response: {
        200: {
          type: 'object',
          properties: { run_id: { type: 'string' } },
        },
        404: errorSchema,
        409: errorSchema,
      },
    },
  }, async (request, reply) => {
    return handleCancel(request.params.id, reply);
  });

  // DELETE /api/runs/:id — cancel a running pipeline (spec-aligned alias for POST /runs/:id/cancel)
  fastify.delete<{ Params: { id: string } }>('/runs/:id', {
    schema: {
      tags: ['runs'],
      summary: 'Cancel a running pipeline (DELETE alias for POST /runs/:id/cancel)',
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      response: {
        200: {
          type: 'object',
          properties: { run_id: { type: 'string' } },
        },
        404: errorSchema,
        409: errorSchema,
      },
    },
  }, async (request, reply) => {
    return handleCancel(request.params.id, reply);
  });

  // GET /api/runs/:id/stream — SSE
  fastify.get<{
    Params: { id: string };
    Querystring: { events?: string };
  }>('/runs/:id/stream', {
    schema: {
      tags: ['runs'],
      summary: 'Stream run events via SSE',
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      querystring: {
        type: 'object',
        properties: { events: { type: 'string', description: 'Comma-separated event types to filter' } },
      },
      response: {
        404: errorSchema,
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const filterParam = request.query.events;
    const filter = filterParam ? filterParam.split(',') : null;

    const run = await store.getPipelineRun(id);
    if (!run) {
      return reply.status(404).send({ error: 'Run not found' });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const send = (type: string, data: unknown) => {
      if (filter && !filter.includes(type)) return;
      reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Replay historical events from JSONL
    const logPath = await store.getLogPath(id);
    if (logPath) await replayJsonl(logPath, send);

    const TERMINAL = ['success', 'failed', 'rejected', 'cancelled'];
    if (TERMINAL.includes(run.status)) {
      reply.raw.end();
      return reply;
    }

    // Subscribe to live events
    const unsub = options.deps.launcher.subscribe(id, ({ type, data }) => send(type, data));

    // Cleanup on client disconnect
    request.raw.on('close', unsub);

    // Keep connection open — Fastify won't auto-close since we used reply.raw
    return reply;
  });

  // POST /api/runs/:id/retry — re-run with the same pipeline + input
  fastify.post<{ Params: { id: string } }>('/runs/:id/retry', {
    schema: {
      tags: ['runs'],
      summary: 'Retry a run with the same parameters',
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      response: {
        201: {
          type: 'object',
          properties: {
            run_id: { type: 'string' },
            status: { type: 'string' },
            stream_url: { type: 'string' },
            parent_run_id: { type: 'string' },
          },
        },
        404: errorSchema,
        422: errorSchema,
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;

    const originalRun = await store.getPipelineRun(id);
    if (!originalRun) {
      return reply.status(404).send({ error: 'Run not found' });
    }

    if (!originalRun.input) {
      return reply.status(422).send({ error: 'Original run has no stored input — cannot retry' });
    }

    const { run_id: runId } = await launcher.launch({
      runId: randomUUID(),
      pipeline: originalRun.pipeline_name,
      input: originalRun.input,
      configsDir: options.deps.configsDir,
      parentRunId: id,
    });

    return reply.status(201).send({
      run_id: runId,
      status: 'running',
      stream_url: `/api/runs/${runId}/stream`,
      parent_run_id: id,
    });
  });
}
