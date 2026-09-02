import type { RunSpawner, SpawnConfig, SpawnResult, PipelineRun } from '@studio-foundation/contracts';
import { ChildRunError, childRunErrorMessage, childStageUsage, sumTokenUsage } from '@studio-foundation/contracts';

export class HttpApiSpawner implements RunSpawner {
  constructor(private apiUrl: string, private apiKey?: string) {}

  private authHeaders(): Record<string, string> {
    return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
  }

  async spawnAndWait(config: SpawnConfig): Promise<SpawnResult> {
    // 1. Launch the run
    const postRes = await fetch(`${this.apiUrl}/api/runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Studio-Depth': String(config.depth),
        'X-Studio-Parent-Run-Id': config.parentRunId,
        ...this.authHeaders(),
      },
      body: JSON.stringify({ pipeline: config.pipeline, input: config.input }),
    });

    if (!postRes.ok) {
      const text = await postRes.text();
      throw new Error(`Failed to launch child run: ${postRes.status} ${text}`);
    }

    const { run_id } = (await postRes.json()) as { run_id: string };

    // 2. Wait for pipeline_complete via SSE
    await this.waitForCompletion(run_id);

    // 3. Fetch full run result to get output
    const getRes = await fetch(`${this.apiUrl}/api/runs/${run_id}`, {
      headers: { ...this.authHeaders() },
    });
    if (!getRes.ok) {
      throw new Error(`Failed to fetch child run result ${run_id}: ${getRes.status}`);
    }
    const run = (await getRes.json()) as PipelineRun;

    // Built before the failure branch: a child that died still made billed calls.
    const stages = childStageUsage(run.stages);
    const token_usage = sumTokenUsage(run.stages.map(s => s.token_usage));

    if (run.status === 'failed' || run.status === 'rejected' || run.status === 'cancelled') {
      const stageError = childRunErrorMessage(run.stages);
      throw new ChildRunError(
        `Child run ${run_id} ${run.status}: ${stageError ?? 'no error recorded'}`,
        run_id,
        run.status,
        stages,
        token_usage,
      );
    }

    const lastStage = [...run.stages].reverse().find(s => s.status === 'success');
    const output = (lastStage as { output?: unknown } | undefined)?.output ?? null;

    return { run_id, status: run.status, output, stages, ...(token_usage ? { token_usage } : {}) };
  }

  private waitForCompletion(runId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      fetch(`${this.apiUrl}/api/runs/${runId}/stream`, {
        headers: { Accept: 'text/event-stream', ...this.authHeaders() },
      })
        .then(response => {
          if (!response.ok || !response.body) {
            reject(new Error(`SSE connection failed for run ${runId}: ${response.status}`));
            return;
          }
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let currentEventType = '';

          const pump = (): Promise<void> =>
            reader.read().then(({ done, value }) => {
              if (done) {
                reject(new Error(`SSE stream ended without pipeline_complete for run ${runId}`));
                return;
              }
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() ?? '';

              for (const line of lines) {
                if (line.startsWith('event: ')) {
                  currentEventType = line.slice(7).trim();
                } else if (line.startsWith('data: ') && currentEventType === 'pipeline_complete') {
                  void reader.cancel();
                  resolve();
                  return;
                } else if (line === '') {
                  currentEventType = '';
                }
              }
              return pump();
            });

          pump().catch(reject);
        })
        .catch(reject);
    });
  }
}
