/**
 * Proves `interactive: false` (STU-1675) suppresses both `on_failure: ask` and the
 * `approval:` stage pause even when a real TTY is attached — the gate that matters is
 * the config key, not just terminal detection. Needs a real pty: without one, neither
 * feature wires up anyway (`process.stdin.isTTY && process.stdout.isTTY`), so a plain
 * piped subprocess would prove nothing about the config key itself.
 *
 * Fixture: cli/tests/fixtures/noninteractive-config/ — `.studio/config.yaml` sets
 * `interactive: false`. `noninteractive-ask.pipeline.yaml` guards a tool call with an
 * always-failing `on_failure: ask` hook; `noninteractive-approval.pipeline.yaml` has a
 * stage with `approval: { on_unavailable: auto-approve }`.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInPty, stripAnsi } from '../utils/pty-run.js';

const FIXTURE_DIR = resolve(import.meta.dirname, '../fixtures/noninteractive-config');

function readEvents(pipeline: string, event: string): Record<string, unknown>[] {
  const runsDir = resolve(FIXTURE_DIR, '.studio', 'runs');
  const files = readdirSync(runsDir).filter((f) => f.endsWith('.jsonl') && f.includes(`-${pipeline}-`));
  const found: Record<string, unknown>[] = [];
  for (const file of files) {
    const path = resolve(runsDir, file);
    const lines = readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    found.push(...lines.filter((l) => l.event === event));
    rmSync(path, { force: true });
  }
  return found;
}

describe('interactive: false under a real pty (STU-1675)', () => {
  it('suppresses the ask prompt and resolves it as unavailable, even with a TTY attached', async () => {
    const { output } = await runInPty({
      cwd: FIXTURE_DIR,
      args: ['run', 'noninteractive-ask', '--input', 'go', '--provider', 'mock'],
    });
    const clean = stripAnsi(output);

    // The pre_tool_use hook still blocks the call (the mock provider doesn't fail a
    // stage over a blocked tool call), so the meaningful proof is the prompt never
    // rendering and the hook resolving as 'unavailable' — not the pipeline's own exit code.
    expect(clean).not.toContain('run the noop command?');

    const events = readEvents('noninteractive-ask', 'hook_ask');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tool: 'noop-run_command', answer: 'unavailable' });
  });

  it('suppresses the approval prompt and auto-approves, even with a TTY attached', async () => {
    const { exitCode, output } = await runInPty({
      cwd: FIXTURE_DIR,
      args: ['run', 'noninteractive-approval', '--input', 'go', '--provider', 'mock'],
    });
    const clean = stripAnsi(output);

    expect(clean).not.toContain('Approve as-is?');
    expect(exitCode).toBe(0);

    const events = readEvents('noninteractive-approval', 'stage_pause');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stage: 'touch', decision: 'auto_approved' });
  });
});
