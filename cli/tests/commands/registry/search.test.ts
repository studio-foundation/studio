import { describe, it, expect } from 'vitest';
import type { PackageEntry } from '../../../src/registry/types.js';

const MOCK_PACKAGES: PackageEntry[] = [
  { name: 'software', type: 'template', version: '1.0.0', description: 'Code generation', author: 'studio-core', license: 'MIT', tags: ['software', 'code'], studio_version: null, downloads: 10 },
  { name: 'content', type: 'template', version: '1.0.0', description: 'Content creation', author: 'studio-core', license: 'MIT', tags: ['content', 'writing'], studio_version: null, downloads: 5 },
  { name: 'linear', type: 'integration', version: '1.0.0', description: 'Linear integration', author: 'studio-core', license: 'MIT', tags: ['linear'], studio_version: null, downloads: 3 },
];

describe('searchPackages', () => {
  it('filters by name match', async () => {
    const { searchPackages } = await import('../../../src/commands/registry/search.js');
    const results = searchPackages(MOCK_PACKAGES, 'software');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('software');
  });

  it('filters by description match', async () => {
    const { searchPackages } = await import('../../../src/commands/registry/search.js');
    const results = searchPackages(MOCK_PACKAGES, 'creation');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('content');
  });

  it('filters by type', async () => {
    const { searchPackages } = await import('../../../src/commands/registry/search.js');
    const results = searchPackages(MOCK_PACKAGES, undefined, 'integration');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('linear');
  });

  it('returns all packages when no query and no type', async () => {
    const { searchPackages } = await import('../../../src/commands/registry/search.js');
    const results = searchPackages(MOCK_PACKAGES);
    expect(results).toHaveLength(3);
  });

  it('filters by tag match', async () => {
    const { searchPackages } = await import('../../../src/commands/registry/search.js');
    const results = searchPackages(MOCK_PACKAGES, 'writing');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('content');
  });
});
