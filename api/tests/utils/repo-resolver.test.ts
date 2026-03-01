import { describe, it, expect, vi, afterEach } from 'vitest';
import { homedir } from 'node:os';

// Mock node:child_process so tests don't actually run git
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execSync: vi.fn() };
});

// Mock node:fs/promises — mkdir only
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

import { resolveRepoPath, cloneRepo } from '../../src/utils/repo-resolver.js';
import { execSync } from 'node:child_process';

const mockExecSync = vi.mocked(execSync);

afterEach(() => {
  vi.unstubAllEnvs();
  mockExecSync.mockClear();
});

describe('resolveRepoPath', () => {
  it('returns resolved repoPathOverride when provided', async () => {
    const result = await resolveRepoPath({ repoPathOverride: 'my-project', pipelineName: 'p' });
    expect(result).toMatch(/my-project$/);
  });

  it('returns "." when no repoPathOverride and no repoUrl', async () => {
    const result = await resolveRepoPath({ pipelineName: 'feature-builder' });
    expect(result).toBe('.');
  });

  it('throws when repoUrl is set but no rawProjectsDir and no env var', async () => {
    vi.stubEnv('STUDIO_PROJECTS_DIR', '');
    await expect(
      resolveRepoPath({ repoUrl: 'https://github.com/user/repo', pipelineName: 'p' })
    ).rejects.toThrow('STUDIO_PROJECTS_DIR is not set');
  });

  it('clones when repoUrl is provided with rawProjectsDir', async () => {
    const result = await resolveRepoPath({
      repoUrl: 'https://github.com/user/repo',
      rawProjectsDir: '/tmp/projects',
      pipelineName: 'my-pipeline',
    });
    expect(mockExecSync).toHaveBeenCalledOnce();
    const cmd = mockExecSync.mock.calls[0]![0] as string;
    expect(cmd).toContain('git clone');
    expect(cmd).toContain('https://github.com/user/repo');
    expect(result).toContain('/tmp/projects/my-pipeline-');
  });

  it('clones when repoUrl is provided via STUDIO_PROJECTS_DIR env var', async () => {
    vi.stubEnv('STUDIO_PROJECTS_DIR', '/tmp/envprojects');
    const result = await resolveRepoPath({
      repoUrl: 'https://github.com/user/repo',
      pipelineName: 'test-pipe',
    });
    expect(mockExecSync).toHaveBeenCalledOnce();
    expect(result).toContain('/tmp/envprojects/test-pipe-');
  });

  it('expands ~ in rawProjectsDir', async () => {
    const result = await resolveRepoPath({
      repoUrl: 'https://github.com/user/repo',
      rawProjectsDir: '~/projects',
      pipelineName: 'p',
    });
    expect(result).toContain(homedir() + '/projects/p-');
  });

  it('repoPathOverride takes precedence over repoUrl', async () => {
    const result = await resolveRepoPath({
      repoPathOverride: '/explicit/path',
      repoUrl: 'https://github.com/user/repo',
      rawProjectsDir: '/tmp/p',
      pipelineName: 'p',
    });
    expect(result).toBe('/explicit/path');
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('passes branch arg when branch is set', async () => {
    await resolveRepoPath({
      repoUrl: 'https://github.com/user/repo',
      rawProjectsDir: '/tmp/projects',
      pipelineName: 'p',
      branch: 'main',
    });
    const cmd = mockExecSync.mock.calls[0]![0] as string;
    expect(cmd).toContain('--branch main');
  });
});

describe('cloneRepo', () => {
  it('throws a descriptive error when git clone fails', async () => {
    mockExecSync.mockImplementationOnce(() => { throw new Error('repository not found'); });
    await expect(
      cloneRepo('https://github.com/bad/repo', '/tmp/p', 'pipeline')
    ).rejects.toThrow('Failed to clone https://github.com/bad/repo');
  });
});
