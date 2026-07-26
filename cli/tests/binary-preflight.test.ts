import { describe, it, expect } from 'vitest';
import {
  parseRequirement,
  checkBinaries,
  formatBinaryPreflightError,
} from '../src/binary-preflight.js';

describe('parseRequirement', () => {
  it('reads a bare binary name', () => {
    expect(parseRequirement('git')).toEqual({ binary: 'git' });
  });

  it('splits a binary from its semver range', () => {
    expect(parseRequirement('node >=18 <=22')).toEqual({
      binary: 'node',
      range: '>=18 <=22',
    });
  });
});

describe('checkBinaries', () => {
  it('passes for a binary that exists with no range', () => {
    expect(checkBinaries([{ entry: 'node', declaredBy: 'this project' }])).toEqual([]);
  });

  it('reports a binary absent from PATH', () => {
    const failures = checkBinaries([
      { entry: 'studio-definitely-not-a-real-binary', declaredBy: "tool plugin 'x'" },
    ]);
    expect(failures).toEqual([
      {
        binary: 'studio-definitely-not-a-real-binary',
        range: undefined,
        declaredBy: "tool plugin 'x'",
        reason: 'not-found',
      },
    ]);
  });

  it('passes when the installed version satisfies the range', () => {
    const major = process.versions.node.split('.')[0];
    expect(checkBinaries([{ entry: `node >=${major}`, declaredBy: 'this project' }])).toEqual([]);
  });

  it('reports a version outside the range', () => {
    const major = Number(process.versions.node.split('.')[0]);
    const failures = checkBinaries([
      { entry: `node <${major}`, declaredBy: 'this project' },
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toBe('out-of-range');
    expect(failures[0].found).toBe(process.versions.node);
  });

  it('reports an unparseable range instead of probing', () => {
    const failures = checkBinaries([{ entry: 'node not-a-range', declaredBy: 'this project' }]);
    expect(failures[0].reason).toBe('invalid-range');
  });

  it('deduplicates identical requirements from several declarers', () => {
    const failures = checkBinaries([
      { entry: 'studio-missing-bin', declaredBy: 'this project' },
      { entry: 'studio-missing-bin', declaredBy: "tool plugin 'a'" },
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0].declaredBy).toBe('this project');
  });
});

describe('formatBinaryPreflightError', () => {
  it('returns null when nothing failed', () => {
    expect(formatBinaryPreflightError([])).toBeNull();
  });

  it('names each binary, its constraint and its declarer', () => {
    const message = formatBinaryPreflightError([
      { binary: 'gh', declaredBy: 'this project', reason: 'not-found' },
      {
        binary: 'node',
        range: '<=22',
        declaredBy: "tool plugin 'git'",
        reason: 'out-of-range',
        found: '24.3.0',
      },
    ]);
    expect(message).toContain('gh — not found in PATH (required by this project)');
    expect(message).toContain("node — requires <=22, found 24.3.0 (required by tool plugin 'git')");
  });
});
