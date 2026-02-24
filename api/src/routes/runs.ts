import type { FastifyInstance } from 'fastify';
import type { ServerDeps } from '../server.js';

export async function runsRoutes(
  fastify: FastifyInstance,
  options: { deps: ServerDeps }
): Promise<void> {
  // Implemented in Task 7
  void options;
  void fastify;
}
