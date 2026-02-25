import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import type { FastifyInstance } from 'fastify';
import type { ServerDeps } from '../server.js';

const KNOWN_PROVIDERS = new Set(['anthropic', 'openai']);

interface RawConfig {
  providers?: Record<string, { apiKey?: string }>;
  defaults?: Record<string, unknown>;
}

async function readConfig(configsDir: string): Promise<RawConfig> {
  try {
    const content = await readFile(join(configsDir, 'config.yaml'), 'utf-8');
    return (yaml.load(content) as RawConfig) ?? {};
  } catch {
    return {};
  }
}

async function writeConfig(configsDir: string, config: RawConfig): Promise<void> {
  await mkdir(configsDir, { recursive: true });
  await writeFile(join(configsDir, 'config.yaml'), yaml.dump(config), 'utf-8');
}

function maskConfig(config: RawConfig): RawConfig {
  if (!config.providers) return config;
  const maskedProviders: Record<string, { apiKey: string }> = {};
  for (const [name, provider] of Object.entries(config.providers)) {
    maskedProviders[name] = { apiKey: provider.apiKey ? '***' : '' };
  }
  return { ...config, providers: maskedProviders };
}

export async function configRoutes(
  fastify: FastifyInstance,
  options: { deps: ServerDeps }
): Promise<void> {
  const { configsDir } = options.deps;

  // GET /api/config
  fastify.get('/config', async (_request, reply) => {
    const config = await readConfig(configsDir);
    return reply.send({
      providers: {},
      ...maskConfig(config),
    });
  });

  // PATCH /api/config
  fastify.patch<{ Body: Partial<RawConfig> }>('/config', {
    schema: { body: { type: 'object' } },
  }, async (request, reply) => {
    const config = await readConfig(configsDir);
    const patch = request.body;

    if (patch.defaults) {
      config.defaults = { ...config.defaults, ...patch.defaults };
    }
    if (patch.providers) {
      config.providers = { ...config.providers, ...patch.providers };
    }

    await writeConfig(configsDir, config);
    return reply.send({
      providers: {},
      ...maskConfig(config),
    });
  });

  // POST /api/config/providers
  fastify.post<{ Body: { provider: string; apiKeyEnvVar: string } }>(
    '/config/providers',
    {
      schema: {
        body: {
          type: 'object',
          required: ['provider', 'apiKeyEnvVar'],
          properties: {
            provider: { type: 'string' },
            apiKeyEnvVar: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { provider, apiKeyEnvVar } = request.body;

      if (!KNOWN_PROVIDERS.has(provider)) {
        return reply.status(400).send({
          error: `Unknown provider: '${provider}'. Supported: ${[...KNOWN_PROVIDERS].join(', ')}`,
        });
      }

      const config = await readConfig(configsDir);
      config.providers = {
        ...config.providers,
        [provider]: { apiKey: `\${${apiKeyEnvVar}}` },
      };

      await writeConfig(configsDir, config);
      return reply.send({
        providers: {},
        ...maskConfig(config),
      });
    }
  );
}
