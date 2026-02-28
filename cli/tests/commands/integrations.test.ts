import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IntegrationPluginDef } from '@studio/contracts';
import { installIntegration, getIntegrationStatus } from '../../src/commands/integrations.js';

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
