import chalk from 'chalk';
import type { PipelineRun } from '@studio-foundation/contracts';

/**
 * Child pipeline runs keyed by the spawning stage's `child_run_id`. When
 * provided, a `call` stage renders its child pipeline's stages nested beneath
 * it — the "pipelines of pipelines" view for a call-chained run.
 */
export type ChildRunMap = Map<string, PipelineRun>;

export function formatResult(run: PipelineRun, childRuns?: ChildRunMap): void {
  console.log('');
  console.log(`Pipeline: ${chalk.bold(run.pipeline_name)}`);

  if (run.status === 'success') {
    console.log(`Status:   ${chalk.green('✓ success')}`);
  } else if (run.status === 'rejected') {
    // `rejected` is whatever the contract's post_validation.rejection_detection
    // declared it to be — the CLI names no reviewer (INV-13).
    console.log(`Status:   ${chalk.red('✗ rejected')}`);
  } else if (run.status === 'cancelled') {
    console.log(`Status:   ${chalk.yellow('⚠ cancelled')}`);
  } else if (run.status === 'interrupted') {
    console.log(`Status:   ${chalk.yellow('⚠ interrupted (process died mid-run)')}`);
  } else if (run.status === 'running') {
    console.log(`Status:   ${chalk.cyan('● running')}`);
  } else {
    console.log(`Status:   ${chalk.red('✗ failed')}`);
  }

  if (run.started_at && run.completed_at) {
    const duration = formatDuration(
      new Date(run.completed_at).getTime() - new Date(run.started_at).getTime()
    );
    console.log(`Duration: ${duration}`);
  }

  if (run.stages.length > 0) {
    console.log('');
    console.log('Stages:');
    printStages(run.stages, childRuns, '  ');
  }

  console.log('');
}

/**
 * Render a list of stages, each on its own line under `indent`. When a stage
 * spawned a child pipeline (its `child_run_id` resolves in `childRuns`), the
 * child's own stages are printed recursively, indented one level deeper.
 */
function printStages(
  stages: PipelineRun['stages'],
  childRuns: ChildRunMap | undefined,
  indent: string
): void {
  const total = stages.length;

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const index = `[${i + 1}/${total}]`;
    const name = stage.stage_name;
    // A call/map stage produces no agent runs, so an attempt count is meaningless for it.
    const agentRuns = stage.tasks[0]?.agent_runs.length;
    const attempts = agentRuns ?? 0;

    const dots = '.'.repeat(Math.max(2, 30 - name.length));

    // Per-stage wall-clock, surfaced next to the status marker. For a call
    // stage this is the child pipeline's duration — the timing that otherwise
    // meant hand-parsing the run JSONL.
    const durationMs = stageDurationMs(stage);
    const durationText = durationMs !== null ? `  ${chalk.gray(formatCompactDuration(durationMs))}` : '';

    if (stage.status === 'success') {
      const attemptText = agentRuns !== undefined ? ` (${agentRuns} attempt${agentRuns !== 1 ? 's' : ''})` : '';
      console.log(
        `${indent}${index} ${name} ${chalk.gray(dots)} ${chalk.green('✓')}${attemptText}${durationText}`
      );
    } else if (stage.status === 'rejected') {
      console.log(
        `${indent}${index} ${name} ${chalk.gray(dots)} ${chalk.red('✗ REJECTED')}${durationText}`
      );
    } else if (stage.status === 'failed') {
      console.log(
        `${indent}${index} ${name} ${chalk.gray(dots)} ${chalk.red('✗ FAILED')} (${attempts} attempts exhausted)${durationText}`
      );
      // Show errors from the last agent run
      const lastAgentRun = stage.tasks[0]?.agent_runs.at(-1);
      if (lastAgentRun?.error) {
        console.log(`${indent}${chalk.gray('      Errors:')}`);
        console.log(`${indent}${chalk.gray('      -')} ${lastAgentRun.error}`);
      }
    } else if (stage.status === 'skipped') {
      const reasonText = stage.skipped_reason ? ` (skipped: ${stage.skipped_reason})` : '';
      console.log(
        `${indent}${index} ${name} ${chalk.gray(dots)} ${chalk.dim('⊘ skipped')}${chalk.gray(reasonText)}`
      );
    } else {
      console.log(
        `${indent}${index} ${name} ${chalk.gray(dots)} ${chalk.yellow(stage.status)}`
      );
    }

    // Nest the spawned child pipeline's stages beneath a call stage.
    const child = stage.child_run_id ? childRuns?.get(stage.child_run_id) : undefined;
    if (child && child.stages.length > 0) {
      console.log(`${indent}  ${chalk.gray('└─')} ${chalk.dim(child.pipeline_name)}`);
      printStages(child.stages, childRuns, `${indent}     `);
    }
  }
}

export function formatJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function formatError(error: Error): void {
  console.error(chalk.red(`Error: ${error.message}`));
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m${remainingSeconds.toString().padStart(2, '0')}s`;
}

/**
 * Compact, per-stage duration. Keeps one decimal for sub-minute values so a
 * fast child (1.3s) reads differently from a slow one (16.3s) — the whole point
 * of surfacing per-child timing on the line.
 */
export function formatCompactDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const remainingSeconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m${remainingSeconds.toString().padStart(2, '0')}s`;
}

/**
 * Wall-clock of a single stage from its recorded timestamps, or null when it
 * can't be derived (missing timestamps) or is zero (e.g. a skipped stage) —
 * callers omit the duration entirely in those cases.
 */
function stageDurationMs(stage: PipelineRun['stages'][number]): number | null {
  if (!stage.started_at || !stage.completed_at) return null;
  const ms = new Date(stage.completed_at).getTime() - new Date(stage.started_at).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return ms;
}
