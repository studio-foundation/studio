// cli/src/output/map-progress.ts
// Live progress renderer for a fan-out (map) stage.
//
// A map stage runs a sub-pipeline once per item of a list. Without a dedicated
// renderer it shows as a single spinner that hangs until every item is done —
// unusable for wiki-creator's real workloads (hundreds of items, runs measured
// in hours). This renderer surfaces, in real time:
//   - a header line naming the fan-out (item count + concurrency),
//   - a live status line: completed/failed counts, what the last settled item
//     produced, and the identities of the items currently in flight (works with
//     concurrency > 1),
//   - a permanent line the moment an item fails, naming it and its child run ID,
//   - a final summary line.
//
// Map items render one line each here. Child sub-pipeline stages bubble up via
// the spawner's tagging adapter (STU-620): for a nested `call` stage outside a
// map, ProgressDisplay prints them indented, but inside a map stage they stay
// collapsed to this renderer's per-item line — rendering both would smear the
// map's live counts.

import chalk from 'chalk';
import { type Ora } from 'ora';
import { formatDuration } from './formatter.js';
import { makeSpinner } from './spinner.js';

interface InFlight {
  label: string;
}

/** Max width of the joined "in flight: …" label list before it is truncated. */
const MAX_INFLIGHT_WIDTH = 60;
/** Max width of a single item label. */
const MAX_LABEL_WIDTH = 32;
/** Max width of an error message on a per-item failure line. */
const MAX_ERROR_WIDTH = 160;
/** Max width of the "last: …" result summary. */
const MAX_RESULT_WIDTH = 40;
/** How many scalar fields of an item's output make up its result summary. */
const RESULT_FIELDS = 3;

function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * What an item *produced*, for the live line. An item's label is derived from
 * its input, so a value the child computes — a classification, a verdict — is
 * blank there and only exists in the child's output. Domain-agnostic: the first
 * few short scalar fields, in declaration order. Long strings are skipped, not
 * truncated — a summary paragraph would swallow the line.
 */
export function summarizeItemOutput(output: unknown): string | undefined {
  if (typeof output === 'string') return output.trim() || undefined;
  if (typeof output === 'number' || typeof output === 'boolean') return String(output);
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return undefined;

  const parts: string[] = [];
  for (const value of Object.values(output as Record<string, unknown>)) {
    if (typeof value === 'number' || typeof value === 'boolean') parts.push(String(value));
    else if (typeof value === 'string' && value.trim() && value.trim().length <= MAX_RESULT_WIDTH) {
      parts.push(value.trim());
    }
    if (parts.length === RESULT_FIELDS) break;
  }
  return parts.length ? parts.join(', ') : undefined;
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
  private lastResult: string | null = null;
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
    this.lastResult = null;
    this.inFlight.clear();

    console.log(
      chalk.cyan(`  ↳ ${mapName}`) +
        chalk.gray(` — fan-out over ${total} item${total === 1 ? '' : 's'} (concurrency ${concurrency})`),
    );

    this.spinner = makeSpinner({ text: this.statusText(), indent: 2, color: 'cyan' }).start();
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
   * A success carries what it produced onto the live line.
   */
  itemComplete(
    index: number,
    status: 'success' | 'failed',
    label: string,
    runId?: string,
    error?: string,
    output?: unknown,
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
      const result = summarizeItemOutput(output);
      if (result) {
        this.lastResult = `${truncate(label, MAX_LABEL_WIDTH)} — ${truncate(result, MAX_RESULT_WIDTH)}`;
      }
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
    const lastStr = this.lastResult ? chalk.dim(` · last: ${this.lastResult}`) : '';
    const labels = [...this.inFlight.values()].map((f) => f.label);
    const flightStr = labels.length
      ? chalk.dim(` · ${labels.length} in flight: ${truncateList(labels, MAX_INFLIGHT_WIDTH)}`)
      : '';
    return `${head}${failStr}${lastStr}${flightStr}${chalk.gray(` (${elapsed}s)`)}`;
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
