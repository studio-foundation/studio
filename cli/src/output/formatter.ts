import chalk from 'chalk';
import type { PipelineRun } from '@studio-foundation/contracts';

export function formatResult(run: PipelineRun): void {
  console.log('');
  console.log(`Pipeline: ${chalk.bold(run.pipeline_name)}`);

  if (run.status === 'success') {
    console.log(`Status:   ${chalk.green('✓ success')}`);
  } else if (run.status === 'rejected') {
    console.log(`Status:   ${chalk.red('✗ rejected by QA')}`);
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
    const total = run.stages.length;

    for (let i = 0; i < run.stages.length; i++) {
      const stage = run.stages[i];
      const index = `[${i + 1}/${total}]`;
      const name = stage.stage_name;
      // A call/map stage produces no agent runs, so an attempt count is meaningless for it.
      const agentRuns = stage.tasks[0]?.agent_runs.length;
      const attempts = agentRuns ?? 0;

      const dots = '.'.repeat(Math.max(2, 30 - name.length));

      if (stage.status === 'success') {
        const attemptText = agentRuns !== undefined ? ` (${agentRuns} attempt${agentRuns !== 1 ? 's' : ''})` : '';
        console.log(
          `  ${index} ${name} ${chalk.gray(dots)} ${chalk.green('✓')}${attemptText}`
        );
      } else if (stage.status === 'rejected') {
        console.log(
          `  ${index} ${name} ${chalk.gray(dots)} ${chalk.red('✗ REJECTED')}`
        );
      } else if (stage.status === 'failed') {
        console.log(
          `  ${index} ${name} ${chalk.gray(dots)} ${chalk.red('✗ FAILED')} (${attempts} attempts exhausted)`
        );
        // Show errors from the last agent run
        const lastAgentRun = stage.tasks[0]?.agent_runs.at(-1);
        if (lastAgentRun?.error) {
          console.log(`${chalk.gray('        Errors:')}`);
          console.log(`${chalk.gray('        -')} ${lastAgentRun.error}`);
        }
      } else if (stage.status === 'skipped') {
        const reasonText = stage.skipped_reason ? ` (skipped: ${stage.skipped_reason})` : '';
        console.log(
          `  ${index} ${name} ${chalk.gray(dots)} ${chalk.dim('⊘ skipped')}${chalk.gray(reasonText)}`
        );
      } else {
        console.log(
          `  ${index} ${name} ${chalk.gray(dots)} ${chalk.yellow(stage.status)}`
        );
      }
    }
  }

  console.log('');
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
