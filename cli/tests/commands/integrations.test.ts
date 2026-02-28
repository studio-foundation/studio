import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile, access, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IntegrationPluginDef } from '@studio/contracts';
import { installIntegration, getIntegrationStatus, removeIntegration, runIntegrationTest } from '../../src/commands/integrations.js';
import type { IntegrationTestResult } from '../../src/commands/integrations.js';

let studioDir: string;
let integrationsDir: string;

beforeEach(async () => {
  studioDir = await mkdtemp(join(tmpdir(), 'studio-int-test-'));
  integrationsDir = join(studioDir, 'integrations');
  await mkdir(integrationsDir, { recursive: true });
});

afterEach(async () => {
  await rm(studioDir, { recursive: true, force: true });
});

describe('installIntegration — bundled source', () => {
  it('installs a known bundled integration by @studio/integration-<name>', async () => {
    await installIntegration('@studio/integration-linear', integrationsDir);
    const destPath = join(integrationsDir, 'linear.integration.yaml');
    await expect(access(destPath)).resolves.toBeUndefined();
    const content = await readFile(destPath, 'utf-8');
    expect(content).toContain('name: linear');
  });

  it('throws if integration name is unknown', async () => {
    await expect(
      installIntegration('@studio/integration-doesnotexist', integrationsDir)
    ).rejects.toThrow("Unknown integration 'doesnotexist'");
  });

  it('throws if already installed', async () => {
    await installIntegration('@studio/integration-linear', integrationsDir);
    await expect(
      installIntegration('@studio/integration-linear', integrationsDir)
    ).rejects.toThrow("'linear' already installed");
  });
});

describe('installIntegration — local path', () => {
  it('installs from a local .integration.yaml file', async () => {
    const localFile = join(studioDir, 'my-custom.integration.yaml');
    await writeFile(localFile, 'name: my-custom\nversion: 1\ndescription: "Custom"');
    await installIntegration(localFile, integrationsDir);
    const destPath = join(integrationsDir, 'my-custom.integration.yaml');
    await expect(access(destPath)).resolves.toBeUndefined();
  });

  it('throws if local file does not exist', async () => {
    await expect(
      installIntegration('/nonexistent/file.integration.yaml', integrationsDir)
    ).rejects.toThrow('File not found');
  });
});

describe('getIntegrationStatus', () => {
  it('returns configured when all required vars are set in config', () => {
    const plugin: IntegrationPluginDef = {
      name: 'linear',
      version: 1,
      config: { required: ['LINEAR_API_KEY', 'LINEAR_WEBHOOK_SECRET'] },
    };
    const config = { LINEAR_API_KEY: 'abc', LINEAR_WEBHOOK_SECRET: 'secret' };
    expect(getIntegrationStatus(plugin, config)).toBe('configured');
  });

  it('returns not-configured when a required var is missing', () => {
    const plugin: IntegrationPluginDef = {
      name: 'linear',
      version: 1,
      config: { required: ['LINEAR_API_KEY', 'LINEAR_WEBHOOK_SECRET'] },
    };
    const config = { LINEAR_API_KEY: 'abc' };
    expect(getIntegrationStatus(plugin, config)).toBe('not-configured');
  });

  it('returns configured when plugin has no required vars', () => {
    const plugin: IntegrationPluginDef = { name: 'webhook', version: 1 };
    expect(getIntegrationStatus(plugin, {})).toBe('configured');
  });
});

describe('removeIntegration', () => {
  it('removes an installed integration file', async () => {
    await installIntegration('@studio/integration-linear', integrationsDir);
    const destPath = join(integrationsDir, 'linear.integration.yaml');
    await expect(access(destPath)).resolves.toBeUndefined();

    await removeIntegration('linear', integrationsDir);
    await expect(access(destPath)).rejects.toThrow();
  });

  it('throws if integration is not installed', async () => {
    await expect(
      removeIntegration('doesnotexist', integrationsDir)
    ).rejects.toThrow("Integration 'doesnotexist' not found");
  });
});

describe('runIntegrationTest', () => {
  it('makes an HTTP request with correct headers when auth is provided', async () => {
    const fetchCalls: { url: string; init: RequestInit }[] = [];
    const mockFetch = async (url: string, init: RequestInit) => {
      fetchCalls.push({ url, init });
      return new Response('{"data":{"viewer":{"id":"1","name":"Test"}}}', { status: 200 });
    };

    const plugin: IntegrationPluginDef = {
      name: 'linear',
      version: 1,
      test: {
        type: 'http',
        endpoint: 'https://api.linear.app/graphql',
        method: 'POST',
        auth: 'bearer:${LINEAR_API_KEY}',
        body: '{"query":"{ viewer { id name } }"}',
        expect: { status: 200 },
      },
    };
    const config = { LINEAR_API_KEY: 'my-api-key' };

    const result = await runIntegrationTest(plugin, config, mockFetch as typeof fetch);
    expect(result.success).toBe(true);
    expect(fetchCalls[0]!.url).toBe('https://api.linear.app/graphql');
    expect((fetchCalls[0]!.init.headers as Record<string, string>)['Authorization']).toBe('Bearer my-api-key');
  });

  it('returns success=false when HTTP status does not match expect.status', async () => {
    const mockFetch = async () => new Response('Unauthorized', { status: 401 });
    const plugin: IntegrationPluginDef = {
      name: 'linear',
      version: 1,
      test: {
        type: 'http',
        endpoint: 'https://api.linear.app/graphql',
        method: 'POST',
        auth: 'bearer:my-key',
        body: '{"query":"{ viewer { id } }"}',
        expect: { status: 200 },
      },
    };
    const result = await runIntegrationTest(plugin, {}, mockFetch as typeof fetch);
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(401);
  });

  it('throws when plugin has no test: block', async () => {
    const plugin: IntegrationPluginDef = { name: 'webhook', version: 1 };
    await expect(runIntegrationTest(plugin, {}, fetch)).rejects.toThrow(
      "Integration 'webhook' has no test: configuration"
    );
  });
});
