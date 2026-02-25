import { bootstrap, buildServer } from '@studio/api';
import { loadConfig } from '../config.js';

interface ApiOptions {
  port?: string;
  config?: string;
}

export async function apiStartCommand(options: ApiOptions): Promise<void> {
  const config = await loadConfig(options.config);
  const cwd = config.resolvedStudioDir
    ? config.resolvedStudioDir.replace(/\/.studio$/, '')
    : process.cwd();

  let result: Awaited<ReturnType<typeof bootstrap>>;
  try {
    result = await bootstrap(cwd);
  } catch (err) {
    console.error('Error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const { store, launcher, configsDir, projectName, apiConfig, cleanup, studioVersion, maskedConfig } = result;

  const port = options.port ? parseInt(options.port, 10) : (apiConfig.port ?? 3700);
  const server = buildServer({ store, launcher, configsDir, projectName, apiConfig, studioVersion, maskedConfig });

  const shutdown = async () => {
    await server.close();
    await cleanup();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  await server.listen({ port, host: '0.0.0.0' });
  console.log(`Studio API running on http://localhost:${port}`);
}
