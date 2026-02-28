import { describe, it, expect, vi } from 'vitest';
import { listTemplates } from '../../src/commands/templates.js';

// Mock registry so tests only exercise local (bundled) templates
vi.mock('../../src/commands/registry/sync.js', () => ({
  syncRegistry: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/registry/cache.js', () => {
  class RegistryCache {
    read() { return Promise.resolve(null); }
    write() { return Promise.resolve(undefined); }
    isFresh() { return Promise.resolve(false); }
  }
  return { RegistryCache };
});

describe('listTemplates', () => {
  it('returns blank as the only built-in template (others are in the registry)', async () => {
    const templates = await listTemplates();
    const names = templates.map((t) => t.name);
    expect(names).toContain('blank');
    expect(names).not.toContain('software');
    expect(names).not.toContain('software-full');
    expect(names).not.toContain('content');
    expect(names).not.toContain('document-analysis');
  });

  it('each template has name, version, description', async () => {
    const templates = await listTemplates();
    for (const t of templates) {
      expect(t.name).toBeTruthy();
      expect(t.version).toBeTruthy();
      expect(t.description).toBeTruthy();
    }
  });

  it('templates are sorted alphabetically', async () => {
    const templates = await listTemplates();
    const names = templates.map((t) => t.name);
    expect(names).toEqual([...names].sort());
  });
});
