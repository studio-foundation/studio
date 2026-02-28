#!/usr/bin/env node
// Standalone entrypoint for @studio/api
// PM2: pm2 start node_modules/.bin/studio-api --env STUDIO_CWD=/path/to/project
// systemd: ExecStart=/usr/bin/node /path/to/api/dist/index.js

import { bootstrap } from './bootstrap.js';
import { buildServer } from './server.js';

const DEFAULT_PORT = 3700;

async function main() {
  const cwd = process.env['STUDIO_CWD'] ?? process.cwd();

  let result: Awaited<ReturnType<typeof bootstrap>>;
  try {
    result = await bootstrap(cwd);
  } catch (err) {
    console.error('Bootstrap failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const { store, launcher, configsDir, projectName, apiConfig, cleanup, studioVersion, maskedConfig, webhookStore, linearStore } = result;
  const port = apiConfig.port ?? DEFAULT_PORT;

  const server = buildServer({ store, launcher, configsDir, projectName, apiConfig, studioVersion, maskedConfig, webhookStore, linearStore });

  // Graceful shutdown
  const shutdown = async () => {
    await server.close();
    await cleanup();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  try {
    await server.listen({ port, host: '0.0.0.0' });
    console.log(`Studio API listening on port ${port}`);
    if (!apiConfig.key) {
      console.log('Warning: no api.key configured — running without auth');
    }
  } catch (err) {
    console.error('Failed to start server:', err);
    await cleanup();
    process.exit(1);
  }
}

void main();
