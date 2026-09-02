import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpApiSpawner } from '../src/spawners/http-api-spawner.js';
import { ChildRunError } from '@studio-foundation/contracts';

// Helper: create a fake SSE stream that emits events then closes
function makeFakeSseResponse(events: Array<{ type: string; data: unknown }>) {
  const lines: string[] = [];
  for (const e of events) {
    lines.push(`event: ${e.type}`);
    lines.push(`data: ${JSON.stringify(e.data)}`);
    lines.push('');
  }
  const body = lines.join('\n');
  const encoder = new TextEncoder();
  const encoded = encoder.encode(body);

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('HttpApiSpawner', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('POSTs to /api/runs with correct headers and body', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ run_id: 'child-1', status: 'running', stream_url: '/api/runs/child-1/stream' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        makeFakeSseResponse([{ type: 'pipeline_complete', data: { status: 'success', run_id: 'child-1' } }])
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'child-1',
            pipeline_name: 'test',
            status: 'success',
            started_at: new Date().toISOString(),
            stages: [{ id: 's1', stage_name: 'final', status: 'success', started_at: '', tasks: [], output: { ok: true } }],
          }),
          { headers: { 'content-type': 'application/json' } }
        )
      );

    const spawner = new HttpApiSpawner('http://localhost:3000');
    await spawner.spawnAndWait({ pipeline: 'test', input: { x: 1 }, parentRunId: 'p1', depth: 1 });

    const postCall = fetchMock.mock.calls[0];
    expect(postCall[0]).toBe('http://localhost:3000/api/runs');
    expect(postCall[1].method).toBe('POST');
    expect(postCall[1].headers['X-Studio-Depth']).toBe('1');
    expect(postCall[1].headers['X-Studio-Parent-Run-Id']).toBe('p1');
  });

  it('returns run_id, status, and output from last stage on success', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ run_id: 'child-2', status: 'running', stream_url: '' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        makeFakeSseResponse([{ type: 'pipeline_complete', data: { status: 'success', run_id: 'child-2' } }])
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'child-2',
            pipeline_name: 'p',
            status: 'success',
            started_at: '',
            stages: [{ id: 's1', stage_name: 'final', status: 'success', started_at: '', tasks: [], output: { recipe: 'pasta' } }],
          }),
          { headers: { 'content-type': 'application/json' } }
        )
      );

    const spawner = new HttpApiSpawner('http://localhost:3000');
    const result = await spawner.spawnAndWait({ pipeline: 'p', input: {}, parentRunId: 'x', depth: 1 });

    expect(result.run_id).toBe('child-2');
    expect(result.status).toBe('success');
    expect(result.output).toEqual({ recipe: 'pasta' });
  });

  it('sends Authorization header on all requests when apiKey is configured', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ run_id: 'child-auth', status: 'running', stream_url: '' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        makeFakeSseResponse([{ type: 'pipeline_complete', data: { status: 'success', run_id: 'child-auth' } }])
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'child-auth',
            pipeline_name: 'p',
            status: 'success',
            started_at: '',
            stages: [{ id: 's1', stage_name: 'final', status: 'success', started_at: '', tasks: [], output: {} }],
          }),
          { headers: { 'content-type': 'application/json' } }
        )
      );

    const spawner = new HttpApiSpawner('http://localhost:3000', 'my-secret-key');
    await spawner.spawnAndWait({ pipeline: 'p', input: {}, parentRunId: 'x', depth: 1 });

    // All 3 fetch calls (POST /runs, GET /runs/stream, GET /runs/:id) must include the auth header
    for (const call of fetchMock.mock.calls) {
      expect(call[1]?.headers?.['Authorization']).toBe('Bearer my-secret-key');
    }
  });

  it('throws when pipeline_complete has failed status', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ run_id: 'child-3', status: 'running', stream_url: '' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        makeFakeSseResponse([{ type: 'pipeline_complete', data: { status: 'failed', run_id: 'child-3' } }])
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 'child-3', pipeline_name: 'p', status: 'failed', started_at: '', stages: [] }),
          { headers: { 'content-type': 'application/json' } }
        )
      );

    const spawner = new HttpApiSpawner('http://localhost:3000');
    await expect(
      spawner.spawnAndWait({ pipeline: 'bad', input: {}, parentRunId: 'x', depth: 1 })
    ).rejects.toThrow('Child run child-3 failed');
  });

  describe('cost reporting across the spawner boundary (STU-1209)', () => {
    const usage = (total: number) => ({
      prompt_tokens: total - 10,
      completion_tokens: 10,
      total_tokens: total,
    });

    const stage = (name: string, status: string, attempts: number, total?: number) => ({
      id: name,
      stage_name: name,
      status,
      started_at: '',
      tasks: [{ agent_runs: Array.from({ length: attempts }, (_, i) => ({ attempt: i + 1 })) }],
      ...(total ? { token_usage: usage(total) } : {}),
      output: { ok: true },
    });

    const respondWith = (run: Record<string, unknown>, status = 'success') => {
      fetchMock
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ run_id: run.id, status: 'running', stream_url: '' }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          makeFakeSseResponse([{ type: 'pipeline_complete', data: { status, run_id: run.id } }])
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(run), { headers: { 'content-type': 'application/json' } })
        );
    };

    it('sums the child run usage into a flat total', async () => {
      respondWith({
        id: 'child-4',
        pipeline_name: 'p',
        status: 'success',
        started_at: '',
        stages: [stage('a', 'success', 1, 100), stage('b', 'success', 2, 250)],
      });

      const result = await new HttpApiSpawner('http://localhost:3000').spawnAndWait({
        pipeline: 'p', input: {}, parentRunId: 'x', depth: 1,
      });

      expect(result.token_usage?.total_tokens).toBe(350);
    });

    it('reports the per-stage breakdown, with attempts from the agent runs', async () => {
      respondWith({
        id: 'child-5',
        pipeline_name: 'p',
        status: 'success',
        started_at: '',
        stages: [stage('a', 'success', 1, 100), stage('b', 'success', 3, 250)],
      });

      const result = await new HttpApiSpawner('http://localhost:3000').spawnAndWait({
        pipeline: 'p', input: {}, parentRunId: 'x', depth: 1,
      });

      expect(result.stages).toEqual([
        { stage: 'a', status: 'success', attempts: 1, token_usage: usage(100) },
        { stage: 'b', status: 'success', attempts: 3, token_usage: usage(250) },
      ]);
    });

    it('reports nothing when the child reported no usage, rather than a zero', async () => {
      respondWith({
        id: 'child-6',
        pipeline_name: 'p',
        status: 'success',
        started_at: '',
        stages: [stage('a', 'success', 1)],
      });

      const result = await new HttpApiSpawner('http://localhost:3000').spawnAndWait({
        pipeline: 'p', input: {}, parentRunId: 'x', depth: 1,
      });

      expect(result.token_usage).toBeUndefined();
      expect(result.stages).toEqual([{ stage: 'a', status: 'success', attempts: 1 }]);
    });

    it('carries the record and the real error on a failed child, not a bare status', async () => {
      const failed = {
        id: 'child-7',
        pipeline_name: 'p',
        status: 'failed',
        started_at: '',
        stages: [
          stage('a', 'success', 1, 100),
          {
            id: 'b', stage_name: 'b', status: 'failed', started_at: '',
            tasks: [{ agent_runs: [{ attempt: 1 }, { attempt: 2, error: 'HTTP 400 from create_draft' }] }],
            token_usage: usage(60),
          },
        ],
      };
      respondWith(failed, 'failed');

      const err = await new HttpApiSpawner('http://localhost:3000')
        .spawnAndWait({ pipeline: 'p', input: {}, parentRunId: 'x', depth: 1 })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ChildRunError);
      const childErr = err as ChildRunError;
      // The calls a dead child made were still billed.
      expect(childErr.token_usage?.total_tokens).toBe(160);
      expect(childErr.stages).toHaveLength(2);
      expect(childErr.run_id).toBe('child-7');
      expect(childErr.run_status).toBe('failed');
      expect(childErr.message).toContain('HTTP 400 from create_draft');
    });

    it('says so when a failed child recorded no error at all', async () => {
      respondWith(
        { id: 'child-8', pipeline_name: 'p', status: 'failed', started_at: '', stages: [] },
        'failed'
      );

      await expect(
        new HttpApiSpawner('http://localhost:3000')
          .spawnAndWait({ pipeline: 'p', input: {}, parentRunId: 'x', depth: 1 })
      ).rejects.toThrow('no error recorded');
    });
  });
});
