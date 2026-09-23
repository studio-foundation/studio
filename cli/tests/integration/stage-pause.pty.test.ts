/**
 * Proves the STU-1653 `approval` stage pause under a real pty — `reviewStageOutput`
 * is only wired up when `process.stdin.isTTY && process.stdout.isTTY`
 * (cli/src/commands/run.ts), so a plain piped subprocess exercises neither path.
 *
 * Fixture: cli/tests/fixtures/stage-pause/ — approval-pause.pipeline.yaml has one
 * stage carrying `approval: {}` (default on_unavailable: fail, irrelevant here since
 * a reviewer is always available under a pty).
 *
 * The edit case drives the `editor()` sub-prompt via `fake-editor.mjs`, set as
 * `$EDITOR`: it rewrites the temp file non-interactively so no real keystrokes are
 * needed for the spawned editor process itself, only the "launch it" Enter.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInPty, answerEachInTurn, stripAnsi } from '../utils/pty-run.js';

const FIXTURE_DIR = resolve(import.meta.dirname, '../fixtures/stage-pause');
const FAKE_EDITOR = resolve(FIXTURE_DIR, 'fake-editor.mjs');
const FAKE_EDITOR_TOGGLE = resolve(FIXTURE_DIR, 'fake-editor-toggle.mjs');

interface StagePauseEvent {
  event: string;
  stage: string;
  original_output: unknown;
  resolved_output: unknown;
  decision: string;
}

function readStagePauseEvents(pipeline: string): StagePauseEvent[] {
  const runsDir = resolve(FIXTURE_DIR, '.studio', 'runs');
  const files = readdirSync(runsDir).filter((f) => f.endsWith('.jsonl') && f.includes(`-${pipeline}-`));
  const events: StagePauseEvent[] = [];
  for (const file of files) {
    const path = resolve(runsDir, file);
    const lines = readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    events.push(...lines.filter((l) => l.event === 'stage_pause'));
    rmSync(path, { force: true });
  }
  return events;
}

const originalEditor = process.env.EDITOR;
afterEach(() => {
  if (originalEditor === undefined) delete process.env.EDITOR;
  else process.env.EDITOR = originalEditor;
});

describe('stage approval pause under a real pty (STU-1653)', () => {
  it('approves as-is and logs the same output on both sides', async () => {
    const { exitCode, output } = await runInPty({
      cwd: FIXTURE_DIR,
      args: ['run', 'approval-pause', '--input', 'go', '--provider', 'mock'],
      onData: answerEachInTurn('Approve as-is?'),
    });
    const clean = stripAnsi(output);

    expect(exitCode).toBe(0);
    expect(clean).toContain('Pipeline completed');

    const events = readStagePauseEvents('approval-pause');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      stage: 'touch',
      decision: 'approved',
      original_output: { summary: 'done' },
      resolved_output: { summary: 'done' },
    });
  });

  it('edits via $EDITOR and logs the edited output', async () => {
    process.env.EDITOR = `node ${FAKE_EDITOR}`;

    // @inquirer/external-editor can fire a stray completion callback after the
    // pipeline has already finished and printed its result, throwing
    // ERR_USE_AFTER_CLOSE on the by-then-closed readline interface and taking
    // the process down with a nonzero exit code (STU-1682). The @inquirer/prompts
    // bump that pulled in @inquirer/external-editor 3.x cut this from ~50% to
    // ~15% under load, but didn't eliminate it — retry past the residual race
    // rather than flake, discarding the crashed attempt's run log so the
    // eventual event read below only sees the run that actually completed.
    let exitCode: number | null = null;
    let clean = '';
    for (let attempt = 0; attempt < 3 && exitCode !== 0; attempt++) {
      const declineApproval = answerEachInTurn('Approve as-is?', { key: 'n\r' });
      const launchEditor = answerEachInTurn('launch your preferred editor', { key: '\r' });
      const result = await runInPty({
        cwd: FIXTURE_DIR,
        args: ['run', 'approval-pause', '--input', 'go', '--provider', 'mock'],
        onData: (out, write) => {
          declineApproval(out, write);
          launchEditor(out, write);
        },
      });
      exitCode = result.exitCode;
      clean = stripAnsi(result.output);
      if (exitCode !== 0) readStagePauseEvents('approval-pause');
    }

    expect(exitCode).toBe(0);
    expect(clean).toContain('Pipeline completed');

    const events = readStagePauseEvents('approval-pause');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      stage: 'touch',
      decision: 'edited',
      original_output: { summary: 'done' },
      resolved_output: { summary: 'EDITED BY HUMAN' },
    });
  });

  it('rejects an edit that drops a required field and re-prompts until it is fixed (STU-1673)', async () => {
    process.env.EDITOR = `node ${FAKE_EDITOR_TOGGLE}`;
    const declineApproval = answerEachInTurn('Approve as-is?', { key: 'n\r' });
    const launchEditor = answerEachInTurn('launch your preferred editor', { key: '\r' });

    const { exitCode, output } = await runInPty({
      cwd: FIXTURE_DIR,
      args: ['run', 'approval-edit-validate', '--input', 'go', '--provider', 'mock'],
      onData: (out, write) => {
        declineApproval(out, write);
        launchEditor(out, write);
      },
    });
    const clean = stripAnsi(output);

    expect(exitCode).toBe(0);
    expect(clean).toContain('Pipeline completed');
    expect(clean).toContain("doesn't satisfy stage \"touch\"'s contract");
    expect(clean).toContain('Missing required field: requirements');

    const events = readStagePauseEvents('approval-edit-validate');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      stage: 'touch',
      decision: 'edited',
      original_output: { summary: 'done', requirements: ['a', 'b'] },
      resolved_output: { summary: 'done', requirements: ['fixed'] },
    });
  });

  it('pauses from a call stage child, and the prompt reaches the terminal', async () => {
    const { exitCode, output } = await runInPty({
      cwd: FIXTURE_DIR,
      args: ['run', 'approval-call', '--input', 'go', '--provider', 'mock'],
      onData: answerEachInTurn('Approve as-is?'),
    });
    const clean = stripAnsi(output);

    expect(exitCode).toBe(0);
    expect(clean).toContain('Pipeline completed');

    const events = readStagePauseEvents('approval-call');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      stage: 'touch',
      decision: 'approved',
      original_output: { summary: 'done' },
      resolved_output: { summary: 'done' },
    });
    // The pause happened inside the called child, not the root pipeline.
    expect(events[0].depth).toBeGreaterThan(0);
  });

  it('pauses for two map items in turn, never overlapping their prompts', async () => {
    const { exitCode, output } = await runInPty({
      cwd: FIXTURE_DIR,
      args: ['run', 'approval-map', '--input-file', 'items.input.yaml', '--provider', 'mock'],
      onData: answerEachInTurn('Approve as-is?'),
    });
    const clean = stripAnsi(output);

    expect(exitCode).toBe(0);
    expect(clean).toContain('Pipeline completed');

    const events = readStagePauseEvents('approval-map');
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e).toMatchObject({
        stage: 'touch',
        decision: 'approved',
        original_output: { summary: 'done' },
        resolved_output: { summary: 'done' },
      });
      expect(e.depth).toBeGreaterThan(0);
    }
  });

  it('pauses from a stage nested in a group, reusing the same StageExecutor', async () => {
    const { exitCode, output } = await runInPty({
      cwd: FIXTURE_DIR,
      args: ['run', 'approval-group', '--input', 'go', '--provider', 'mock'],
      onData: answerEachInTurn('Approve as-is?'),
    });
    const clean = stripAnsi(output);

    expect(exitCode).toBe(0);
    expect(clean).toContain('Pipeline completed');

    const events = readStagePauseEvents('approval-group');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      stage: 'touch',
      decision: 'approved',
      original_output: { summary: 'done' },
      resolved_output: { summary: 'done' },
    });
  });
});
