// Incoming webhook handler — Linear → Studio
// POST /api/integrations/linear/webhook
//
// Triggered when a Linear issue changes status.
// Filters for transitions to "In Progress" and launches the feature-builder pipeline.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ServerDeps } from '../server.js';

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
  const { launcher, configsDir, apiConfig } = options.deps;

  // Parse body as raw Buffer so we can verify HMAC before JSON-parsing.
  // This content type parser is scoped to this plugin only.
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  );

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

    // Construct structured input for feature-builder
    const input: Record<string, unknown> = {
      brief_summary: [issue.identifier, issue.title].filter(Boolean).join(' — '),
      description: issue.description ?? '',
      acceptance_criteria: [],
    };

    const meta: Record<string, unknown> = {
      linear_issue_id: issue.id,
      linear_issue_identifier: issue.identifier,
      linear_issue_url: `https://linear.app/studioag/issue/${issue.identifier}`,
    };

    const runId = randomUUID();
    await launcher.launch({
      runId,
      pipeline: 'feature-builder',
      input,
      configsDir,
      meta,
    });

    return reply.status(202).send({
      run_id: runId,
      stream_url: `/api/runs/${runId}/stream`,
    });
  });
}
