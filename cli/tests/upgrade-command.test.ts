import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../src/upgrade.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/upgrade.js')>()),
  detectInstall: () => ({ kind: 'npm' }),
}));

const { upgradeCommand } = await import('../src/commands/upgrade.js');
const { installCommand } = await import('../src/upgrade.js');

afterEach(() => vi.restoreAllMocks());

describe('studio upgrade on an npm install', () => {
  it('prints the binary installer and the npm uninstall, never npm i -g', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await upgradeCommand();
    const printed = log.mock.calls.flat().join('\n');
    expect(printed).toContain(installCommand());
    expect(printed).toContain('npm uninstall -g @studio-foundation/cli');
    expect(printed).not.toContain('npm i -g');
  });
});
