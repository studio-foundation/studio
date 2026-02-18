import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createPatchTools } from '../src/tools/builtin/patch.js';
import type { Tool } from '../src/tools/tool-registry.js';

describe('apply_patch tool', () => {
  let tmpDir: string;
  let tool: Tool;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'patch-test-'));
    const tools = createPatchTools(tmpDir);
    tool = tools[0];
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('applies a simple single-hunk patch', async () => {
    await fs.writeFile(path.join(tmpDir, 'test.txt'), [
      'line 1',
      'line 2',
      'line 3',
      'line 4',
      'line 5',
    ].join('\n'));

    const patch = [
      '@@ -1,5 +1,5 @@',
      ' line 1',
      ' line 2',
      '-line 3',
      '+line 3 modified',
      ' line 4',
      ' line 5',
    ].join('\n');

    const result = await tool.execute({ path: 'test.txt', patch });

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      hunks_applied: 1,
      hunks_total: 1,
      lines_added: 1,
      lines_removed: 1,
    });

    const content = await fs.readFile(path.join(tmpDir, 'test.txt'), 'utf-8');
    expect(content).toBe([
      'line 1',
      'line 2',
      'line 3 modified',
      'line 4',
      'line 5',
    ].join('\n'));
  });

  it('applies a multi-hunk patch', async () => {
    await fs.writeFile(path.join(tmpDir, 'multi.txt'), [
      'aaa', 'bbb', 'ccc', 'ddd', 'eee',
      'fff', 'ggg', 'hhh', 'iii', 'jjj',
    ].join('\n'));

    const patch = [
      '@@ -1,5 +1,5 @@',
      ' aaa',
      '-bbb',
      '+bbb modified',
      ' ccc',
      ' ddd',
      ' eee',
      '@@ -6,5 +6,5 @@',
      ' fff',
      '-ggg',
      '+ggg modified',
      ' hhh',
      ' iii',
      ' jjj',
    ].join('\n');

    const result = await tool.execute({ path: 'multi.txt', patch });

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      hunks_applied: 2,
      hunks_total: 2,
    });

    const content = await fs.readFile(path.join(tmpDir, 'multi.txt'), 'utf-8');
    expect(content).toContain('bbb modified');
    expect(content).toContain('ggg modified');
  });

  it('applies an addition-only hunk', async () => {
    await fs.writeFile(path.join(tmpDir, 'add.txt'), [
      'line 1',
      'line 2',
      'line 3',
    ].join('\n'));

    const patch = [
      '@@ -1,3 +1,5 @@',
      ' line 1',
      '+new line A',
      '+new line B',
      ' line 2',
      ' line 3',
    ].join('\n');

    const result = await tool.execute({ path: 'add.txt', patch });

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      lines_added: 2,
      lines_removed: 0,
    });

    const content = await fs.readFile(path.join(tmpDir, 'add.txt'), 'utf-8');
    expect(content).toBe([
      'line 1',
      'new line A',
      'new line B',
      'line 2',
      'line 3',
    ].join('\n'));
  });

  it('applies a deletion-only hunk', async () => {
    await fs.writeFile(path.join(tmpDir, 'del.txt'), [
      'line 1',
      'line 2',
      'line 3',
      'line 4',
    ].join('\n'));

    const patch = [
      '@@ -1,4 +1,2 @@',
      ' line 1',
      '-line 2',
      '-line 3',
      ' line 4',
    ].join('\n');

    const result = await tool.execute({ path: 'del.txt', patch });

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      lines_added: 0,
      lines_removed: 2,
    });

    const content = await fs.readFile(path.join(tmpDir, 'del.txt'), 'utf-8');
    expect(content).toBe(['line 1', 'line 4'].join('\n'));
  });

  it('returns error on context mismatch', async () => {
    await fs.writeFile(path.join(tmpDir, 'mismatch.txt'), [
      'actual line 1',
      'actual line 2',
      'actual line 3',
    ].join('\n'));

    const patch = [
      '@@ -1,3 +1,3 @@',
      ' wrong context',
      '-actual line 2',
      '+modified line 2',
      ' actual line 3',
    ].join('\n');

    const result = await tool.execute({ path: 'mismatch.txt', patch });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Context mismatch');
  });

  it('returns error on file not found', async () => {
    const patch = [
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
    ].join('\n');

    const result = await tool.execute({ path: 'nonexistent.txt', patch });

    expect(result.success).toBe(false);
    expect(result.error).toContain('File not found');
  });

  it('tolerates trailing whitespace differences in context', async () => {
    await fs.writeFile(path.join(tmpDir, 'ws.txt'), [
      'line 1   ',
      'line 2',
      'line 3',
    ].join('\n'));

    const patch = [
      '@@ -1,3 +1,3 @@',
      ' line 1',
      '-line 2',
      '+line 2 modified',
      ' line 3',
    ].join('\n');

    const result = await tool.execute({ path: 'ws.txt', patch });

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ hunks_applied: 1 });
  });

  it('matches by content when line number is wrong (offset matching)', async () => {
    await fs.writeFile(path.join(tmpDir, 'offset.txt'), [
      'header 1',
      'header 2',
      'header 3',
      'header 4',
      'header 5',
      'target line A',
      'target line B',
      'target line C',
    ].join('\n'));

    // Hunk says line 1 but content is at line 6
    const patch = [
      '@@ -1,3 +1,3 @@',
      ' target line A',
      '-target line B',
      '+target line B modified',
      ' target line C',
    ].join('\n');

    const result = await tool.execute({ path: 'offset.txt', patch });

    expect(result.success).toBe(true);
    const content = await fs.readFile(path.join(tmpDir, 'offset.txt'), 'utf-8');
    expect(content).toContain('target line B modified');
  });

  it('returns error on ambiguous match', async () => {
    await fs.writeFile(path.join(tmpDir, 'ambig.txt'), [
      'unique header',
      'repeat',
      'target',
      'repeat',
      'repeat',
      'target',
      'repeat',
    ].join('\n'));

    // Hint at line 50 (wrong) — forces slow path scan, finds 2 matches
    const patch = [
      '@@ -50,3 +50,3 @@',
      ' repeat',
      '-target',
      '+target modified',
      ' repeat',
    ].join('\n');

    const result = await tool.execute({ path: 'ambig.txt', patch });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Ambiguous');
  });

  it('ignores --- and +++ headers from LLM output', async () => {
    await fs.writeFile(path.join(tmpDir, 'headers.txt'), [
      'line 1',
      'line 2',
      'line 3',
    ].join('\n'));

    const patch = [
      '--- a/headers.txt',
      '+++ b/headers.txt',
      '@@ -1,3 +1,3 @@',
      ' line 1',
      '-line 2',
      '+line 2 changed',
      ' line 3',
    ].join('\n');

    const result = await tool.execute({ path: 'headers.txt', patch });

    expect(result.success).toBe(true);
    const content = await fs.readFile(path.join(tmpDir, 'headers.txt'), 'utf-8');
    expect(content).toContain('line 2 changed');
  });

  it('returns error on invalid patch format (no hunks)', async () => {
    await fs.writeFile(path.join(tmpDir, 'file.txt'), 'content');

    const result = await tool.execute({ path: 'file.txt', patch: 'not a patch' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid patch format');
  });
});
