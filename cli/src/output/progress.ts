import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import type { EngineEvents } from '@studio/engine';
import { formatDuration } from './formatter.js';
import { humanReadableStageName, summarizeToolCalls, summarizeOutput, getToolIcon, summarizeToolParams, summarizeToolResult } from './formatters.js';

export class ProgressDisplay {
  private spinner: Ora | null = null;
  private spinnerText = '';
  private toolSpinner: Ora | null = null;
  private thinkingSpinner: Ora | null = null;
  private currentToolText = '';
  private displayMode: 'quiet' | 'verbose' | 'live';

  private get verbose(): boolean { return this.displayMode === 'verbose'; }
  private get live(): boolean { return this.displayMode === 'live'; }

  constructor(
    private jsonMode: boolean,
    displayMode: 'quiet' | 'verbose' | 'live'
  ) {
    this.displayMode = displayMode;
  }

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
        if (this.live) {
          console.log(chalk.cyan(`${this.spinnerText}...`));
          this.thinkingSpinner = ora({ text: chalk.dim('Thinking...'), indent: 2, color: 'gray' }).start();
        } else {
          this.spinner = ora({ text: this.spinnerText, color: 'cyan' }).start();
        }
      },

      onStageComplete: (event) => {
        if (this.jsonMode) return;

        const duration = formatDuration(event.duration_ms);
        const label = humanReadableStageName(event.stage_name);
        const attemptsStr = `${event.attempts} attempt${event.attempts !== 1 ? 's' : ''}`;

        if (this.live) {
          this.thinkingSpinner?.stop();
          this.thinkingSpinner = null;
          if (event.status === 'success') {
            console.log(chalk.green(`  ✓`) + chalk.gray(` (${attemptsStr}, ${duration})`));
          } else if (event.status === 'rejected') {
            console.log(chalk.red(`  ✗ rejected`) + chalk.gray(` (${duration})`));
            if (event.rejection_reason) console.log(chalk.red(`    ${event.rejection_reason}`));
            if (event.rejection_details?.length) {
              for (const detail of event.rejection_details) {
                console.log(chalk.yellow(`      - ${detail}`));
              }
            }
          } else {
            console.log(chalk.red(`  ✗ failed`) + chalk.gray(` (${attemptsStr}, ${duration})`));
          }
        } else if (event.status === 'success') {
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

        // Tool call summary: quiet + verbose only (in live mode, each was shown individually)
        if (!this.live && event.tool_calls && event.tool_calls.length > 0) {
          const summary = summarizeToolCalls(event.tool_calls);
          if (summary) console.log(chalk.gray(`  ${summary}`));
        }

        // Output summary: all modes
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
        // Stop any active spinners before printing retry info
        this.toolSpinner?.stop();
        this.toolSpinner = null;
        this.thinkingSpinner?.stop();
        this.thinkingSpinner = null;
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

        // Restart stage spinner for ongoing stage (not in live mode — tool spinners take over)
        if (!this.live) {
          this.spinner = ora({
            text: this.spinnerText,
            color: 'cyan',
          }).start();
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

      onAgentThinking: (event) => {
        if (this.jsonMode || !this.live) return;
        for (const line of event.thought.trim().split('\n')) {
          const trimmed = line.trim();
          if (trimmed) console.log(chalk.dim(`  🤔 ${trimmed}`));
        }
      },

      onAgentProgress: (event) => {
        if (this.jsonMode || !this.live) return;
        for (const line of event.message.trim().split('\n')) {
          const trimmed = line.trim();
          if (trimmed) console.log(chalk.dim(`  💭 ${trimmed}`));
        }
      },

      onToolCallStart: (event) => {
        if (this.jsonMode || !this.live) return;
        this.thinkingSpinner?.stop();
        this.thinkingSpinner = null;
        const icon = getToolIcon(event.tool);
        const params = summarizeToolParams(event.tool, event.params);
        this.currentToolText = `${icon} ${event.tool}${params}`;
        this.toolSpinner = ora({
          text: chalk.white(this.currentToolText),
          indent: 2,
          color: 'cyan',
        }).start();
      },

      onToolCallComplete: (event) => {
        if (this.jsonMode || !this.live) return;
        const summary = summarizeToolResult(event.result, event.error);
        if (event.error) {
          this.toolSpinner?.fail(chalk.red(`${this.currentToolText} — ${event.error}`));
        } else {
          this.toolSpinner?.succeed(chalk.white(this.currentToolText) + chalk.gray(` → ${summary}`));
        }
        this.toolSpinner = null;
        // Restart thinking spinner even on error — LLM still processes the result and may retry
        this.thinkingSpinner = ora({ text: chalk.dim('Thinking...'), indent: 2, color: 'gray' }).start();
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
