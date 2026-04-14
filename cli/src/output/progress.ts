import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import type { EngineEvents } from '@studio-foundation/engine';
import { formatDuration } from './formatter.js';
import { summarizeToolCalls, getToolIcon, summarizeToolParams, summarizeToolResult, formatStageOutput, formatToolResult, formatTokens, formatStageLine, countWriteFiles } from './formatters.js';
import { ParallelRenderer } from './parallel-progress.js';

export class ProgressDisplay {
  private spinner: Ora | null = null;
  private spinnerText = '';
  private toolSpinner: Ora | null = null;
  private thinkingSpinner: Ora | null = null;
  private currentToolText = '';
  private isStreamingTokens = false;
  private stageStartTime = 0;
  private timerInterval: ReturnType<typeof setInterval> | null = null;

  // Parallel group rendering
  private isInParallelGroup = false;
  private parallelRenderer: ParallelRenderer | null = null;

  // State tracking for stage progress
  runId = '';
  private currentAttempt = 1;
  private currentStageIndex = 0;
  private currentTotalStages = 0;
  private currentStageName = '';

  readonly live: boolean;
  readonly verbose: boolean;

  constructor(
    private jsonMode: boolean,
    mode: 'quiet' | 'verbose' | 'live' | { live: boolean; verbose: boolean }
  ) {
    if (typeof mode === 'string') {
      this.live = mode === 'live';
      this.verbose = mode === 'verbose';
    } else {
      this.live = mode.live;
      this.verbose = mode.verbose;
    }
  }

  private resetStageTimer(): void {
    this.stageStartTime = Date.now();
  }

  private startTimer(updateFn: (elapsed: string) => void): void {
    this.timerInterval = setInterval(() => {
      const s = Math.floor((Date.now() - this.stageStartTime) / 1000);
      updateFn(`${s}s`);
    }, 1000);
  }

  private clearTimer(): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  private elapsedSeconds(): number {
    return Math.floor((Date.now() - this.stageStartTime) / 1000);
  }

  interrupt(): void {
    this.clearTimer();
    this.parallelRenderer?.interrupt();
    this.parallelRenderer = null;
    this.isInParallelGroup = false;
    if (this.isStreamingTokens) {
      process.stdout.write('\n');
      this.isStreamingTokens = false;
    }
    this.toolSpinner?.stop();
    this.toolSpinner = null;
    this.thinkingSpinner?.stop();
    this.thinkingSpinner = null;
    this.spinner?.stop();
    this.spinner = null;
  }

  getEvents(): EngineEvents {
    return {
      onPipelineStart: (event) => {
        if (this.jsonMode) return;
        this.runId = event.run_id;
        console.log(chalk.blue(`\nRunning pipeline: ${event.pipeline_name}\n`));
      },

      onStageStart: (event) => {
        if (this.jsonMode) return;
        this.currentStageIndex = event.stage_index;
        this.currentTotalStages = event.total_stages;
        this.currentStageName = event.stage_name;
        this.currentAttempt = 1;
        const prefix = `[${event.stage_index + 1}/${event.total_stages}]`;

        if (this.isInParallelGroup) {
          // Parallel mode: delegate to multi-line renderer (no ora spinner)
          this.parallelRenderer!.addStage(prefix, event.stage_name);
          return;
        }

        if (this.live) {
          console.log(chalk.cyan(`${formatStageLine(prefix, event.stage_name, '')}...`));
          this.thinkingSpinner = ora({ text: chalk.dim('Thinking... (0s)'), indent: 2, color: 'gray' }).start();
          this.resetStageTimer();
          this.startTimer((elapsed) => {
            if (this.thinkingSpinner) {
              this.thinkingSpinner.text = chalk.dim(`Thinking... (${elapsed})`);
            }
          });
        } else {
          this.spinnerText = formatStageLine(prefix, event.stage_name, '');
          this.spinner = ora({ text: this.spinnerText, color: 'cyan' }).start();
          this.resetStageTimer();
          this.startTimer((elapsed) => {
            if (this.spinner) {
              this.spinner.text = formatStageLine(prefix, event.stage_name, `(${elapsed})`);
            }
          });
        }
      },

      onStageComplete: (event) => {
        if (this.jsonMode) return;

        const duration = formatDuration(event.duration_ms);
        const prefix = `[${event.stage_index + 1}/${event.total_stages}]`;

        // Build compact info parts: duration, tokens, files
        const infoParts: string[] = [duration];
        if (event.token_usage && event.token_usage.total_tokens > 0) {
          infoParts.push(`${formatTokens(event.token_usage.total_tokens)} tokens`);
        }
        const filesWritten = event.tool_calls ? countWriteFiles(event.tool_calls) : 0;
        if (filesWritten > 0) {
          infoParts.push(`${filesWritten} file${filesWritten !== 1 ? 's' : ''}`);
        }
        const infoStr = infoParts.join(', ');

        if (this.isInParallelGroup) {
          // Parallel mode: freeze the line with final status
          let finalText: string;
          if (event.status === 'success') {
            finalText = formatStageLine(prefix, event.stage_name, chalk.green('✓') + chalk.gray(` (${infoStr})`));
          } else if (event.status === 'rejected') {
            finalText = formatStageLine(prefix, event.stage_name, chalk.red('✗ rejected') + chalk.gray(` (${duration})`));
          } else {
            finalText = formatStageLine(prefix, event.stage_name, chalk.red('✗ failed') + chalk.gray(` (${infoStr})`));
          }
          this.parallelRenderer?.completeStage(event.stage_name, finalText);
          return;
        }

        if (this.live) {
          if (this.isStreamingTokens) {
            process.stdout.write('\n');
            this.isStreamingTokens = false;
          }
          this.clearTimer();
          this.thinkingSpinner?.stop();
          this.thinkingSpinner = null;
          if (event.status === 'success') {
            console.log(chalk.green(`  ✓`) + chalk.gray(` (${infoStr})`));
          } else if (event.status === 'rejected') {
            console.log(chalk.red(`  ✗ rejected`) + chalk.gray(` (${duration})`));
            if (event.rejection_reason) console.log(chalk.red(`    ${event.rejection_reason}`));
            if (event.rejection_details?.length) {
              for (const detail of event.rejection_details) {
                console.log(chalk.yellow(`      - ${detail}`));
              }
            }
          } else {
            console.log(chalk.red(`  ✗ failed`) + chalk.gray(` (${infoStr})`));
          }
        } else if (event.status === 'success') {
          this.spinner?.succeed(
            formatStageLine(prefix, event.stage_name, chalk.green('✓') + chalk.gray(` (${infoStr})`))
          );
        } else if (event.status === 'rejected') {
          this.spinner?.fail(
            formatStageLine(prefix, event.stage_name, chalk.red('✗ rejected') + chalk.gray(` (${duration})`))
          );
          if (event.rejection_reason) {
            console.log(chalk.red(`  ${event.rejection_reason}`));
          }
          if (event.rejection_details?.length) {
            for (const detail of event.rejection_details) {
              console.log(chalk.yellow(`    - ${detail}`));
            }
          }
        } else {
          this.spinner?.fail(
            formatStageLine(prefix, event.stage_name, chalk.red('✗ failed') + chalk.gray(` (${infoStr})`))
          );
        }
        this.clearTimer();
        this.spinner = null;

        // Tool call summary: quiet + verbose only (in live mode, each was shown individually)
        if (!this.live && event.tool_calls && event.tool_calls.length > 0) {
          const summary = summarizeToolCalls(event.tool_calls);
          if (summary) console.log(chalk.gray(`  ${summary}`));
        }

        // Formatted output: verbose only
        if (this.verbose && event.status !== 'rejected' && event.output && typeof event.output === 'object') {
          const depth = Infinity;
          const formatted = formatStageOutput(event.output as Record<string, unknown>, depth);
          if (formatted) {
            for (const line of formatted.split('\n')) {
              console.log(chalk.gray(`  ${line}`));
            }
          }
        }

        // Token breakdown: verbose mode (both standalone and live+verbose)
        if (this.verbose && event.token_usage) {
          const u = event.token_usage;
          console.log(chalk.gray(`  Tokens: ${u.prompt_tokens} prompt + ${u.completion_tokens} completion = ${u.total_tokens} total`));
        }
      },

      onTaskRetry: (event) => {
        if (this.jsonMode) return;

        if (this.isInParallelGroup) {
          // In parallel mode the spinner keeps running; nothing to do here.
          return;
        }

        this.clearTimer();
        // Stop any active spinners before printing retry info
        if (this.isStreamingTokens) {
          process.stdout.write('\n');
          this.isStreamingTokens = false;
        }
        this.toolSpinner?.stop();
        this.toolSpinner = null;
        this.thinkingSpinner?.stop();
        this.thinkingSpinner = null;

        this.currentAttempt = event.attempt + 1;
        const prefix = `[${this.currentStageIndex + 1}/${this.currentTotalStages}]`;
        const reason = event.failures.length > 0 ? event.failures[0] : 'validation failed';

        if (this.live) {
          console.log(chalk.yellow(`  ✗ retry (${reason})`));
        } else {
          this.spinner?.fail(
            formatStageLine(prefix, this.currentStageName, chalk.yellow('✗ retry') + chalk.gray(` (${reason})`))
          );
          this.spinner = null;
        }

        // Verbose extras
        if (this.verbose && event.failures.length > 1) {
          for (const failure of event.failures.slice(1)) {
            console.log(chalk.yellow(`    - ${failure}`));
          }
        }
        if (this.verbose && event.agent_output_raw) {
          console.log(chalk.gray(`    Raw response: ${event.agent_output_raw.slice(0, 300)}`));
        }

        // Restart spinner with next attempt counter
        if (!this.live) {
          const suffix = `(attempt ${this.currentAttempt}/${event.max_attempts})`;
          this.spinnerText = formatStageLine(prefix, this.currentStageName, suffix);
          this.spinner = ora({ text: this.spinnerText, color: 'cyan' }).start();
        }
      },

      onGroupStart: (event) => {
        if (event.parallel) {
          this.isInParallelGroup = true;
          this.parallelRenderer = new ParallelRenderer();
        }
        // Otherwise silent — sequential group is transparent at the pipeline level
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
        if (this.isInParallelGroup) {
          this.parallelRenderer?.stop();
          this.parallelRenderer = null;
          this.isInParallelGroup = false;
        }
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
        if (this.jsonMode || !this.live || this.isInParallelGroup) return;
        for (const line of event.thought.trim().split('\n')) {
          const trimmed = line.trim();
          if (trimmed) console.log(chalk.dim(`  🤔 ${trimmed}`));
        }
      },

      onAgentProgress: (event) => {
        if (this.jsonMode || !this.live || this.isInParallelGroup) return;
        for (const line of event.message.trim().split('\n')) {
          const trimmed = line.trim();
          if (trimmed) console.log(chalk.dim(`  💭 ${trimmed}`));
        }
      },

      onAgentToken: (event) => {
        if (this.jsonMode || !this.live || this.isInParallelGroup) return;
        if (this.thinkingSpinner) {
          this.clearTimer();
          this.thinkingSpinner.stop();
          this.thinkingSpinner = null;
          process.stdout.write('  '); // indent to match spinner position
        }
        this.isStreamingTokens = true;
        process.stdout.write(chalk.dim(event.token));
      },

      onToolCallStart: (event) => {
        if (this.jsonMode || !this.live || this.isInParallelGroup) return;
        // End any in-progress token stream line before starting tool spinner
        if (this.isStreamingTokens) {
          process.stdout.write('\n');
          this.isStreamingTokens = false;
        }
        this.clearTimer();
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
        if (this.jsonMode || !this.live || this.isInParallelGroup) return;
        const summary = summarizeToolResult(event.result, event.error);
        if (event.error) {
          this.toolSpinner?.fail(chalk.red(`${this.currentToolText} — ${event.error}`));
        } else {
          this.toolSpinner?.succeed(chalk.white(this.currentToolText) + chalk.gray(` → ${summary}`));
        }
        this.toolSpinner = null;

        // Verbose: print full tool result below the spinner line
        if (this.verbose && !event.error) {
          const full = formatToolResult(event.result);
          for (const line of full.split('\n')) {
            console.log(chalk.gray(line));
          }
        }

        // Restart thinking spinner even on error — LLM still processes the result and may retry
        const fromSec = this.elapsedSeconds();
        this.thinkingSpinner = ora({ text: chalk.dim(`Thinking... (from ${fromSec}s)`), indent: 2, color: 'gray' }).start();
        this.thinkingSpinner.text = chalk.dim(`Thinking... (from ${fromSec}s)`);
        this.startTimer((elapsed) => {
          if (this.thinkingSpinner) {
            this.thinkingSpinner.text = chalk.dim(`Thinking... (from ${elapsed})`);
          }
        });
      },

      onPipelineComplete: (event) => {
        if (this.jsonMode) return;

        console.log('');
        const duration = formatDuration(event.duration_ms);
        const tokenStr = event.total_tokens > 0 ? `, ${formatTokens(event.total_tokens)} tokens` : '';
        const toolStr = event.total_tool_calls > 0 ? `, ${event.total_tool_calls} tool calls` : '';

        if (event.status === 'success') {
          console.log(chalk.green('✓ Pipeline completed') + chalk.gray(` (${duration}${tokenStr}${toolStr})`));
        } else if (event.status === 'rejected') {
          console.log(chalk.red('✗ Pipeline rejected') + chalk.gray(` (${duration}${tokenStr})`));
        } else {
          console.log(chalk.red('✗ Pipeline failed') + chalk.gray(` (${duration}${tokenStr})`));
        }
      },
    };
  }
}
