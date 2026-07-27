import { describe, it, expect } from 'vitest';
import { parseDependencySpec, DEFAULT_MARKETPLACE } from '../../src/registry/dependency-spec.js';

describe('parseDependencySpec', () => {
  it('resolves a bare name against the default marketplace', () => {
    expect(parseDependencySpec('git')).toEqual({
      raw: 'git', marketplace: DEFAULT_MARKETPLACE, name: 'git', range: undefined,
    });
  });

  it('reads a version range after @', () => {
    const spec = parseDependencySpec('git@>=1.2.0');
    expect(spec.name).toBe('git');
    expect(spec.range).toBe('>=1.2.0');
  });

  it('keeps a range containing spaces intact', () => {
    expect(parseDependencySpec('git@>=1.2.0 <2.0.0').range).toBe('>=1.2.0 <2.0.0');
  });

  it('reads a qualified marketplace', () => {
    const spec = parseDependencySpec('acme-corp:internal-deploy@^2.0.0');
    expect(spec.marketplace).toBe('acme-corp');
    expect(spec.name).toBe('internal-deploy');
    expect(spec.range).toBe('^2.0.0');
  });

  it('rejects an entry with no package name', () => {
    expect(() => parseDependencySpec('acme-corp:')).toThrow(/Invalid dependency entry/);
  });
});
