// Linear integration routes
// GET  /api/integrations/linear          → config + trigger log
// PATCH /api/integrations/linear         → update config (pipeline, active)
// POST /api/integrations/linear/webhook  → incoming Linear webhook (HMAC-verified)

import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ServerDeps } from '../server.js';
import { loadPipelineByName } from '@studio/engine';
import { resolveRepoPath } from '../utils/repo-resolver.js';

// Linear webhook payload shape (simplified)
interface LinearIssuePayload {
  type?: string;
  action?: string;
  data?: {
    id?: string;
    identifier?: string;
    title?: string;
    description?: string;
    state?: { name?: string };
  };
}

function verifyLinearSignature(rawBody: Buffer, signature: string, secret: string): boolean {
  const computed = createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    const computedBuf = Buffer.from(computed, 'hex');
    const sigBuf = Buffer.from(signature, 'hex');
    if (computedBuf.length !== sigBuf.length) return false;
    return timingSafeEqual(computedBuf, sigBuf);
  } catch {
    return false;
  }
}

export async function linearWebhookRoute(
  fastify: FastifyInstance,
  options: { deps: ServerDeps },
): Promise<void> {
  const { launcher, configsDir, projectsDir, apiConfig, linearStore } = options.deps;

  // Parse body as raw Buffer so we can verify HMAC before JSON-parsing.
  // Scoped to this plugin — GET has no body, PATCH body is manually parsed below.
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  );

  // GET /api/integrations/linear — returns config + trigger log
  fastify.get('/integrations/linear', {
    schema: {
      tags: ['integrations'],
      summary: 'Get Linear integration config and trigger log',
    },
  }, async (request, reply) => {
    const config = linearStore.getConfig();
    const triggers = linearStore.listTriggers(50);

    const baseUrl = process.env['STUDIO_BASE_URL'] ?? `${request.protocol}://${request.hostname}`;
    const webhookUrl = `${baseUrl}/api/integrations/linear/webhook`;

    return reply.status(200).send({
      webhook_url: webhookUrl,
      pipeline: config.pipeline ?? null,
      active: config.active,
      triggers,
    });
  });

  // PATCH /api/integrations/linear — update pipeline and/or active flag
  fastify.patch('/integrations/linear', {
    schema: {
      tags: ['integrations'],
      summary: 'Update Linear integration config',
    },
  }, async (request, reply) => {
    // Body arrives as Buffer due to the plugin-scoped content type parser
    let data: { pipeline?: string; active?: boolean };
    try {
      data = JSON.parse((request.body as Buffer).toString('utf-8')) as typeof data;
    } catch {
      return reply.status(400).send({ error: 'Invalid JSON' });
    }

    linearStore.patchConfig(data);
    const updated = linearStore.getConfig();

    const baseUrl = process.env['STUDIO_BASE_URL'] ?? `${request.protocol}://${request.hostname}`;
    const webhookUrl = `${baseUrl}/api/integrations/linear/webhook`;

    return reply.status(200).send({
      webhook_url: webhookUrl,
      pipeline: updated.pipeline ?? null,
      active: updated.active,
    });
  });

  // POST /api/integrations/linear/webhook — incoming Linear issue event
  fastify.post('/integrations/linear/webhook', {
    schema: {
      tags: ['integrations'],
      summary: 'Receive Linear issue status change webhook',
      response: {
        202: {
          type: 'object',
          properties: {
            run_id: { type: 'string' },
            stream_url: { type: 'string' },
          },
        },
        200: {
          type: 'object',
          properties: { ignored: { type: 'boolean' }, reason: { type: 'string' } },
        },
        400: { type: 'object', properties: { error: { type: 'string' } } },
        401: { type: 'object', properties: { error: { type: 'string' } } },
      },
    },
  }, async (request, reply) => {
    const rawBody = request.body as Buffer;

    // HMAC verification — required when secret is configured
    if (apiConfig.linear_webhook_secret) {
      const sig = request.headers['linear-signature'];
      if (typeof sig !== 'string') {
        return reply.status(401).send({ error: 'Missing Linear-Signature header' });
      }
      if (!verifyLinearSignature(rawBody, sig, apiConfig.linear_webhook_secret)) {
        return reply.status(401).send({ error: 'Invalid signature' });
      }
    }

    let payload: LinearIssuePayload;
    try {
      payload = JSON.parse(rawBody.toString('utf-8')) as LinearIssuePayload;
    } catch {
      return reply.status(400).send({ error: 'Invalid JSON' });
    }

    // Only handle Issue update events
    if (payload.type !== 'Issue' || payload.action !== 'update') {
      return reply.status(200).send({ ignored: true, reason: 'not an issue update' });
    }

    const issue = payload.data ?? {};

    // Only trigger on transitions to "In Progress"
    if (issue.state?.name !== 'In Progress') {
      return reply.status(200).send({ ignored: true, reason: `state is "${issue.state?.name ?? 'unknown'}"` });
    }

    // Check integration is active
    const config = linearStore.getConfig();
    if (!config.active) {
      return reply.status(200).send({ ignored: true, reason: 'integration is inactive' });
    }

    const pipeline = config.pipeline ?? 'feature-builder';
    const issueUrl = `https://linear.app/studioag/issue/${issue.identifier}`;

    // Resolve repo path from pipeline YAML (mirrors CLI behaviour).
    // If the pipeline file can't be loaded, fall back to '.' — launcher.launch()
    // will surface the proper "pipeline not found" error afterwards.
    let pipelineRepoUrl: string | undefined;
    let pipelineRepoBranch: string | undefined;
    try {
      const pipelineDef = await loadPipelineByName(pipeline, join(configsDir, 'pipelines'));
      pipelineRepoUrl = pipelineDef.repo?.url;
      pipelineRepoBranch = pipelineDef.repo?.branch;
    } catch {
      // Pipeline not found or unparseable — launcher.launch() will handle the error
    }

    let repoPath: string;
    try {
      repoPath = await resolveRepoPath({
        repoUrl: pipelineRepoUrl,
        rawProjectsDir: projectsDir,
        pipelineName: pipeline,
        branch: pipelineRepoBranch,
      });
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }

    // Construct structured input for the configured pipeline
    const input: Record<string, unknown> = {
      brief_summary: [issue.identifier, issue.title].filter(Boolean).join(' — '),
      description: issue.description ?? '',
      acceptance_criteria: [],
    };

    const meta: Record<string, unknown> = {
      linear_issue_id: issue.id,
      linear_issue_identifier: issue.identifier,
      linear_issue_url: issueUrl,
    };

    const runId = randomUUID();
    const triggerId = randomUUID();
    const receivedAt = new Date().toISOString();

    try {
      await launcher.launch({
        runId,
        pipeline,
        input,
        configsDir,
        repoPath,
        meta,
      });

      linearStore.insertTrigger({
        id: triggerId,
        received_at: receivedAt,
        issue_id: issue.id,
        issue_title: [issue.identifier, issue.title].filter(Boolean).join(' — '),
        issue_url: issueUrl,
        pipeline,
        run_id: runId,
        status: 'success',
      });
    } catch (err) {
      linearStore.insertTrigger({
        id: triggerId,
        received_at: receivedAt,
        issue_id: issue.id,
        issue_title: [issue.identifier, issue.title].filter(Boolean).join(' — '),
        issue_url: issueUrl,
        pipeline,
        run_id: runId,
        status: 'failed',
      });
      throw err;
    }

    return reply.status(202).send({
      run_id: runId,
      stream_url: `/api/runs/${runId}/stream`,
    });
  });
}
