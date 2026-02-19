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

describe('validateProjectName', () => {
  it('accepts valid lowercase alphanumeric names', async () => {
    const { validateProjectName } = await import('../../src/commands/project.js');
    expect(validateProjectName('software')).toBe(true);
    expect(validateProjectName('legal-analyzer')).toBe(true);
    expect(validateProjectName('my-project-v2')).toBe(true);
    expect(validateProjectName('x')).toBe(true);
    expect(validateProjectName('abc123')).toBe(true);
  });

  it('rejects names with uppercase letters', async () => {
    const { validateProjectName } = await import('../../src/commands/project.js');
    expect(validateProjectName('Legal')).not.toBe(true);
    expect(validateProjectName('MY-PROJECT')).not.toBe(true);
  });

  it('rejects names with leading or trailing hyphens', async () => {
    const { validateProjectName } = await import('../../src/commands/project.js');
    expect(validateProjectName('-legal')).not.toBe(true);
    expect(validateProjectName('legal-')).not.toBe(true);
  });

  it('rejects names with spaces or underscores', async () => {
    const { validateProjectName } = await import('../../src/commands/project.js');
    expect(validateProjectName('my project')).not.toBe(true);
    expect(validateProjectName('my_project')).not.toBe(true);
  });

  it('returns an error string (not false) for invalid names', async () => {
    const { validateProjectName } = await import('../../src/commands/project.js');
    const result = validateProjectName('Bad Name');
    expect(typeof result).toBe('string');
    expect(result).toContain('lowercase');
  });
});

describe('createProjectDir with { withTools: false }', () => {
  it('copies software template files but leaves tools/ empty', async () => {
    const { createProjectDir } = await import('../../src/commands/project.js');
    await createProjectDir(PROJECTS_DIR, 'my-app', 'software', { withTools: false });

    // Non-tool template files are copied
    expect(await exists(join(PROJECTS_DIR, 'my-app', 'pipelines', 'feature-builder.pipeline.yaml'))).toBe(true);
    expect(await exists(join(PROJECTS_DIR, 'my-app', 'agents', 'coder.agent.yaml'))).toBe(true);

    // tools/ directory exists but is empty
    expect(await exists(join(PROJECTS_DIR, 'my-app', 'tools'))).toBe(true);
    const toolFiles = await readdir(join(PROJECTS_DIR, 'my-app', 'tools'));
    expect(toolFiles).toEqual([]);
  });

  it('blank template with { withTools: false } still creates all 5 subdirs including tools/', async () => {
    const { createProjectDir } = await import('../../src/commands/project.js');
    await createProjectDir(PROJECTS_DIR, 'my-blank', 'blank', { withTools: false });

    for (const sub of ['pipelines', 'agents', 'contracts', 'tools', 'inputs']) {
      expect(await exists(join(PROJECTS_DIR, 'my-blank', sub))).toBe(true);
    }
  });

  it('default behavior (withTools: true) still copies tools', async () => {
    const { createProjectDir } = await import('../../src/commands/project.js');
    await createProjectDir(PROJECTS_DIR, 'my-app', 'software');

    expect(await exists(join(PROJECTS_DIR, 'my-app', 'tools', 'repo-manager.tool.yaml'))).toBe(true);
  });
});

describe('projectAddDirect', () => {
  it('creates project dirs with a valid name and no template', async () => {
    const { projectAddDirect } = await import('../../src/commands/project.js');
    const studioDir = join(TMP, '.studio');

    await projectAddDirect(studioDir, 'legal-analyzer');

    expect(await exists(join(PROJECTS_DIR, 'legal-analyzer', 'pipelines'))).toBe(true);
    expect(await exists(join(PROJECTS_DIR, 'legal-analyzer', 'agents'))).toBe(true);
  });

  it('creates project with software template', async () => {
    const { projectAddDirect } = await import('../../src/commands/project.js');
    const studioDir = join(TMP, '.studio');

    await projectAddDirect(studioDir, 'my-app', 'software');

    expect(await exists(join(PROJECTS_DIR, 'my-app', 'pipelines', 'feature-builder.pipeline.yaml'))).toBe(true);
  });

  it('throws on invalid project name', async () => {
    const { projectAddDirect } = await import('../../src/commands/project.js');
    const studioDir = join(TMP, '.studio');
    await expect(projectAddDirect(studioDir, 'Invalid Name')).rejects.toThrow('lowercase');
  });

  it('throws "already exists" when project already present', async () => {
    const { projectAddDirect } = await import('../../src/commands/project.js');
    const studioDir = join(TMP, '.studio');
    await projectAddDirect(studioDir, 'legal-analyzer');
    await expect(projectAddDirect(studioDir, 'legal-analyzer')).rejects.toThrow('already exists');
  });
});
