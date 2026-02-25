import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ServerDeps } from '../server.js';

const VALID_EVENTS = [
  'pipeline_start',
  'pipeline_complete',
  'stage_complete',
  'stage_rejected',
  'stage_failed',
  'group_feedback',
] as const;

const errorSchema = { type: 'object', properties: { error: { type: 'string' } } };

const webhookSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    url: { type: 'string' },
    events: { type: 'array', items: { type: 'string' } },
    status: { type: 'string', enum: ['active', 'failed'] },
    created_at: { type: 'string' },
  },
};

export async function webhooksRoutes(
  fastify: FastifyInstance,
  options: { deps: ServerDeps },
): Promise<void> {
  const { webhookStore } = options.deps;

  // POST /api/webhooks
  fastify.post<{
    Body: { url: string; events: string[]; secret?: string };
  }>('/webhooks', {
    schema: {
      tags: ['webhooks'],
      summary: 'Register a new webhook',
      body: {
        type: 'object',
        required: ['url', 'events'],
        properties: {
          url: { type: 'string' },
          events: { type: 'array', items: { type: 'string' }, minItems: 1 },
          secret: { type: 'string' },
        },
      },
      response: {
        201: webhookSchema,
        400: errorSchema,
      },
    },
  }, async (request, reply) => {
    const { url, events, secret } = request.body;

    if (!events || events.length === 0) {
      return reply.status(400).send({ error: 'events must not be empty' });
    }

    const id = randomUUID();
    const created_at = new Date().toISOString();

    webhookStore.saveWebhook({
      id,
      url,
      events,
      ...(secret != null ? { secret } : {}),
      status: 'active',
      created_at,
    });

    return reply.status(201).send({ id, url, events, status: 'active', created_at });
  });

  // GET /api/webhooks
  fastify.get('/webhooks', {
    schema: {
      tags: ['webhooks'],
      summary: 'List all registered webhooks',
      response: {
        200: {
          type: 'object',
          properties: {
            webhooks: { type: 'array', items: webhookSchema },
          },
        },
      },
    },
  }, async (_request, reply) => {
    const webhooks = webhookStore.listWebhooks().map(({ secret: _secret, ...w }) => w);
    return reply.send({ webhooks });
  });

  // DELETE /api/webhooks/:id
  fastify.delete<{ Params: { id: string } }>('/webhooks/:id', {
    schema: {
      tags: ['webhooks'],
      summary: 'Delete a webhook',
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      response: {
        204: { type: 'null', description: 'No content' },
        404: errorSchema,
      },
    },
  }, async (request, reply) => {
    const deleted = webhookStore.deleteWebhook(request.params.id);
    if (!deleted) {
      return reply.status(404).send({ error: 'Webhook not found' });
    }
    return reply.status(204).send();
  });
}

// Export VALID_EVENTS for documentation/validation use
export { VALID_EVENTS };
