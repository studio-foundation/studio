import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { loadSkillFiles } from './skill-loader.js';

const TMP = join('/tmp', '.studio-skill-loader-test-' + Date.now());

describe('loadSkillFiles', () => {
  beforeAll(async () => {
    await mkdir(TMP, { recursive: true });
    await writeFile(join(TMP, 'git-workflow.skill.md'), '# Git Workflow\n\nAlways branch from main.');
    await writeFile(join(TMP, 'code-conventions.skill.md'), '# Code Conventions\n\nUse camelCase.');
  });

  afterAll(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  it('loads existing skill files by name', async () => {
    const skills = await loadSkillFiles(['git-workflow', 'code-conventions'], TMP);
    expect(skills).toHaveLength(2);
    expect(skills[0]).toEqual({ name: 'git-workflow', content: '# Git Workflow\n\nAlways branch from main.' });
    expect(skills[1]).toEqual({ name: 'code-conventions', content: '# Code Conventions\n\nUse camelCase.' });
  });

  it('skips missing skill files without throwing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const skills = await loadSkillFiles(['git-workflow', 'nonexistent'], TMP);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('git-workflow');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('nonexistent'));
    warnSpy.mockRestore();
  });

  it('returns empty array when names list is empty', async () => {
    const skills = await loadSkillFiles([], TMP);
    expect(skills).toHaveLength(0);
  });

  it('returns empty array when skills directory does not exist', async () => {
    const skills = await loadSkillFiles(['git-workflow'], '/tmp/nonexistent-skills-dir-xyz-abc');
    expect(skills).toHaveLength(0);
  });
});
