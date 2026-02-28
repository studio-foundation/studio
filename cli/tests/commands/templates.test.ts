import { describe, it, expect } from 'vitest';
import { listTemplates } from '../../src/commands/templates.js';

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
