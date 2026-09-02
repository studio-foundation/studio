import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { loadSkillFiles } from './skill-loader.js';

const TMP = join('/tmp', '.studio-skill-loader-test-' + Date.now());

describe('loadSkillFiles', () => {
  beforeAll(async () => {
    await mkdir(TMP, { recursive: true });
    await writeFile(join(TMP, 'git-workflow.skill.md'), '# Git Workflow\n\nAlways branch from main.');
    await writeFile(join(TMP, 'code-conventions.skill.md'), '# Code Conventions\n\nUse camelCase.');
    await writeFile(
      join(TMP, 'with-frontmatter.skill.md'),
      '---\nname: with-frontmatter\ndescription: How the club addresses a parent.\n---\n# Tone\n\nWarm, never curt.'
    );
    await writeFile(
      join(TMP, 'renamed.skill.md'),
      '---\nname: original-name\ndescription: Moved without updating its frontmatter.\n---\n# Body\n'
    );
    await writeFile(join(TMP, 'broken-frontmatter.skill.md'), '---\nname: [unclosed\n---\n# Body\n');
    await writeFile(join(TMP, 'a-directory.skill.md'), 'placeholder');
    await rm(join(TMP, 'a-directory.skill.md'));
    await mkdir(join(TMP, 'a-directory.skill.md'));
  });

  afterAll(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  it('loads existing skill files by name', async () => {
    const skills = await loadSkillFiles(['git-workflow', 'code-conventions'], TMP);
    expect(skills).toEqual([
      { name: 'git-workflow', content: '# Git Workflow\n\nAlways branch from main.' },
      { name: 'code-conventions', content: '# Code Conventions\n\nUse camelCase.' },
    ]);
  });

  it('returns empty array when names list is empty', async () => {
    expect(await loadSkillFiles([], TMP)).toHaveLength(0);
  });

  describe('a declared skill that cannot be read (STU-918)', () => {
    it('throws instead of skipping, naming the skill and the path tried', async () => {
      await expect(loadSkillFiles(['git-workflow', 'nonexistent'], TMP)).rejects.toThrow(
        new RegExp(`Skill 'nonexistent' could not be read at ${TMP}/nonexistent\\.skill\\.md`)
      );
    });

    it('throws when the skills directory itself is missing', async () => {
      await expect(
        loadSkillFiles(['git-workflow'], '/tmp/nonexistent-skills-dir-xyz-abc')
      ).rejects.toThrow(/could not be read/);
    });

    it('throws when the path is a directory rather than a file', async () => {
      await expect(loadSkillFiles(['a-directory'], TMP)).rejects.toThrow(/could not be read/);
    });
  });

  describe('frontmatter (STU-916)', () => {
    it('strips the frontmatter and keeps the body byte-identical', async () => {
      const [skill] = await loadSkillFiles(['with-frontmatter'], TMP);
      expect(skill.content).toBe('# Tone\n\nWarm, never curt.');
      expect(skill.content).not.toContain('---');
      expect(skill.content).not.toContain('description:');
    });

    it('lifts description out of the prompt and onto the skill', async () => {
      const [skill] = await loadSkillFiles(['with-frontmatter'], TMP);
      expect(skill.description).toBe('How the club addresses a parent.');
    });

    it('leaves a file with no frontmatter untouched', async () => {
      const [skill] = await loadSkillFiles(['git-workflow'], TMP);
      expect(skill.content).toBe('# Git Workflow\n\nAlways branch from main.');
      expect(skill.description).toBeUndefined();
    });

    it('rejects a frontmatter name that disagrees with the filename', async () => {
      await expect(loadSkillFiles(['renamed'], TMP)).rejects.toThrow(
        /declares name 'original-name'.*resolved by filename/s
      );
    });

    it('rejects unparseable frontmatter rather than injecting it', async () => {
      await expect(loadSkillFiles(['broken-frontmatter'], TMP)).rejects.toThrow(
        /unparseable frontmatter/
      );
    });
  });

  it.each([
    ['relative traversal', '../../etc/passwd'],
    ['absolute path', '/etc/passwd'],
    ['home expansion', '~/secrets'],
    ['sibling directory', '../other-project/git-workflow'],
  ])('rejects a skill name escaping the skills directory (%s)', async (_label, name) => {
    await expect(loadSkillFiles([name], TMP)).rejects.toThrow(/escapes/);
  });

  it('rejects an escaping name even when the skills directory is missing', async () => {
    await expect(
      loadSkillFiles(['../../etc/passwd'], '/tmp/nonexistent-skills-dir-xyz-abc')
    ).rejects.toThrow(/escapes/);
  });
});
