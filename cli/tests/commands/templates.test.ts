import { describe, it, expect } from 'vitest';
import { listTemplates } from '../../src/commands/templates.js';

describe('listTemplates', () => {
  it('returns all 5 built-in templates', async () => {
    const templates = await listTemplates();
    const names = templates.map((t) => t.name);
    expect(names).toContain('blank');
    expect(names).toContain('software');
    expect(names).toContain('software-full');
    expect(names).toContain('content');
    expect(names).toContain('document-analysis');
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
