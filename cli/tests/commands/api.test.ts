import { describe, it, expect, vi, afterEach } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => tmpdir() };
});

// Import after mocking
const { apiStopCommand, apiStatusCommand, writePid, readPid, clearPid, isProcessAlive } = await import('../../src/commands/api.js');

afterEach(async () => {
  await clearPid();
});

describe('writePid / readPid / clearPid', () => {
  it('writes and reads PID with port', async () => {
    await writePid(3700);
    const entry = await readPid();
    expect(entry).not.toBeNull();
    expect(entry!.pid).toBe(process.pid);
    expect(entry!.port).toBe(3700);
  });

  it('readPid returns null when no file exists', async () => {
    const entry = await readPid();
    expect(entry).toBeNull();
  });

  it('clearPid removes the file', async () => {
    await writePid(3700);
    await clearPid();
    const entry = await readPid();
    expect(entry).toBeNull();
  });
});

describe('isProcessAlive', () => {
  it('returns true for the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('returns false for a non-existent PID', () => {
    // PID 999999999 is very unlikely to exist
    expect(isProcessAlive(999999999)).toBe(false);
  });
});

describe('apiStopCommand', () => {
  it('prints "not running" when no PID file', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await apiStopCommand();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('not running'));
    consoleSpy.mockRestore();
  });

  it('prints "stale PID" and clears file when process is dead', async () => {
    await writePid(3700);
    // Overwrite with a dead PID
    const pidFile = join(tmpdir(), '.studio', 'api.pid');
    await writeFile(pidFile, '999999999:3700', 'utf-8');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await apiStopCommand();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('stale'));
    expect(await readPid()).toBeNull();
    consoleSpy.mockRestore();
  });

  it('sends SIGTERM and clears PID when process is the current process', async () => {
    await writePid(3700);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await apiStopCommand();

    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(await readPid()).toBeNull();
    killSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});

describe('apiStatusCommand', () => {
  it('prints "not running" when no PID file', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await apiStatusCommand({});
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('not running'));
    consoleSpy.mockRestore();
  });

  it('prints "running" when process is alive and health check succeeds', async () => {
    await writePid(3700);
    // Override with current PID (alive) and mock fetch
    global.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await apiStatusCommand({});

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('running'));
    consoleSpy.mockRestore();
  });
});
