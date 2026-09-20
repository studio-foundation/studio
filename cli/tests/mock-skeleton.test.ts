import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import * as yaml from 'js-yaml';
import { buildMockSkeleton, writeMockSkeleton } from '../src/mock-skeleton.js';

const TMP = resolve('/tmp', '.studio-mock-skeleton-test');
afterEach(() => rm(TMP, { recursive: true, force: true }));

describe('buildMockSkeleton', () => {
  it('fills required_fields with typed placeholders, enum first value, nested specs', () => {
    const { output } = buildMockSkeleton({
      name: 'c',
      version: 1,
      schema: {
        required_fields: ['summary', 'count', 'ok', 'importance', 'pages', 'meta', 'tags'],
        fields: {
          count: { type: 'integer' },
          ok: { type: 'boolean' },
          importance: { type: 'string', enum: ['principal', 'secondary'] },
          pages: {
            type: 'array',
            items: { type: 'object', required_fields: ['title', 'kind'], fields: { kind: { enum: ['a', 'b'] } } },
          },
          meta: { type: 'object', required_fields: ['n'], fields: { n: { type: 'number' } } },
          tags: { type: 'array' },
        },
      },
    });
    expect(output).toEqual({
      summary: 'mock',
      count: 0,
      ok: false,
      importance: 'principal',
      pages: [{ title: 'mock', kind: 'a' }],
      meta: { n: 0 },
      tags: [],
    });
  });

  it('emits one call per required tool, in dash format', () => {
    const { tool_calls } = buildMockSkeleton({
      name: 'c',
      version: 1,
      tool_calls: { minimum: 1, required_tools: ['repo_manager.write_file', 'shell.run_command'] },
    });
    expect(tool_calls.map((c) => c.name)).toEqual(['repo_manager-write_file', 'shell-run_command']);
  });

  it('pads to the minimum when required_tools is absent, and emits none without a minimum', () => {
    expect(buildMockSkeleton({ name: 'c', version: 1, tool_calls: { minimum: 2 } }).tool_calls).toHaveLength(2);
    expect(buildMockSkeleton({ name: 'c', version: 1 }).tool_calls).toEqual([]);
  });
});

describe('writeMockSkeleton', () => {
  async function project() {
    const studio = join(TMP, '.studio');
    await mkdir(join(studio, 'pipelines'), { recursive: true });
    await mkdir(join(studio, 'contracts'), { recursive: true });
    await writeFile(
      join(studio, 'pipelines', 'p.pipeline.yaml'),
      'name: p\nversion: 1\nstages:\n  - name: s\n    kind: code\n    agent: a\n    contract: out\n    ralph: { max_attempts: 1, retry_strategy: x }\n',
    );
    await writeFile(join(studio, 'contracts', 'out.contract.yaml'), 'name: out\nversion: 1\nschema:\n  required_fields: [summary]\n');
    return studio;
  }

  it('writes one entry per referenced contract', async () => {
    const studio = await project();
    expect(await writeMockSkeleton(studio)).toBe(true);
    const doc = yaml.load(await readFile(join(studio, 'mock.yaml'), 'utf-8')) as { stages: Record<string, unknown> };
    expect(doc.stages).toEqual({ out: { output: { summary: 'mock' }, tool_calls: [] } });
  });

  it('never overwrites an existing mock.yaml', async () => {
    const studio = await project();
    await writeFile(join(studio, 'mock.yaml'), 'stages: {}\n');
    expect(await writeMockSkeleton(studio)).toBe(false);
    expect(await readFile(join(studio, 'mock.yaml'), 'utf-8')).toBe('stages: {}\n');
  });
});
