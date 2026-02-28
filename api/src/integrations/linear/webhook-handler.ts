// LinearWebhookHandler — plugin class implementing WebhookHandler
// Extracted from routes/linear-webhook.ts POST /integrations/linear/webhook
// Receives all deps via WebhookHandlerContext instead of Fastify plugin closure.

import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { FastifyReply } from 'fastify';
import type { WebhookHandler, WebhookHandlerContext } from '../types.js';
import { loadPipelineByName } from '@studio/engine';
import { resolveRepoPath } from '../../utils/repo-resolver.js';

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

function verifyHmac(rawBody: Buffer, signature: string, secret: string): boolean {
  const computed = createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    const a = Buffer.from(computed, 'hex');
    const b = Buffer.from(signature, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export class LinearWebhookHandler implements WebhookHandler {
  async handle(ctx: WebhookHandlerContext, reply: FastifyReply): Promise<unknown> {
    const { rawBody, headers, integration, store, launcher, configsDir, projectsDir, integrationConfig } = ctx;

    // HMAC verification — only when hmac config is present in the integration def
    const hmacConfig = integration.webhook?.hmac;
    if (hmacConfig) {
      const secret = integrationConfig[hmacConfig.secret_env] as string | undefined;
      if (secret) {
        const sig = headers[hmacConfig.header];
        if (typeof sig !== 'string') {
          return reply.status(401).send({ error: `Missing ${hmacConfig.header} header` });
        }
        if (!verifyHmac(rawBody, sig, secret)) {
          return reply.status(401).send({ error: 'Invalid signature' });
        }
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
    const config = store.getConfig(integration.name);
    if (!config.active) {
      return reply.status(200).send({ ignored: true, reason: 'integration is inactive' });
    }

    const pipeline = config.pipeline ?? 'feature-builder';
    const issueUrl = `https://linear.app/studioag/issue/${issue.identifier}`;

    // Resolve repo path from pipeline YAML — mirrors CLI behaviour.
    // If the pipeline file can't be loaded, fall back gracefully —
    // launcher.launch() will surface the proper "pipeline not found" error afterwards.
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
      await launcher.launch({ runId, pipeline, input, configsDir, repoPath, meta });

      store.insertTrigger({
        id: triggerId,
        integration_name: integration.name,
        received_at: receivedAt,
        external_id: issue.id,
        external_label: [issue.identifier, issue.title].filter(Boolean).join(' — '),
        external_url: issueUrl,
        pipeline,
        run_id: runId,
        status: 'success',
      });
    } catch (err) {
      store.insertTrigger({
        id: triggerId,
        integration_name: integration.name,
        received_at: receivedAt,
        external_id: issue.id,
        external_label: [issue.identifier, issue.title].filter(Boolean).join(' — '),
        external_url: issueUrl,
        pipeline,
        run_id: runId,
        status: 'failed',
      });
      throw err;
    }

    return reply.status(202).send({ run_id: runId, stream_url: `/api/runs/${runId}/stream` });
  }
}
