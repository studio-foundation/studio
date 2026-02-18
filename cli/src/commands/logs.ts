import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import chalk from 'chalk';

const RUNS_DIR = '.studio/runs';

interface LogsOptions {
  raw?: boolean;
  json?: boolean;
}

function runIdShort(runId: string): string {
  return runId.replace(/-/g, '').slice(0, 8);
}

function formatEventLine(record: Record<string, unknown>): string {
  const event = record.event as string;
  const ts = record.ts as string;
  const time = ts ? new Date(ts).toISOString().slice(11, 19) : '';

  switch (event) {
    case 'pipeline_start':
      return chalk.blue(`${time} Pipeline started: ${record.project}/${record.pipeline} (run ${record.run_id})`);
    case 'pipeline_complete':
      return chalk.blue(
        `${time} Pipeline complete: ${record.status} (${record.duration_ms}ms, ${record.total_tokens ?? 0} tokens)`
      );
    case 'stage_start':
      return chalk.gray(
        `  ${time} [${(record.stage_index as number) + 1}/${record.total_stages}] ${record.stage} ...`
      );
    case 'stage_complete': {
      const status = record.status as string;
      const icon = status === 'success' ? chalk.green('✓') : chalk.red('✗');
      const attempts = record.attempts !== undefined ? ` (${record.attempts} attempt(s))` : '';
      const duration = record.duration_ms !== undefined ? ` ${record.duration_ms}ms` : '';
      return chalk.gray(`  ${time} ${icon} ${record.stage} ${status}${attempts}${duration}`);
    }
    case 'stage_retry':
      return chalk.yellow(
        `  ${time} ↻ Retry #${record.attempt}: ${record.failure_reason ?? 'unknown'}`
      );
    case 'group_start':
      return chalk.gray(`  ${time} Group ${record.group} (max ${record.max_iterations} iterations)`);
    case 'group_iteration':
      return chalk.yellow(`  ${time} ↻ Iteration ${record.iteration}/${record.max_iterations}`);
    case 'group_feedback':
      return chalk.yellow(`  ${time} Rejected: ${record.rejection_reason}`);
    case 'group_complete':
      return chalk.gray(`  ${time} Group complete: ${record.status} (${record.iterations} iterations)`);
    default:
      return chalk.gray(`${time} ${event} ${JSON.stringify(record)}`);
  }
}

export async function logsCommand(runId: string, options: LogsOptions): Promise<void> {
  try {
    const runsPath = resolve(process.cwd(), RUNS_DIR);
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(runsPath, { withFileTypes: true });
    } catch {
      console.error(chalk.yellow(`No runs directory found at ${runsPath}`));
      process.exit(1);
    }

    const shortId = runIdShort(runId);
    const jsonlFiles = entries
      .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
      .map((e) => e.name);

    const matching = jsonlFiles.filter((name) => name.endsWith(`-${shortId}.jsonl`));
    if (matching.length === 0) {
      console.error(chalk.yellow(`No run log found for run id: ${runId}`));
      process.exit(1);
    }

    const mostRecent = matching.sort().reverse()[0];
    const filePath = resolve(runsPath, mostRecent);
    const content = await readFile(filePath, 'utf-8');
    const lines = content
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((r): r is Record<string, unknown> => r !== null);

    const forRun = lines.filter(
      (r) => (r.run_id as string) === shortId || (r.run_id as string)?.startsWith(shortId)
    );
    const records = forRun.length > 0 ? forRun : lines;

    if (options.raw) {
      for (const r of records) {
        console.log(JSON.stringify(r));
      }
      return;
    }

    if (options.json) {
      console.log(JSON.stringify(records, null, 2));
      return;
    }

    console.log(chalk.bold(`\nRun ${shortId} — ${mostRecent}\n`));
    for (const record of records) {
      console.log(formatEventLine(record));
    }
    console.log('');
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
