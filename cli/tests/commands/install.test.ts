import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'node:child_process';
import { installExtensionCommand } from '../../src/commands/install.js';

const mockExecSync = vi.mocked(execSync);

beforeEach(() => {
  mockExecSync.mockClear();
});

describe('installExtensionCommand', () => {
  it('runs npm install -g @studio-foundation/api when extension is "api"', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await installExtensionCommand('api');

    expect(mockExecSync).toHaveBeenCalledWith('npm install -g @studio-foundation/api', { stdio: 'inherit' });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('@studio-foundation/api installed'));
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('exits with error for unknown extension', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await expect(installExtensionCommand('web')).rejects.toThrow('exit');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown extension'));
    expect(exitSpy).toHaveBeenCalledWith(1);
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('exits with error when npm install fails', async () => {
    mockExecSync.mockImplementationOnce(() => { throw new Error('npm ERR! 404'); });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await expect(installExtensionCommand('api')).rejects.toThrow('exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
