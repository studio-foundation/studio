// Stage lifecycle state machine
// Keeps it simple: linear transitions, no DAG

export type StageLifecycleState = 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'rejected';

type StageEvent = 'start' | 'succeed' | 'fail' | 'skip' | 'reject';

const VALID_TRANSITIONS: Record<string, StageLifecycleState> = {
  'pending:start': 'running',
  'running:succeed': 'success',
  'running:fail': 'failed',
  'pending:skip': 'skipped',
  'running:reject': 'rejected',
};

export function isValidTransition(from: StageLifecycleState, to: StageLifecycleState): boolean {
  for (const [key, target] of Object.entries(VALID_TRANSITIONS)) {
    if (key.startsWith(`${from}:`) && target === to) {
      return true;
    }
  }
  return false;
}

export function transition(current: StageLifecycleState, event: StageEvent): StageLifecycleState {
  const key = `${current}:${event}`;
  const next = VALID_TRANSITIONS[key];

  if (!next) {
    throw new Error(`Invalid state transition: ${current} + ${event}`);
  }

  return next;
}
