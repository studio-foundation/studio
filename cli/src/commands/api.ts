import { writeFile, readFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from '../config.js';

interface ApiOptions {
  port?: string;
  config?: string;
}

function pidFilePath(): string {
  return join(homedir(), '.studio', 'api.pid');
}

export async function writePid(port: number): Promise<void> {
  await mkdir(join(homedir(), '.studio'), { recursive: true });
  await writeFile(pidFilePath(), `${process.pid}:${port}`, 'utf-8');
}

export async function readPid(): Promise<{ pid: number; port: number } | null> {
  try {
    const content = await readFile(pidFilePath(), 'utf-8');
    const [pidStr, portStr] = content.trim().split(':');
    const pid = parseInt(pidStr ?? '', 10);
    const port = parseInt(portStr ?? '', 10);
    if (isNaN(pid) || isNaN(port)) return null;
    return { pid, port };
  } catch {
    return null;
  }
}

export async function clearPid(): Promise<void> {
  try { await unlink(pidFilePath()); } catch {}
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function apiStartCommand(options: ApiOptions): Promise<void> {
  let apiModule: typeof import('@studio-foundation/api');
  try {
    apiModule = await import('@studio-foundation/api');
  } catch {
    console.error('API not installed. Run: studio install api');
    process.exit(1);
  }

  const { bootstrap, buildServer } = apiModule;
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

  const { store, launcher, configsDir, projectName, apiConfig, cleanup, studioVersion, maskedConfig, webhookStore, integrationStore, integrationRuntime } = result;
  const port = options.port ? parseInt(options.port, 10) : (apiConfig.port ?? 3700);
  const server = buildServer({ store, launcher, configsDir, projectName, apiConfig, studioVersion, maskedConfig, webhookStore, integrationStore, integrationRuntime });

  await writePid(port);

  const shutdown = async () => {
    await server.close();
    await cleanup();
    await clearPid();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  await server.listen({ port, host: '0.0.0.0' });
  console.log(`Studio API running on http://localhost:${port}`);
}

export async function apiStopCommand(): Promise<void> {
  const entry = await readPid();
  if (!entry) {
    console.log('Studio API is not running.');
    return;
  }
  if (!isProcessAlive(entry.pid)) {
    await clearPid();
    console.log('Studio API is not running (stale PID file removed).');
    return;
  }
  process.kill(entry.pid, 'SIGTERM');
  await clearPid();
  console.log('Studio API stopped.');
}

export async function apiStatusCommand(options: ApiOptions): Promise<void> {
  const entry = await readPid();
  if (!entry) {
    console.log('Studio API: not running');
    return;
  }
  if (!isProcessAlive(entry.pid)) {
    await clearPid();
    console.log('Studio API: not running (stale PID file removed)');
    return;
  }
  const port = options.port ? parseInt(options.port, 10) : entry.port;
  try {
    const response = await fetch(`http://localhost:${port}/api/health`);
    if (response.ok) {
      console.log(`Studio API: running on port ${port} (PID ${entry.pid})`);
    } else {
      console.log(`Studio API: process alive (PID ${entry.pid}) but not responding on port ${port}`);
    }
  } catch {
    console.log(`Studio API: process alive (PID ${entry.pid}) but port ${port} not responding`);
  }
}
