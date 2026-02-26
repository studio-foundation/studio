import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { loadSkills, loadSkill, validateSkillManifest } from './skill-loader.js';

const TMP = join('/tmp', '.studio-runner-skill-loader-test-' + Date.now());
const SKILLS_DIR = join(TMP, 'skills');

describe('loadSkill', () => {
  beforeAll(async () => {
    await mkdir(SKILLS_DIR, { recursive: true });
    await writeFile(join(SKILLS_DIR, 'commit-conventions.skill.md'), '# Commit Conventions\n\nUse conventional commits.');
    await writeFile(join(SKILLS_DIR, 'react-patterns.skill.md'), '# React Patterns\n\nPrefer hooks.');
  });

  afterAll(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  it('returns SkillContent for an existing skill file', async () => {
    const skill = await loadSkill('commit-conventions', TMP);
    expect(skill).toEqual({
      name: 'commit-conventions',
      content: '# Commit Conventions\n\nUse conventional commits.',
    });
  });

  it('returns null and warns for a missing skill file', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const skill = await loadSkill('nonexistent', TMP);
    expect(skill).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('nonexistent'));
    warnSpy.mockRestore();
  });

  it('returns null when studioDir has no skills/ subdirectory', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const skill = await loadSkill('commit-conventions', '/tmp/nonexistent-studio-dir-xyz');
    expect(skill).toBeNull();
    warnSpy.mockRestore();
  });
});

describe('loadSkills', () => {
  beforeAll(async () => {
    await mkdir(SKILLS_DIR, { recursive: true }).catch(() => {});
    await writeFile(join(SKILLS_DIR, 'commit-conventions.skill.md'), '# Commit Conventions\n\nUse conventional commits.').catch(() => {});
    await writeFile(join(SKILLS_DIR, 'react-patterns.skill.md'), '# React Patterns\n\nPrefer hooks.').catch(() => {});
  });

  it('loads all named skills from .studio/skills/', async () => {
    const skills = await loadSkills(['commit-conventions', 'react-patterns'], TMP);
    expect(skills).toHaveLength(2);
    expect(skills[0]).toEqual({ name: 'commit-conventions', content: '# Commit Conventions\n\nUse conventional commits.' });
    expect(skills[1]).toEqual({ name: 'react-patterns', content: '# React Patterns\n\nPrefer hooks.' });
  });

  it('skips missing skills and returns the ones that exist', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const skills = await loadSkills(['commit-conventions', 'missing-skill'], TMP);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('commit-conventions');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('missing-skill'));
    warnSpy.mockRestore();
  });

  it('returns empty array when names list is empty', async () => {
    const skills = await loadSkills([], TMP);
    expect(skills).toHaveLength(0);
  });

  it('returns empty array when studioDir has no skills/ directory', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const skills = await loadSkills(['commit-conventions'], '/tmp/nonexistent-studio-xyz');
    expect(skills).toHaveLength(0);
    warnSpy.mockRestore();
  });
});

describe('validateSkillManifest', () => {
  it('returns true for a valid skill manifest', () => {
    expect(validateSkillManifest({ name: 'my-skill', content: '# My Skill\n\nContent here.' })).toBe(true);
  });

  it('throws when manifest is missing name', () => {
    expect(() => validateSkillManifest({ content: 'some content' })).toThrow();
  });

  it('throws when manifest is missing content', () => {
    expect(() => validateSkillManifest({ name: 'my-skill' })).toThrow();
  });

  it('throws when manifest is not an object', () => {
    expect(() => validateSkillManifest(null)).toThrow();
    expect(() => validateSkillManifest('string')).toThrow();
    expect(() => validateSkillManifest(42)).toThrow();
  });

  it('throws when name is not a string', () => {
    expect(() => validateSkillManifest({ name: 123, content: 'content' })).toThrow();
  });

  it('throws when content is not a string', () => {
    expect(() => validateSkillManifest({ name: 'skill', content: [] })).toThrow();
  });
});
