import { describe, it, expect } from 'vitest';
import { constraintsOf, formatConstraints, unsatisfied } from '../../src/registry/constraints.js';
import type { LockfileEntry } from '../../src/registry/types.js';

function entry(version: string, constraints?: Record<string, string>): LockfileEntry {
  return { version, type: 'plugin', installed_at: '2026-07-27', sha256: 'abc', constraints };
}

describe('constraintsOf', () => {
  it('returns nothing for an entry with no recorded ranges', () => {
    expect(constraintsOf(entry('1.0.0'))).toEqual([]);
  });

  it('maps each dependent to its declared range', () => {
    expect(constraintsOf(entry('1.0.0', { software: '>=1.0.0', 'deploy-kit': '<2.0.0' })))
      .toEqual([
        { requiredBy: 'software', range: '>=1.0.0' },
        { requiredBy: 'deploy-kit', range: '<2.0.0' },
      ]);
  });
});

describe('unsatisfied', () => {
  it('returns the constraints a version breaks', () => {
    const broken = unsatisfied('2.0.0', constraintsOf(entry('2.0.0', { software: '>=1.0.0', legacy: '<1.5.0' })));
    expect(broken.map(c => c.requiredBy)).toEqual(['legacy']);
  });

  it('returns nothing when every constraint holds', () => {
    expect(unsatisfied('1.4.0', constraintsOf(entry('1.4.0', { software: '>=1.0.0 <2.0.0' })))).toEqual([]);
  });

  it('treats a non-semver version as unverifiable, not broken', () => {
    expect(unsatisfied('nightly', constraintsOf(entry('nightly', { software: '>=1.0.0' })))).toEqual([]);
  });
});

describe('formatConstraints', () => {
  it('names the range and the package that declared it', () => {
    expect(formatConstraints([{ requiredBy: 'software', range: '<1.5.0' }]))
      .toBe("'<1.5.0' (required by software)");
  });
});
