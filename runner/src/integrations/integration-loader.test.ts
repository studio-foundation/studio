import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadProjectIntegrations } from './integration-loader.js';

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'studio-integration-loader-test-'));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
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
