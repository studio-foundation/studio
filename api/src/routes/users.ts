// api/src/routes/users.ts
import { randomUUID, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ServerDeps } from '../server.js';

const errorSchema = { type: 'object', properties: { error: { type: 'string' } } };

const userSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    email: { type: 'string' },
    plan: { type: 'string' },
    created_at: { type: 'string' },
  },
};

const userWithKeySchema = {
  ...userSchema,
  properties: { ...userSchema.properties, api_key: { type: 'string' } },
};

const todayUsageSchema = {
  type: 'object',
  properties: {
    runs_count: { type: 'number' },
    tokens_used: { type: 'number' },
  },
};

const userWithUsageSchema = {
  type: 'object',
  properties: {
    ...userSchema.properties,
    today_usage: todayUsageSchema,
  },
};

export async function usersRoutes(
  fastify: FastifyInstance,
  options: { deps: ServerDeps },
): Promise<void> {
  const { userStore } = options.deps;
  if (!userStore) return; // no-op if userStore not configured

  // POST /api/users — create a user
  fastify.post<{ Body: { email: string; plan?: string } }>('/users', {
    schema: {
      tags: ['users'],
      summary: 'Create a new user',
      body: {
        type: 'object',
        required: ['email'],
        properties: {
          email: { type: 'string', format: 'email' },
          plan: { type: 'string', default: 'free' },
        },
      },
      response: {
        201: userWithKeySchema,
        400: errorSchema,
        409: errorSchema,
      },
    },
  }, async (request, reply) => {
    const { email, plan = 'free' } = request.body;

    const apiKey = randomBytes(32).toString('hex');
    const user = {
      id: randomUUID(),
      email,
      plan,
      api_key: apiKey,
      created_at: new Date().toISOString(),
    };

    try {
      await userStore.saveUser(user);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('UNIQUE constraint failed: users.email')) {
        return reply.status(409).send({ error: 'Email already in use' });
      }
      throw err;
    }
    return reply.status(201).send(user);
  });

  // GET /api/users — list users (no api_key exposed)
  fastify.get('/users', {
    schema: {
      tags: ['users'],
      summary: 'List all users',
      response: {
        200: { type: 'array', items: userSchema },
      },
    },
  }, async (_request, reply) => {
    const users = await userStore.listUsers();
    return reply.send(users.map(({ api_key: _k, ...u }) => u));
  });

  // GET /api/users/me — current user + today usage
  fastify.get('/users/me', {
    schema: {
      tags: ['users'],
      summary: 'Get current authenticated user',
      response: {
        200: userWithUsageSchema,
        401: errorSchema,
      },
    },
  }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });

    const today = new Date().toISOString().slice(0, 10);
    const usage = await userStore.getDailyUsage(request.user.id, today);
    const { api_key: _k, ...userWithoutKey } = request.user;

    return reply.send({
      ...userWithoutKey,
      today_usage: { runs_count: usage.runs_count, tokens_used: usage.tokens_used },
    });
  });

  // GET /api/users/:id — user detail + today usage
  fastify.get<{ Params: { id: string } }>('/users/:id', {
    schema: {
      tags: ['users'],
      summary: 'Get a user by ID',
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      response: {
        200: userWithUsageSchema,
        404: errorSchema,
      },
    },
  }, async (request, reply) => {
    const user = await userStore.getUserById(request.params.id);
    if (!user) return reply.status(404).send({ error: 'User not found' });

    const today = new Date().toISOString().slice(0, 10);
    const usage = await userStore.getDailyUsage(user.id, today);
    const { api_key: _k, ...userWithoutKey } = user;

    return reply.send({
      ...userWithoutKey,
      today_usage: { runs_count: usage.runs_count, tokens_used: usage.tokens_used },
    });
  });

  // DELETE /api/users/:id
  fastify.delete<{ Params: { id: string } }>('/users/:id', {
    schema: {
      tags: ['users'],
      summary: 'Delete a user',
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      response: {
        204: { type: 'null', description: 'No content' },
        404: errorSchema,
      },
    },
  }, async (request, reply) => {
    const user = await userStore.getUserById(request.params.id);
    if (!user) return reply.status(404).send({ error: 'User not found' });

    await userStore.deleteUser(request.params.id);
    return reply.status(204).send();
  });
}
