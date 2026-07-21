// cli/src/output/map-progress.ts
// Live progress renderer for a fan-out (map) stage.
//
// A map stage runs a sub-pipeline once per item of a list. Without a dedicated
// renderer it shows as a single spinner that hangs until every item is done —
// unusable for wiki-creator's real workloads (hundreds of items, runs measured
// in hours). This renderer surfaces, in real time:
//   - a header line naming the fan-out (item count + concurrency),
//   - a live status line: completed/failed counts and the identities of the
//     items currently in flight (works with concurrency > 1),
//   - a permanent line the moment an item fails, naming it and its child run ID,
//   - a final summary line.
//
// Map items render one line each here. Child sub-pipeline stages now bubble up
// via the spawner's tagging adapter (STU-620) and are printed indented by the
// ProgressDisplay handlers; this renderer still owns the per-item summary line.

import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import { formatDuration } from './formatter.js';

interface InFlight {
  label: string;
}

/** Max width of the joined "in flight: …" label list before it is truncated. */
const MAX_INFLIGHT_WIDTH = 60;
/** Max width of a single item label. */
const MAX_LABEL_WIDTH = 32;
/** Max width of an error message on a per-item failure line. */
const MAX_ERROR_WIDTH = 160;

function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function truncateList(labels: string[], max: number): string {
  const joined = labels.join(', ');
  return joined.length <= max ? joined : `${joined.slice(0, max - 1)}…`;
}

export class MapRenderer {
  private spinner: Ora | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = Date.now();
  private mapName = '';
  private total = 0;
  private done = 0;
  private failed = 0;
  private readonly inFlight = new Map<number, InFlight>();

  /**
   * Begin rendering. Prints a permanent header line, then a live status line
   * that updates in place. `live` controls animation only — a non-TTY / piped
   * stream still gets the header, per-item failures, and the final summary
   * (ora degrades to non-animated frames on its own).
   */
  start(mapName: string, total: number, concurrency: number): void {
    this.startedAt = Date.now();
    this.mapName = mapName;
    this.total = total;
    this.done = 0;
    this.failed = 0;
    this.inFlight.clear();

    console.log(
      chalk.cyan(`  ↳ ${mapName}`) +
        chalk.gray(` — fan-out over ${total} item${total === 1 ? '' : 's'} (concurrency ${concurrency})`),
    );

    this.spinner = ora({ text: this.statusText(), indent: 2, color: 'cyan' }).start();
    this.timer = setInterval(() => {
      if (this.spinner) this.spinner.text = this.statusText();
    }, 250);
  }

  /** An item entered flight — track it so it appears in the status line. */
  itemStart(index: number, label: string): void {
    this.inFlight.set(index, { label: truncate(label, MAX_LABEL_WIDTH) });
    if (this.spinner) this.spinner.text = this.statusText();
  }

  /**
   * An item settled. Failures are surfaced immediately as a permanent line
   * (naming the item and its child run ID) — not buried in the end aggregate.
   */
  itemComplete(
    index: number,
    status: 'success' | 'failed',
    label: string,
    runId?: string,
    error?: string,
  ): void {
    this.inFlight.delete(index);
    if (status === 'failed') {
      this.failed++;
      this.persist(
        chalk.red(`    ✗ ${truncate(label, MAX_LABEL_WIDTH)} failed`) +
          (runId ? chalk.gray(` (run ${runId})`) : '') +
          (error ? chalk.gray(`: ${truncate(error, MAX_ERROR_WIDTH)}`) : ''),
      );
    } else {
      this.done++;
    }
    if (this.spinner) this.spinner.text = this.statusText();
  }

  /** Tear down the live line and print the final summary. */
  finish(succeeded: number, failed: number, status: string): void {
    this.stopTimer();
    this.spinner?.stop();
    this.spinner = null;

    const duration = formatDuration(Date.now() - this.startedAt);
    const counts =
      failed > 0
        ? `${succeeded}/${this.total} succeeded, ${chalk.red(`${failed} failed`)}`
        : `${succeeded}/${this.total} succeeded`;
    const icon = status === 'success' ? chalk.green('✓') : chalk.red('✗');
    console.log(`  ${icon} ${chalk.cyan(this.mapName)} ${counts}` + chalk.gray(` (${duration})`));
  }

  /** Ctrl-C / abort — drop the live line without a summary. */
  interrupt(): void {
    this.stopTimer();
    this.spinner?.stop();
    this.spinner = null;
  }

  private statusText(): string {
    const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
    const head = chalk.cyan(`${this.done}/${this.total} done`);
    const failStr = this.failed > 0 ? chalk.red(`, ${this.failed} failed`) : '';
    const labels = [...this.inFlight.values()].map((f) => f.label);
    const flightStr = labels.length
      ? chalk.dim(` · ${labels.length} in flight: ${truncateList(labels, MAX_INFLIGHT_WIDTH)}`)
      : '';
    return `${head}${failStr}${flightStr}${chalk.gray(` (${elapsed}s)`)}`;
  }

  /** Print a permanent line above the live status line, then restore it. */
  private persist(line: string): void {
    if (this.spinner) {
      this.spinner.stop();
      console.log(line);
      this.spinner.start();
    } else {
      console.log(line);
    }
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
