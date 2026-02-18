import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, access, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';

// IMPORTANT: must be under /tmp, not a Studio repo subdirectory
const TMP = resolve('/tmp', '.studio-project-test');
const PROJECTS_DIR = join(TMP, '.studio', 'projects');

beforeEach(async () => { await mkdir(PROJECTS_DIR, { recursive: true }); });
afterEach(async () => { await rm(TMP, { recursive: true, force: true }); });

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

describe('createProjectDir', () => {
  it('creates 5 empty subdirs when no template given', async () => {
    const { createProjectDir } = await import('../../src/commands/project.js');
    await createProjectDir(PROJECTS_DIR, 'my-app');

    const projectDir = join(PROJECTS_DIR, 'my-app');
    for (const sub of ['pipelines', 'agents', 'contracts', 'tools', 'inputs']) {
      expect(await exists(join(projectDir, sub))).toBe(true);
    }
  });

  it('creates 5 empty subdirs for blank template (no project/ subdir in template)', async () => {
    const { createProjectDir } = await import('../../src/commands/project.js');
    await createProjectDir(PROJECTS_DIR, 'my-app', 'blank');

    const pipelinesDir = join(PROJECTS_DIR, 'my-app', 'pipelines');
    expect(await exists(pipelinesDir)).toBe(true);
    const entries = await readdir(pipelinesDir);
    expect(entries).toEqual([]);
  });

  it('copies software template files into the project dir', async () => {
    const { createProjectDir } = await import('../../src/commands/project.js');
    await createProjectDir(PROJECTS_DIR, 'my-app', 'software');

    expect(await exists(join(PROJECTS_DIR, 'my-app', 'pipelines', 'feature-builder.pipeline.yaml'))).toBe(true);
    expect(await exists(join(PROJECTS_DIR, 'my-app', 'agents', 'coder.agent.yaml'))).toBe(true);
    expect(await exists(join(PROJECTS_DIR, 'my-app', 'contracts', 'code-output.contract.yaml'))).toBe(true);
    expect(await exists(join(PROJECTS_DIR, 'my-app', 'tools', 'repo-manager.tool.yaml'))).toBe(true);
    expect(await exists(join(PROJECTS_DIR, 'my-app', 'inputs', 'example.input.yaml'))).toBe(true);
  });

  it('throws "already exists" when the project dir already exists', async () => {
    const { createProjectDir } = await import('../../src/commands/project.js');
    await createProjectDir(PROJECTS_DIR, 'my-app');
    await expect(createProjectDir(PROJECTS_DIR, 'my-app')).rejects.toThrow("Project 'my-app' already exists");
  });

  it('throws "not found" with template list hint for invalid template', async () => {
    const { createProjectDir } = await import('../../src/commands/project.js');
    const err = await createProjectDir(PROJECTS_DIR, 'my-app', 'nonexistent').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("Template 'nonexistent' not found");
    expect((err as Error).message).toContain('studio templates list');
  });
});
