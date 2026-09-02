import { describe, it, expect } from 'vitest';
import { childStageUsage, childRunErrorMessage } from '../src/spawner.js';
import type { StageRun } from '../src/run.js';

const run = (attempt: number, error?: string) => ({ attempt, ...(error ? { error } : {}) });

const stage = (
  stage_name: string,
  status: string,
  agent_runs: Array<{ attempt: number; error?: string }>,
  token_usage?: { total_tokens: number },
): StageRun =>
  ({ id: stage_name, stage_name, status, started_at: '', tasks: [{ agent_runs }], token_usage }) as unknown as StageRun;

describe('childStageUsage', () => {
  it('reports the highest attempt the stage recorded, not the number of stages', () => {
    const [a] = childStageUsage([stage('a', 'success', [run(1), run(2), run(3)])]);
    expect(a.attempts).toBe(3);
  });

  it('reads attempts across every task, not only the first', () => {
    const s = { id: 'a', stage_name: 'a', status: 'success', started_at: '',
      tasks: [{ agent_runs: [run(1)] }, { agent_runs: [run(1), run(2)] }] } as unknown as StageRun;
    expect(childStageUsage([s])[0].attempts).toBe(2);
  });

  it('omits token_usage rather than inventing a zero', () => {
    expect(childStageUsage([stage('a', 'success', [run(1)])])[0]).toEqual({
      stage: 'a', status: 'success', attempts: 1,
    });
  });

  it('carries token_usage through when the stage reported one', () => {
    const [a] = childStageUsage([stage('a', 'success', [run(1)], { total_tokens: 42 })]);
    expect(a.token_usage).toEqual({ total_tokens: 42 });
  });

  it('preserves stage order and status', () => {
    const got = childStageUsage([stage('a', 'success', [run(1)]), stage('b', 'failed', [run(1)])]);
    expect(got.map((s) => [s.stage, s.status])).toEqual([['a', 'success'], ['b', 'failed']]);
  });
});

describe('childRunErrorMessage', () => {
  it('finds the error on the last failed stage', () => {
    const msg = childRunErrorMessage([
      stage('a', 'success', [run(1)]),
      stage('b', 'failed', [run(1), run(2, 'HTTP 400')]),
    ]);
    expect(msg).toBe('HTTP 400');
  });

  it('takes the latest error when a stage recorded several', () => {
    expect(childRunErrorMessage([stage('b', 'failed', [run(1, 'first'), run(2, 'second')])])).toBe('second');
  });

  it('reads rejected and cancelled as terminal too', () => {
    expect(childRunErrorMessage([stage('b', 'rejected', [run(1, 'QA said no')])])).toBe('QA said no');
    expect(childRunErrorMessage([stage('b', 'cancelled', [run(1, 'aborted')])])).toBe('aborted');
  });

  it('is undefined when no stage failed', () => {
    expect(childRunErrorMessage([stage('a', 'success', [run(1)])])).toBeUndefined();
  });

  it('is undefined when the failed stage recorded no error', () => {
    expect(childRunErrorMessage([stage('b', 'failed', [run(1)])])).toBeUndefined();
    expect(childRunErrorMessage([])).toBeUndefined();
  });
});
