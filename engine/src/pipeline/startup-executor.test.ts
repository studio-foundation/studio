import { describe, it, expect, vi } from 'vitest';
import { executeStartupCommands } from './startup-executor.js';

describe('executeStartupCommands', () => {
  it('returns stdout keyed by inject_as', async () => {
    const result = await executeStartupCommands([
      { command: 'echo hello', inject_as: 'greeting' },
      { command: 'echo world', inject_as: 'place' },
    ]);
    expect(result.greeting).toBe('hello');
    expect(result.place).toBe('world');
  });

  it('skips and warns when a command fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await executeStartupCommands([
      { command: 'exit 1', inject_as: 'bad' },
      { command: 'echo ok', inject_as: 'good' },
    ]);
    expect(result.bad).toBeUndefined();
    expect(result.good).toBe('ok');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[on_pipeline_start]'));
    warnSpy.mockRestore();
  });

  it('returns empty object when no commands given', async () => {
    const result = await executeStartupCommands([]);
    expect(result).toEqual({});
  });

  it('trims trailing whitespace from stdout', async () => {
    const result = await executeStartupCommands([
      { command: 'printf "trimmed"', inject_as: 'val' },
    ]);
    expect(result.val).toBe('trimmed');
  });
});
