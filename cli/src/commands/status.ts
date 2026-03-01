import chalk from 'chalk';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PipelineRun, StageRun, TaskRun } from '@studio/contracts';
import { loadConfig } from '../config.js';
import { createRunStore } from '../run-store-factory.js';
import { formatResult } from '../output/formatter.js';

interface StatusOptions {
  json?: boolean;
}

const RUNS_DIR = '.studio/runs';

function runIdShort(runId: string): string {
  return runId.replace(/-/g, '').slice(0, 8);
}

async function getRunFromJsonl(runId: string | undefined): Promise<PipelineRun | null> {
  const runsPath = resolve(process.cwd(), RUNS_DIR);
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(runsPath, { withFileTypes: true });
  } catch {
    return null;
  }

  const jsonlFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => e.name);

  const shortId = runId ? runIdShort(runId) : null;
  const candidates = (shortId
    ? jsonlFiles.filter((n) => n.endsWith(`-${shortId}.jsonl`))
    : jsonlFiles
  ).sort()
    .reverse();

  for (const filename of candidates) {
    const filePath = resolve(runsPath, filename);
    const content = await readFile(filePath, 'utf-8');
    const lines = content
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((r): r is Record<string, unknown> => r !== null);

    const forRun = shortId
      ? lines.filter((r) => (r.run_id as string) === shortId || (r.run_id as string)?.startsWith(shortId))
      : lines;
    const records = forRun.length > 0 ? forRun : lines;

    let pipeline_name = '';
    let started_at = '';
    let completed_at: string | undefined;
    let status = 'running';
    const stageCompletes: Array<{ stage_name: string; status: string; attempts: number }> = [];

    for (const r of records) {
      const event = r.event as string;
      const ts = r.ts as string;
      if (event === 'pipeline_start') {
        pipeline_name = `${r.project}/${r.pipeline}`;
        started_at = ts ?? '';
      } else if (event === 'pipeline_complete') {
        status = (r.status as string) ?? 'running';
        completed_at = ts;
      } else if (event === 'stage_complete') {
        stageCompletes.push({
          stage_name: (r.stage as string) ?? '',
          status: (r.status as string) ?? 'unknown',
          attempts: (r.attempts as number) ?? 1,
        });
      }
    }

    if (!pipeline_name) continue;

    const runIdFromFile = shortId ?? (records[0]?.run_id as string) ?? '';

    const taskStatus = (s: string): TaskRun['status'] =>
      s === 'rejected' ? 'failed' : (s as TaskRun['status']);

    const stages: StageRun[] = stageCompletes.map((s, i) => ({
      id: `stage-${i}`,
      stage_name: s.stage_name,
      status: s.status as StageRun['status'],
      started_at: started_at,
      completed_at: completed_at,
      tasks: [
        {
          id: `task-${i}`,
          task_name: s.stage_name,
          status: taskStatus(s.status),
          started_at: started_at,
          completed_at: completed_at,
          agent_runs: Array.from({ length: s.attempts }, (_, j) => ({
            id: `ar-${i}-${j}`,
            agent_name: '',
            attempt: j + 1,
            status: 'success' as const,
            tool_calls: 0,
            started_at: started_at,
            completed_at: completed_at,
          })),
        },
      ],
    }));

    return {
      id: runIdFromFile,
      pipeline_name: pipeline_name || 'unknown',
      status: status as PipelineRun['status'],
      started_at,
      completed_at,
      stages,
    };
  }
  return null;
}

export async function statusCommand(
  runId: string | undefined,
  options: StatusOptions
): Promise<void> {
  try {
    let run: PipelineRun | null = null;
    try {
      const config = await loadConfig();
      const store = await createRunStore(config);
      run = runId ? await store.getPipelineRun(runId) : await store.getLatestRun();
      await store.close?.();
    } catch {
      // DB not available or not initialized
    }

    if (!run && (runId || true)) {
      run = await getRunFromJsonl(runId);
    }

    if (!run) {
      console.log(chalk.yellow(runId ? `Run not found: ${runId}` : 'No runs found'));
      process.exit(1);
    }

    if (options.json) {
      console.log(JSON.stringify(run, null, 2));
    } else {
      formatResult(run);
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
