// Drives the built CLI inside a real pseudo-terminal, the only way to exercise
// `askHuman` (cli/src/commands/run.ts gates it on process.stdin.isTTY &&
// process.stdout.isTTY). A window size must be set explicitly — an
// unconfigured pty reports 0x0, which starves ora's spinner loop.
import * as pty from 'node-pty';
import { resolve } from 'node:path';

const CLI_BIN = resolve(import.meta.dirname, '../../dist/index.js');

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /[\u001B\u009B][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

/** Strips terminal escape sequences so assertions can match on plain text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

export interface PtyRunResult {
  exitCode: number | null;
  output: string;
}

export interface PtyRunOptions {
  cwd: string;
  args: string[];
  /** Timeout in ms before the pty is killed and the run rejects. */
  timeoutMs?: number;
  /** Called on every data chunk with the output collected so far and a way to reply. */
  onData?: (output: string, write: (text: string) => void) => void;
}

export function runInPty({ cwd, args, timeoutMs = 20_000, onData }: PtyRunOptions): Promise<PtyRunResult> {
  return new Promise((resolvePromise, reject) => {
    const term = pty.spawn(process.execPath, [CLI_BIN, ...args], {
      name: 'xterm-color',
      cols: 120,
      rows: 30,
      cwd,
      env: { ...process.env, NO_COLOR: '1' } as Record<string, string>,
    });

    let output = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { term.kill(); } catch { /* already gone */ }
      reject(new Error(`pty did not exit within ${timeoutMs}ms. Output so far:\n${output}`));
    }, timeoutMs);

    term.onData((chunk) => {
      output += chunk;
      onData?.(output, (text) => term.write(text));
    });

    term.onExit(({ exitCode }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ exitCode, output });
    });
  });
}

/**
 * Answers each occurrence of `question` in turn, one at a time, with "y" + Enter.
 * Inquirer re-renders the same open prompt on every keystroke, so a raw
 * substring count would reply many times to one question; this instead waits
 * for `idleMs` of silence after a *new* (unanswered) occurrence shows up
 * before replying, which collapses those re-renders into a single reply, and
 * only searches the buffer past the point of the last reply so that prompt's
 * own leftover text is never mistaken for a fresh occurrence.
 */
export function answerEachInTurn(question: string, opts: { key?: string; idleMs?: number } = {}) {
  const key = opts.key ?? 'y\r';
  const idleMs = opts.idleMs ?? 200;
  let searchFrom = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  return (output: string, write: (text: string) => void): void => {
    const idx = output.indexOf(question, searchFrom);
    if (idx === -1) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      searchFrom = idx + question.length;
      write(key);
    }, idleMs);
  };
}
