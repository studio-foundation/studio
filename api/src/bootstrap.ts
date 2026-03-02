// Bootstrap — finds .studio/, loads config, creates engine + store + launcher
// Same pattern as CLI but without terminal output

import { resolve, join, dirname } from 'node:path';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
  type EngineConfig,
  SQLiteRunStore,
  InMemoryRunStore,
  PgRunStore,
  type AnyRunStore,
} from '@studio/engine';
import {
  createDefaultRegistry,
  ToolRegistry,
  loadProjectTools,
  loadPlugins,
  loadProjectIntegrations,
  MCPClient,
  type SkillContent,
} from '@studio/runner';
import { InProcessLauncher, type RunLauncher } from './launcher.js';
import { RunEventBus } from './event-bus.js';
import type { MaskedConfig } from './server.js';
import { WebhookStore } from './webhook-store.js';
import { WebhookDispatcher } from './webhook-dispatcher.js';
import { IntegrationStore } from './integration-store.js';
import { IntegrationRuntime } from './integration-runtime.js';
import { HttpApiSpawner } from './spawners/http-api-spawner.js';

export interface StudioApiConfig {
  providers?: {
    openai?: { apiKey: string };
    anthropic?: { apiKey: string };
  };
  paths?: { projects_dir?: string };
  defaults?: { provider?: string; model?: string };
  api?: { key?: string; port?: number };
  integrations?: Record<string, Record<string, unknown>>;
  db?: {
    type?: 'sqlite' | 'postgres' | 'inmemory';
    url?: string;
  };
}

export interface BootstrapResult {
  store: AnyRunStore;
  launcher: RunLauncher;
  configsDir: string;
  /** Raw projects_dir from config (may contain ~). Used by route handlers for repo cloning. */
  projectsDir?: string;
  projectName: string;
  apiConfig: { key?: string; port?: number };
  cleanup: () => Promise<void>;
  studioVersion: string;
  maskedConfig: MaskedConfig;
  webhookStore: WebhookStore;
  integrationStore: IntegrationStore;
  integrationRuntime: IntegrationRuntime;
}

async function findStudioDir(startDir: string): Promise<string | null> {
  let current = resolve(startDir);
  while (true) {
    const candidate = join(current, '.studio');
    try {
      await access(candidate);
      return candidate;
    } catch {
      // not here, go up
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function bootstrap(cwd: string = process.cwd()): Promise<BootstrapResult> {
  const studioDir = await findStudioDir(cwd);
  if (!studioDir) {
    throw new Error(`No .studio/ directory found from ${cwd}. Run 'studio init' first.`);
  }

  // Load config
  let config: StudioApiConfig = {};
  try {
    const raw = await readFile(join(studioDir, 'config.yaml'), 'utf-8');
    // Resolve env vars
    const resolved = raw.replace(/\$\{([^}]+)\}/g, (_m: string, v: string) => process.env[v.trim()] ?? '');
    config = (yaml.load(resolved) as StudioApiConfig) ?? {};
  } catch {
    // No config.yaml — use defaults
  }

  // Read studio version from api/package.json
  const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
  const pkgRaw = await readFile(pkgPath, 'utf-8');
  const studioVersion = (JSON.parse(pkgRaw) as { version: string }).version;

  // Build masked config — provider names only, no API keys
  const maskedConfig = {
    defaults: config.defaults,
    providers: Object.keys(config.providers ?? {}),
  };

  const runsDir = join(studioDir, 'runs');

  const dbType = config.db?.type ?? 'sqlite';

  // WebhookStore and IntegrationStore are always SQLite — they are separate from RunStore
  const dbPath = join(studioDir, 'runs', 'runs.db');

  let store: AnyRunStore;
  if (dbType === 'postgres') {
    const url = config.db?.url;
    if (!url) throw new Error('db.url is required when db.type is postgres');
    store = new PgRunStore(url);
  } else if (dbType === 'inmemory') {
    store = new InMemoryRunStore();
  } else {
    store = new SQLiteRunStore(dbPath);
  }

  const providerRegistry = createDefaultRegistry({
    openai: config.providers?.openai ? { apiKey: config.providers.openai.apiKey } : undefined,
    anthropic: config.providers?.anthropic ? { apiKey: config.providers.anthropic.apiKey } : undefined,
  });

  const toolsDir = join(studioDir, 'tools');
  const loadedPlugins = await loadProjectTools(toolsDir, cwd);
  const toolRegistry = new ToolRegistry();
  for (const plugin of loadedPlugins) {
    toolRegistry.registerPlugin(plugin.name, plugin.tools, plugin.promptSnippet);
  }

  // Load MCP plugins
  const pluginsDir = join(studioDir, 'plugins');
  const pluginManifests = await loadPlugins(pluginsDir);
  const mcpClients: InstanceType<typeof MCPClient>[] = [];
  const pluginSkills: Record<string, string[]> = {};

  for (const manifest of pluginManifests) {
    for (const [serverName, serverDef] of Object.entries(manifest.mcpServers)) {
      const client = new MCPClient(manifest.name, serverName, serverDef);
      try {
        await client.start();
        const mcpTools = await client.getTools();
        toolRegistry.registerPlugin(`${manifest.name}-${serverName}`, mcpTools);
        mcpClients.push(client);
      } catch {
        // Plugin failed to start — skip silently for API
      }
    }
    if (manifest.skills.length > 0) {
      pluginSkills[manifest.name] = manifest.skills.map(
        (s: SkillContent) => `## Skill: ${s.name}\n\n${s.content}`
      );
    }
  }

  // Self-referential spawner: allows pipelines to spawn child runs via the API
  // Must match DEFAULT_PORT in index.ts (3700) — was 3000 which collides with common dev servers
  const apiPort = config.api?.port ?? 3700;
  const spawner = new HttpApiSpawner(`http://localhost:${apiPort}`, config.api?.key);

  const engineConfig: EngineConfig = {
    configsDir: studioDir,
    providerRegistry,
    toolRegistry,
    db: store,
    pluginSkills,
    spawner,
    maxDepth: 3,
  };

  const bus = new RunEventBus();
  const launcher = new InProcessLauncher(engineConfig, store, runsDir, bus);

  // Derive project name from the directory containing .studio/
  const projectName = studioDir.split('/').slice(-2, -1)[0] ?? 'studio-project';

  const webhookStore = new WebhookStore(dbPath);
  const integrationStore = new IntegrationStore(dbPath);
  const integrationsDir = join(studioDir, 'integrations');
  const loadedIntegrations = await loadProjectIntegrations(integrationsDir);
  const integrationConfigs = (config.integrations ?? {}) as Record<string, Record<string, unknown>>;
  const integrationRuntime = new IntegrationRuntime({
    integrations: loadedIntegrations,
    store: integrationStore,
    launcher,
    configsDir: studioDir,
    projectsDir: config.paths?.projects_dir,
    apiConfig: config.api ?? {},
    integrationConfigs,
  });
  integrationRuntime.setupEventBus(bus);
  const webhookDispatcher = new WebhookDispatcher(webhookStore, projectName);
  bus.subscribeAll((runId, event) => {
    void webhookDispatcher.handleBusEvent(runId, event.type, event.data);
  });

  return {
    store,
    launcher,
    configsDir: studioDir,
    projectsDir: config.paths?.projects_dir,
    projectName,
    apiConfig: config.api ?? {},
    studioVersion,
    maskedConfig,
    webhookStore,
    integrationStore,
    integrationRuntime,
    cleanup: async () => {
      for (const client of mcpClients) {
        try { await client.close(); } catch { /* ignore */ }
      }
      if ('close' in store && typeof (store as AnyRunStore & { close?: () => unknown }).close === 'function') {
        await (store as AnyRunStore & { close(): Promise<void> | void }).close();
      }
      webhookStore.close();
      integrationStore.close();
    },
  };
}
