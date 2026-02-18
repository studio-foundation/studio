import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import type { EngineEvents } from '@studio/engine';
import { formatDuration } from './formatter.js';
import { humanReadableStageName, summarizeToolCalls, summarizeOutput } from './formatters.js';

export class ProgressDisplay {
  private spinner: Ora | null = null;
  private spinnerText = '';

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
        const label = humanReadableStageName(event.stage_name);
        this.spinnerText = `${index} ${label}`;
        this.spinner = ora({
          text: this.spinnerText,
          color: 'cyan',
        }).start();
      },

      onStageComplete: (event) => {
        if (this.jsonMode) return;

        const duration = formatDuration(event.duration_ms);
        const label = humanReadableStageName(event.stage_name);
        const attemptsStr = `${event.attempts} attempt${event.attempts !== 1 ? 's' : ''}`;

        if (event.status === 'success') {
          this.spinner?.succeed(
            chalk.white(label) +
            chalk.gray(` (${attemptsStr}, ${duration})`)
          );
        } else if (event.status === 'rejected') {
          this.spinner?.fail(
            chalk.red(`${label} — rejected`) +
            chalk.gray(` (${duration})`)
          );
          if (event.rejection_reason) {
            console.log(chalk.red(`  ✗ ${event.rejection_reason}`));
          }
          if (event.rejection_details?.length) {
            for (const detail of event.rejection_details) {
              console.log(chalk.yellow(`    - ${detail}`));
            }
          }
        } else {
          this.spinner?.fail(
            chalk.red(`${label} — failed`) +
            chalk.gray(` (${attemptsStr}, ${duration})`)
          );
        }
        this.spinner = null;

        // Default: grouped tool calls summary
        if (event.tool_calls && event.tool_calls.length > 0) {
          const summary = summarizeToolCalls(event.tool_calls);
          if (summary) console.log(chalk.gray(`  ${summary}`));
        }

        // Default: human-readable output summary (no raw JSON)
        if (event.status !== 'rejected' && event.output) {
          const summary = summarizeOutput(event.output);
          if (summary) console.log(chalk.gray(`  ${summary}`));
        }

        // Verbose extras: full JSON output
        if (this.verbose && event.output) {
          console.log(chalk.gray('  Output:'));
          const json = JSON.stringify(event.output, null, 2);
          const lines = json.split('\n');
          for (const line of lines.slice(0, 20)) {
            console.log(chalk.gray(`    ${line}`));
          }
          if (lines.length > 20) {
            console.log(chalk.gray(`    ... (${lines.length - 20} more lines)`));
          }
        }

        // Verbose extras: token breakdown
        if (this.verbose && event.token_usage) {
          const u = event.token_usage;
          console.log(chalk.gray(`  Tokens: ${u.prompt_tokens} prompt + ${u.completion_tokens} completion = ${u.total_tokens} total`));
        }
      },

      onTaskRetry: (event) => {
        if (this.jsonMode) return;
        // Stop spinner before printing, restart after
        this.spinner?.stop();
        this.spinner = null;

        console.log(chalk.yellow(`  ↻ Retry #${event.attempt}:`));
        for (const failure of event.failures) {
          console.log(chalk.yellow(`    - ${failure}`));
        }
        if (this.verbose && event.agent_output_raw) {
          console.log(chalk.gray(`    Raw response: ${event.agent_output_raw.slice(0, 300)}`));
        }
        if (this.verbose && event.tool_calls_count !== undefined) {
          console.log(chalk.gray(`    Tool calls made: ${event.tool_calls_count}`));
        }

        // Restart spinner for ongoing stage
        this.spinner = ora({
          text: this.spinnerText,
          color: 'cyan',
        }).start();
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
        console.log(chalk.yellow(`    Rejected: ${event.rejection_reason}`));
        if (this.verbose && event.rejection_details.length > 0) {
          for (const detail of event.rejection_details) {
            console.log(chalk.yellow(`      - ${detail}`));
          }
        }
        console.log(chalk.yellow(`    Re-running with feedback...`));
      },

      onGroupComplete: (event) => {
        if (this.jsonMode) return;
        if (event.iterations > 1) {
          if (event.status === 'success') {
            console.log(chalk.green(`  ✓ Approved after ${event.iterations} iterations`));
          } else {
            console.log(chalk.red(`  ✗ Rejected after ${event.iterations} iterations (max reached)`));
          }
        }
      },

      onPipelineComplete: (event) => {
        if (this.jsonMode) return;

        console.log('');
        if (event.status === 'success') {
          console.log(chalk.green(`✓ Pipeline completed in ${formatDuration(event.duration_ms)}`));
        } else if (event.status === 'rejected') {
          console.log(chalk.red(`✗ Pipeline rejected`));
        } else {
          console.log(chalk.red(`✗ Pipeline failed after ${formatDuration(event.duration_ms)}`));
        }

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
