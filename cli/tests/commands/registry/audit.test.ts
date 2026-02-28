import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const TMP = resolve(import.meta.dirname, '.tmp-audit');
const STUDIO = join(TMP, '.studio');
const TOOLS = join(STUDIO, 'tools');

beforeEach(async () => {
  await mkdir(TOOLS, { recursive: true });
});
afterEach(async () => { await rm(TMP, { recursive: true, force: true }); });

describe('auditPackages', () => {
  it('returns ok for intact file', async () => {
    const content = 'name: my-tool\n';
    const sha256 = createHash('sha256').update(content).digest('hex');
    await writeFile(join(TOOLS, 'my-tool.tool.yaml'), content);
    await writeFile(join(STUDIO, 'registry.lock.json'), JSON.stringify({
      installed: { 'my-tool': { version: '1.0.0', type: 'tool', installed_at: '2026-02-28', sha256 } },
    }));

    const { auditPackages } = await import('../../../src/commands/registry/audit.js');
    const results = await auditPackages({ studioDir: STUDIO });
    expect(results[0].ok).toBe(true);
    expect(results[0].status).toBe('ok');
  });

  it('returns tampered for modified file', async () => {
    const original = 'name: my-tool\n';
    const sha256 = createHash('sha256').update(original).digest('hex');
    await writeFile(join(TOOLS, 'my-tool.tool.yaml'), 'name: evil-tool\n'); // tampered
    await writeFile(join(STUDIO, 'registry.lock.json'), JSON.stringify({
      installed: { 'my-tool': { version: '1.0.0', type: 'tool', installed_at: '2026-02-28', sha256 } },
    }));

    const { auditPackages } = await import('../../../src/commands/registry/audit.js');
    const results = await auditPackages({ studioDir: STUDIO });
    expect(results[0].ok).toBe(false);
    expect(results[0].status).toBe('tampered');
  });

  it('returns missing when file does not exist', async () => {
    const sha256 = createHash('sha256').update('content').digest('hex');
    await writeFile(join(STUDIO, 'registry.lock.json'), JSON.stringify({
      installed: { 'my-tool': { version: '1.0.0', type: 'tool', installed_at: '2026-02-28', sha256 } },
    }));
    // no file written to TOOLS

    const { auditPackages } = await import('../../../src/commands/registry/audit.js');
    const results = await auditPackages({ studioDir: STUDIO });
    expect(results[0].ok).toBe(false);
    expect(results[0].status).toBe('missing');
  });
});
