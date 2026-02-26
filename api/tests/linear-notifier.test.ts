import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { notifyLinearFailure } from '../src/linear-notifier.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function okResponse(data: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
  } as Response);
}

const STATES_RESPONSE = {
  data: {
    issue: {
      team: {
        states: {
          nodes: [
            { id: 'state-backlog', name: 'Backlog' },
            { id: 'state-todo', name: 'Todo' },
            { id: 'state-in-progress', name: 'In Progress' },
          ],
        },
      },
    },
  },
};

const COMMENT_RESPONSE = { data: { commentCreate: { success: true } } };
const UPDATE_RESPONSE = { data: { issueUpdate: { success: true } } };

beforeEach(() => {
  mockFetch.mockReset();
  delete process.env['LINEAR_API_KEY'];
});

afterEach(() => {
  delete process.env['LINEAR_API_KEY'];
});

describe('notifyLinearFailure', () => {
  it('skips and warns when LINEAR_API_KEY is not set', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await notifyLinearFailure({
      issueId: 'issue-abc',
      runId: 'run-123',
      durationMs: 5000,
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('LINEAR_API_KEY'));
    warnSpy.mockRestore();
  });

  it('uses apiKey option over env var', async () => {
    process.env['LINEAR_API_KEY'] = 'env-key';
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(COMMENT_RESPONSE) } as Response)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(STATES_RESPONSE) } as Response)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(UPDATE_RESPONSE) } as Response);

    await notifyLinearFailure({
      issueId: 'issue-abc',
      runId: 'run-123',
      durationMs: 5000,
      apiKey: 'override-key',
    });

    const firstCall = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = firstCall[1].headers as Record<string, string>;
    expect(headers['Authorization']).toBe('override-key');
  });

  it('posts comment, queries states, and transitions to Backlog on failure', async () => {
    process.env['LINEAR_API_KEY'] = 'lin_api_test';

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(COMMENT_RESPONSE) } as Response)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(STATES_RESPONSE) } as Response)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(UPDATE_RESPONSE) } as Response);

    await notifyLinearFailure({
      issueId: 'issue-xyz',
      runId: 'run-456',
      durationMs: 12000,
      iterations: 3,
      rejectionReason: 'QA rejected',
      rejectionDetails: ['Hardcoded strings (blocking)', 'Missing error handling (blocking)'],
    });

    expect(mockFetch).toHaveBeenCalledTimes(3);

    // First call: commentCreate
    const [, commentInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    const commentBody = JSON.parse(commentInit.body as string) as { variables: { issueId: string; body: string } };
    expect(commentBody.variables.issueId).toBe('issue-xyz');
    expect(commentBody.variables.body).toContain('❌ **Code Builder échoué**');
    expect(commentBody.variables.body).toContain('3 itérations QA');
    expect(commentBody.variables.body).toContain('Hardcoded strings (blocking)');
    expect(commentBody.variables.body).toContain('run-456');

    // Second call: workflowStates query
    const [, statesInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    const statesBody = JSON.parse(statesInit.body as string) as { variables: { issueId: string } };
    expect(statesBody.variables.issueId).toBe('issue-xyz');

    // Third call: issueUpdate to Backlog
    const [, updateInit] = mockFetch.mock.calls[2] as [string, RequestInit];
    const updateBody = JSON.parse(updateInit.body as string) as { variables: { id: string; stateId: string } };
    expect(updateBody.variables.id).toBe('issue-xyz');
    expect(updateBody.variables.stateId).toBe('state-backlog');
  });

  it('posts comment even when Backlog state is not found', async () => {
    process.env['LINEAR_API_KEY'] = 'lin_api_test';

    const noBacklogStates = {
      data: { issue: { team: { states: { nodes: [{ id: 'state-todo', name: 'Todo' }] } } } },
    };

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(COMMENT_RESPONSE) } as Response)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(noBacklogStates) } as Response);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await notifyLinearFailure({ issueId: 'issue-abc', runId: 'run-789', durationMs: 3000 });

    // Comment posted, states queried, but NO update call
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"Backlog" state not found'));
    warnSpy.mockRestore();
  });

  it('swallows fetch errors and logs them', async () => {
    process.env['LINEAR_API_KEY'] = 'lin_api_test';
    mockFetch.mockRejectedValueOnce(new Error('network timeout'));

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      notifyLinearFailure({ issueId: 'issue-abc', runId: 'run-fail', durationMs: 1000 }),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[linear-notifier]'),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it('includes rejection reason without details when only reason is set', async () => {
    process.env['LINEAR_API_KEY'] = 'lin_api_test';

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(COMMENT_RESPONSE) } as Response)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(STATES_RESPONSE) } as Response)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(UPDATE_RESPONSE) } as Response);

    await notifyLinearFailure({
      issueId: 'issue-abc',
      runId: 'run-123',
      durationMs: 2000,
      rejectionReason: 'Code quality insufficient',
    });

    const [, commentInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(commentInit.body as string) as { variables: { body: string } };
    expect(body.variables.body).toContain('Code quality insufficient');
  });

  it('builds comment without rejection info when no feedback available', async () => {
    process.env['LINEAR_API_KEY'] = 'lin_api_test';

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(COMMENT_RESPONSE) } as Response)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(STATES_RESPONSE) } as Response)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(UPDATE_RESPONSE) } as Response);

    await notifyLinearFailure({ issueId: 'issue-abc', runId: 'run-123', durationMs: 2000 });

    const [, commentInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(commentInit.body as string) as { variables: { body: string } };
    // Should not contain "Dernière raison de rejet" section
    expect(body.variables.body).not.toContain('Dernière raison de rejet');
    expect(body.variables.body).toContain('❌ **Code Builder échoué**');
    expect(body.variables.body).toContain('Action requise');
  });

  it('handles HTTP error response gracefully', async () => {
    process.env['LINEAR_API_KEY'] = 'lin_api_test';
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' } as Response);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      notifyLinearFailure({ issueId: 'issue-abc', runId: 'run-fail', durationMs: 1000 }),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
