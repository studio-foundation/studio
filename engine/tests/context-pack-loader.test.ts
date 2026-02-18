import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { loadContextPacks } from '../src/pipeline/context-pack-loader.js';

describe('loadContextPacks', () => {
  let tmpDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-packs-'));
    workspaceDir = path.join(tmpDir, 'workspace');
    await fs.mkdir(path.join(tmpDir, 'context-packs'), { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('loads a pack with only inline sections', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'context-packs', 'coding-standards.yaml'),
      `name: Coding Standards\ndescription: Our standards\nversion: 1\ninline:\n  - title: "Naming"\n    content: "Use camelCase"\n  - title: "Errors"\n    content: "Always catch"`
    );

    const result = await loadContextPacks(['coding-standards'], tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Coding Standards');
    expect(result[0].description).toBe('Our standards');
    expect(result[0].sections).toHaveLength(2);
    expect(result[0].sections[0]).toEqual({ title: 'Naming', content: 'Use camelCase' });
  });

  it('loads a pack with file sections read from workspace', async () => {
    await fs.writeFile(path.join(workspaceDir, 'STYLE.md'), '# Style Guide\nUse tabs.');
    await fs.writeFile(
      path.join(tmpDir, 'context-packs', 'style.yaml'),
      `name: Style Guide\nversion: 1\nfiles:\n  - path: STYLE.md`
    );

    const result = await loadContextPacks(['style'], tmpDir, workspaceDir);

    expect(result[0].sections).toHaveLength(1);
    expect(result[0].sections[0].title).toBe('STYLE.md');
    expect(result[0].sections[0].content).toContain('# Style Guide');
  });

  it('puts file sections before inline sections', async () => {
    await fs.writeFile(path.join(workspaceDir, 'README.md'), 'Read me.');
    await fs.writeFile(
      path.join(tmpDir, 'context-packs', 'mixed.yaml'),
      `name: Mixed\nversion: 1\nfiles:\n  - path: README.md\ninline:\n  - title: "Rule"\n    content: "Follow rules"`
    );

    const result = await loadContextPacks(['mixed'], tmpDir, workspaceDir);

    expect(result[0].sections[0].title).toBe('README.md');
    expect(result[0].sections[1].title).toBe('Rule');
  });

  it('throws a clear error when pack file does not exist', async () => {
    await expect(
      loadContextPacks(['nonexistent'], tmpDir)
    ).rejects.toThrow(/context pack.*nonexistent.*not found/i);
  });

  it('throws a clear error when referenced workspace file does not exist', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'context-packs', 'bad-pack.yaml'),
      `name: Bad Pack\nversion: 1\nfiles:\n  - path: missing-file.md`
    );

    await expect(
      loadContextPacks(['bad-pack'], tmpDir, workspaceDir)
    ).rejects.toThrow(/file.*missing-file\.md.*not found/i);
  });

  it('throws when files[] referenced but workspacePath not provided', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'context-packs', 'needs-ws.yaml'),
      `name: Needs WS\nversion: 1\nfiles:\n  - path: some.md`
    );

    await expect(
      loadContextPacks(['needs-ws'], tmpDir, undefined)
    ).rejects.toThrow(/workspace.*not configured/i);
  });

  it('loads multiple packs preserving order', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'context-packs', 'pack-a.yaml'),
      `name: Pack A\nversion: 1\ninline:\n  - title: A\n    content: a`
    );
    await fs.writeFile(
      path.join(tmpDir, 'context-packs', 'pack-b.yaml'),
      `name: Pack B\nversion: 1\ninline:\n  - title: B\n    content: b`
    );

    const result = await loadContextPacks(['pack-a', 'pack-b'], tmpDir);

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('Pack A');
    expect(result[1].name).toBe('Pack B');
  });

  it('returns empty array when packNames is empty', async () => {
    const result = await loadContextPacks([], tmpDir);
    expect(result).toEqual([]);
  });
});
