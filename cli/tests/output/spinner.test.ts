import { describe, it, expect, vi, beforeEach } from 'vitest';

const oraSpy = vi.fn(() => ({ start: () => ({}) }));
vi.mock('ora', () => ({ default: oraSpy }));

// Imported after the mock is registered.
const { makeSpinner } = await import('../../src/output/spinner.js');

describe('makeSpinner', () => {
  beforeEach(() => oraSpy.mockClear());

  // Regression: ora's default discardStdin flips stdin into raw mode, which disables
  // the terminal's Ctrl-C→SIGINT translation and made runs uncancellable while a
  // spinner was on screen. Every spinner must opt out of it.
  it('forces discardStdin off for an options object', () => {
    makeSpinner({ text: 'Thinking...', color: 'gray' });
    expect(oraSpy).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Thinking...', color: 'gray', discardStdin: false }),
    );
  });

  it('forces discardStdin off for a string arg', () => {
    makeSpinner('Loading...');
    expect(oraSpy).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Loading...', discardStdin: false }),
    );
  });
});
