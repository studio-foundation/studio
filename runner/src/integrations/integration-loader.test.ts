import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getBundledIntegrationTemplate,
  listAvailableIntegrationTemplates,
  loadProjectIntegrations,
} from './integration-loader.js';

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'studio-integration-loader-test-'));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('getBundledIntegrationTemplate', () => {
  it('returns YAML content for a known bundled integration', async () => {
    const content = await getBundledIntegrationTemplate('linear');
    expect(content).not.toBeNull();
    expect(content).toContain('name: linear');
  });

  it('returns null for unknown integration name', async () => {
    const content = await getBundledIntegrationTemplate('doesnotexist');
    expect(content).toBeNull();
  });
});

describe('listAvailableIntegrationTemplates', () => {
  it('returns at least linear, slack, webhook', async () => {
    const templates = await listAvailableIntegrationTemplates();
    const names = templates.map(t => t.name);
    expect(names).toContain('linear');
    expect(names).toContain('slack');
    expect(names).toContain('webhook');
  });

  it('each entry has name and description', async () => {
    const templates = await listAvailableIntegrationTemplates();
    for (const t of templates) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.description).toBe('string');
    }
  });
});

describe('loadProjectIntegrations', () => {
  it('returns empty array when directory does not exist', async () => {
    const result = await loadProjectIntegrations('/nonexistent/path');
    expect(result).toEqual([]);
  });

  it('loads valid .integration.yaml files', async () => {
    const intDir = join(tmpDir, 'integrations');
    await mkdir(intDir, { recursive: true });
    await writeFile(join(intDir, 'test.integration.yaml'), `
name: test
version: 1
description: "Test integration"
config:
  required:
    - TEST_API_KEY
test:
  type: http
  endpoint: https://api.test.com/health
  expect:
    status: 200
`);
    const result = await loadProjectIntegrations(intDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('test');
    expect(result[0]!.config?.required).toEqual(['TEST_API_KEY']);
  });

  it('ignores non-.integration.yaml files', async () => {
    const intDir = join(tmpDir, 'integrations-mixed');
    await mkdir(intDir, { recursive: true });
    await writeFile(join(intDir, 'readme.txt'), 'hello');
    await writeFile(join(intDir, 'other.yaml'), 'name: other\nversion: 1');
    const result = await loadProjectIntegrations(intDir);
    expect(result).toHaveLength(0);
  });
});
