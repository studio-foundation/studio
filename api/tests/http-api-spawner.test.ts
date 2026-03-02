import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpApiSpawner } from '../src/spawners/http-api-spawner.js';

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
});
