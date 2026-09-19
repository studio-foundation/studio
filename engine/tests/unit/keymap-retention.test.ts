import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PipelineEngine, KEYMAP_TTL_MS } from '../../src/engine.js';

describe('keymap retention', () => {
  it('purges keymaps older than the TTL when a new one is written, keeps recent ones', async () => {
    const configsDir = mkdtempSync(join(tmpdir(), 'studio-keymap-'));
    const anonDir = join(configsDir, 'runs', 'anonymization');
    mkdirSync(anonDir, { recursive: true });
    const old = join(anonDir, 'old.keymap.json');
    const recent = join(anonDir, 'recent.keymap.json');
    writeFileSync(old, '{"EMAIL_1":"a@b.c"}');
    writeFileSync(recent, '{"EMAIL_1":"d@e.f"}');
    const stale = new Date(Date.now() - KEYMAP_TTL_MS - 60_000);
    utimesSync(old, stale, stale);

    const engine = new PipelineEngine({ configsDir, providerRegistry: {} as never });
    await (engine as unknown as { persistKeymap(id: string, k: Record<string, string>): Promise<void> })
      .persistKeymap('new', { EMAIL_1: 'g@h.i' });

    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(join(anonDir, 'new.keymap.json'))).toBe(true);
  });
});
