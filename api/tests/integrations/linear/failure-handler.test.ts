import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LinearFailureHandler } from '../../../src/integrations/linear/failure-handler.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const STATES_RESPONSE = {
  data: {
    issue: {
      team: {
        states: { nodes: [{ id: 'state-backlog', name: 'Backlog' }, { id: 'state-todo', name: 'Todo' }] },
      },
    },
  },
};
const COMMENT_RESPONSE = { data: { commentCreate: { success: true } } };
const UPDATE_RESPONSE = { data: { issueUpdate: { success: true } } };

function makeCtx(overrides: {
  apiKey?: string;
  issueId?: string;
  runId?: string;
  iterations?: number;
  rejectionReason?: string;
  rejectionDetails?: string[];
} = {}) {
  return {
    runId: overrides.runId ?? 'run-123',
    durationMs: 5000,
    status: 'failed',
    meta: { linear_issue_id: overrides.issueId ?? 'issue-abc' },
    lastGroupFeedback: overrides.iterations != null ? {
      iteration: overrides.iterations,
      rejection_reason: overrides.rejectionReason,
      rejection_details: overrides.rejectionDetails,
    } as never : undefined,
    integration: { name: 'linear', version: 1, on_failure: { handler: 'linear-failure' } },
    integrationConfig: { LINEAR_API_KEY: overrides.apiKey ?? 'lin_api_test' },
  };
}

beforeEach(() => { mockFetch.mockReset(); });
afterEach(() => { delete process.env['LINEAR_API_KEY']; });

describe('LinearFailureHandler.handleFailure', () => {
  const handler = new LinearFailureHandler();

  it('skips when no LINEAR_API_KEY in integrationConfig or env', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx = makeCtx({ apiKey: '' });
    await handler.handleFailure(ctx);
    expect(mockFetch).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('skips when meta has no linear_issue_id', async () => {
    const ctx = { ...makeCtx(), meta: {} };
    await handler.handleFailure(ctx);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('posts comment, queries states, and transitions to Backlog on failure', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(COMMENT_RESPONSE) } as Response)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(STATES_RESPONSE) } as Response)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(UPDATE_RESPONSE) } as Response);

    await handler.handleFailure(makeCtx({
      issueId: 'issue-xyz', runId: 'run-456',
      iterations: 3, rejectionReason: 'QA rejected', rejectionDetails: ['Hardcoded strings'],
    }));

    expect(mockFetch).toHaveBeenCalledTimes(3);
    const [, commentInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(commentInit.body as string) as { variables: { body: string } };
    expect(body.variables.body).toContain('❌ **Code Builder échoué**');
    expect(body.variables.body).toContain('3 itérations QA');
    expect(body.variables.body).toContain('run-456');
    expect(body.variables.body).toContain('Hardcoded strings');
  });

  it('posts comment even when Backlog state is not found', async () => {
    const noBacklog = { data: { issue: { team: { states: { nodes: [{ id: 'state-todo', name: 'Todo' }] } } } } };
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(COMMENT_RESPONSE) } as Response)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(noBacklog) } as Response);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await handler.handleFailure(makeCtx());
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"Backlog" state not found'));
    warnSpy.mockRestore();
  });

  it('swallows fetch errors and logs them', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network timeout'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(handler.handleFailure(makeCtx())).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('uses process.env.LINEAR_API_KEY as fallback', async () => {
    process.env['LINEAR_API_KEY'] = 'env-key';
    const ctxNoKey = { ...makeCtx(), integrationConfig: {} };
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(COMMENT_RESPONSE) } as Response)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(STATES_RESPONSE) } as Response)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(UPDATE_RESPONSE) } as Response);
    await handler.handleFailure(ctxNoKey);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
