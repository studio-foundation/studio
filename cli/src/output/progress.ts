import chalk from 'chalk';
import type { EngineEvents } from '@studio/engine';
import { formatDuration } from './formatter.js';

export class ProgressDisplay {
  constructor(
    private jsonMode: boolean,
    private verbose: boolean
  ) {}

  getEvents(): EngineEvents {
    return {
      onPipelineStart: (event) => {
        if (this.jsonMode) return;
        console.log(chalk.blue(`\nRunning pipeline: ${event.pipeline_name}`));
        console.log(chalk.gray(`Run ID: ${event.run_id}\n`));
      },

      onStageStart: (event) => {
        if (this.jsonMode) return;
        const index = `[${event.stage_index + 1}/${event.total_stages}]`;
        const name = event.stage_name;
        const dots = '.'.repeat(Math.max(2, 30 - name.length));
        process.stdout.write(chalk.gray(`  ${index} ${name} ${dots} `));
      },

      onStageComplete: (event) => {
        if (this.jsonMode) return;

        // Status line: check/x + attempts + duration
        const duration = formatDuration(event.duration_ms);
        if (event.status === 'success') {
          console.log(
            chalk.green('✓') +
            chalk.gray(` (${event.attempts} attempt${event.attempts !== 1 ? 's' : ''}, ${duration})`)
          );
        } else if (event.status === 'rejected') {
          console.log(
            chalk.red('✗ REJECTED') +
            chalk.gray(` (${duration})`)
          );
          if (event.rejection_reason) {
            console.log(chalk.red(`        ✗ ${event.rejection_reason}`));
          }
          if (event.rejection_details?.length) {
            for (const detail of event.rejection_details) {
              console.log(chalk.yellow(`          - ${detail}`));
            }
          }
        } else {
          console.log(
            chalk.red('✗ FAILED') +
            chalk.gray(` (${event.attempts} attempts, ${duration})`)
          );
        }

        // Output summary (skip for rejected — already shown above)
        if (event.status !== 'rejected' && event.output_summary) {
          console.log(chalk.gray(`        → ${event.output_summary}`));
        }

        // Tool calls summary
        if (event.tool_calls && event.tool_calls.length > 0) {
          const tcSummary = event.tool_calls
            .map(tc => {
              const shortName = tc.name.split('.').pop();
              return tc.arguments_summary
                ? `${shortName}(${tc.arguments_summary})`
                : shortName;
            })
            .join(', ');
          console.log(chalk.gray(`        → ${event.tool_calls.length} tool calls: ${tcSummary}`));
        }

        // Verbose: full JSON output
        if (this.verbose && event.output) {
          console.log(chalk.gray('        Output:'));
          const json = JSON.stringify(event.output, null, 2);
          const lines = json.split('\n');
          for (const line of lines.slice(0, 20)) {
            console.log(chalk.gray(`          ${line}`));
          }
          if (lines.length > 20) {
            console.log(chalk.gray(`          ... (${lines.length - 20} more lines)`));
          }
        }

        // Verbose: token breakdown
        if (this.verbose && event.token_usage) {
          const u = event.token_usage;
          console.log(chalk.gray(`        Tokens: ${u.prompt_tokens} prompt + ${u.completion_tokens} completion = ${u.total_tokens} total`));
        }
      },

      onTaskRetry: (event) => {
        if (this.jsonMode) return;

        // Always show retries (not just verbose)
        console.log(chalk.yellow(`        ↻ Retry #${event.attempt}:`));
        for (const failure of event.failures) {
          console.log(chalk.yellow(`          - ${failure}`));
        }

        // Verbose: raw agent response
        if (this.verbose && event.agent_output_raw) {
          console.log(chalk.gray(`          Agent response (truncated):`));
          console.log(chalk.gray(`            ${event.agent_output_raw.slice(0, 300)}`));
        }

        // Verbose: tool calls count
        if (this.verbose && event.tool_calls_count !== undefined) {
          console.log(chalk.gray(`          Tool calls made: ${event.tool_calls_count}`));
        }
      },

      onGroupStart: () => {
        // Silent — group is transparent at the pipeline level
      },

      onGroupIteration: (event) => {
        if (this.jsonMode) return;
        if (event.iteration > 1) {
          console.log(chalk.yellow(`\n  ↻ Feedback loop iteration ${event.iteration}/${event.max_iterations}`));
        }
      },

      onGroupFeedback: (event) => {
        if (this.jsonMode) return;
        console.log(chalk.yellow(`    QA rejected: ${event.rejection_reason}`));
        if (this.verbose && event.rejection_details.length > 0) {
          for (const detail of event.rejection_details) {
            console.log(chalk.yellow(`      - ${detail}`));
          }
        }
        console.log(chalk.yellow(`    Re-running code generation with feedback...`));
      },

      onGroupComplete: (event) => {
        if (this.jsonMode) return;
        if (event.iterations > 1) {
          if (event.status === 'success') {
            console.log(chalk.green(`    ✓ Approved after ${event.iterations} iterations`));
          } else {
            console.log(chalk.red(`    ✗ Rejected after ${event.iterations} iterations (max reached)`));
          }
        }
      },

      onPipelineComplete: (event) => {
        if (this.jsonMode) return;

        console.log('');
        if (event.status === 'success') {
          console.log(chalk.green(`✓ Pipeline completed in ${formatDuration(event.duration_ms)}`));
        } else if (event.status === 'rejected') {
          console.log(chalk.red(`✗ Pipeline rejected by QA`));
        } else {
          console.log(chalk.red(`✗ Pipeline failed after ${formatDuration(event.duration_ms)}`));
        }

        // Token and tool call totals
        const parts: string[] = [];
        if (event.total_tokens > 0) {
          parts.push(`${event.total_tokens.toLocaleString()} tokens`);
        }
        if (event.total_tool_calls > 0) {
          parts.push(`${event.total_tool_calls} tool calls`);
        }
        if (parts.length > 0) {
          console.log(chalk.gray(`  ${parts.join(' | ')}`));
        }
      },
    };
  }
}
