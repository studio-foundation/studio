/**
 * Proves `on_failure: ask` (STU-1604) on the two paths it was never exercised
 * on: a `--live` run, where the tool and thinking spinners draw at the same
 * time as the prompt, and a `call`/`map` child run, which gets `askHuman`
 * through the shared engine config. Both need a real pty — `askHuman` is only
 * wired up when `process.stdin.isTTY && process.stdout.isTTY`
 * (cli/src/commands/run.ts) — so a plain piped subprocess exercises neither.
 *
 * Fixture: cli/tests/fixtures/hook-ask/ — ask-live.pipeline.yaml guards a tool
 * call with a pre_tool_use hook that always fails and asks; ask-call.pipeline.yaml
 * calls it as a child; ask-map.pipeline.yaml fans out over it with concurrency 2.
 *
 * `DONE` below is inquirer's *final* render of an answered confirm() prompt.
 * Every keystroke redraws the same open prompt (the raw pty stream shows the
 * question text 2-3 times for one logical ask: the bare prompt, the prompt
 * with the typed key, then this one), so it is the only substring in the
 * stream that identifies one *resolved* ask unambiguously.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInPty, answerEachInTurn, stripAnsi } from '../utils/pty-run.js';

const FIXTURE_DIR = resolve(import.meta.dirname, '../fixtures/hook-ask');
const QUESTION = 'run the noop command?';
const DONE = `✔ ${QUESTION} Yes`;

interface HookAskEvent {
  event: string;
  tool: string;
  question: string;
  answer: string;
  depth?: number;
}

function readHookAskEvents(pipeline: string): HookAskEvent[] {
  const runsDir = resolve(FIXTURE_DIR, '.studio', 'runs');
  const files = readdirSync(runsDir).filter((f) => f.endsWith('.jsonl') && f.includes(`-${pipeline}-`));
  const events: HookAskEvent[] = [];
  for (const file of files) {
    const path = resolve(runsDir, file);
    const lines = readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    events.push(...lines.filter((l) => l.event === 'hook_ask'));
    rmSync(path, { force: true });
  }
  return events;
}

describe('on_failure: ask under a real pty (STU-1640)', () => {
  it('shows the prompt once under --live, resumes the spinners, and logs the answer', async () => {
    const { exitCode, output } = await runInPty({
      cwd: FIXTURE_DIR,
      args: ['run', 'ask-live', '--input', 'go', '--provider', 'mock', '--live'],
      onData: answerEachInTurn(QUESTION),
    });
    const clean = stripAnsi(output);

    expect(exitCode).toBe(0);
    expect(clean.split(DONE).length - 1).toBe(1);
    // Execution continued past the prompt — reaching the pipeline's own
    // completion line needs the paused spinners to have actually resumed.
    expect(clean.indexOf('Pipeline completed', clean.indexOf(DONE))).toBeGreaterThan(-1);

    const events = readHookAskEvents('ask-live');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tool: 'noop-run_command', answer: 'yes' });
  });

  it('asks from a call stage child, and the prompt reaches the terminal', async () => {
    const { exitCode, output } = await runInPty({
      cwd: FIXTURE_DIR,
      args: ['run', 'ask-call', '--input', 'go', '--provider', 'mock'],
      onData: answerEachInTurn(QUESTION),
    });
    const clean = stripAnsi(output);

    expect(exitCode).toBe(0);
    expect(clean.split(DONE).length - 1).toBe(1);

    const events = readHookAskEvents('ask-call');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tool: 'noop-run_command', answer: 'yes' });
    // The ask happened inside the called child, not the root pipeline.
    expect(events[0].depth).toBeGreaterThan(0);
  });

  it('asks two map items in turn, never overlapping their prompts', async () => {
    const { exitCode, output } = await runInPty({
      cwd: FIXTURE_DIR,
      args: ['run', 'ask-map', '--input-file', 'items.input.yaml', '--provider', 'mock'],
      onData: answerEachInTurn(QUESTION),
    });
    const clean = stripAnsi(output);

    expect(exitCode).toBe(0);
    const doneCount = clean.split(DONE).length - 1;
    expect(doneCount).toBe(2);

    // Serialization proof: the second item's prompt is a fresh "(y/N)" render,
    // and none of those exist before the first ask is fully resolved — if the
    // two had overlapped, both items' prompts would render before either
    // resolved, inflating this count.
    const firstDoneEnd = clean.indexOf(DONE) + DONE.length;
    const promptsBeforeFirstResolved = (clean.slice(0, firstDoneEnd).match(/\(y\/N\)/g) ?? []).length;
    expect(promptsBeforeFirstResolved).toBe(2); // the one item's bare + typed-key renders, not the other item's too

    const events = readHookAskEvents('ask-map');
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e).toMatchObject({ tool: 'noop-run_command', answer: 'yes' });
      expect(e.depth).toBeGreaterThan(0);
    }
  });
});
