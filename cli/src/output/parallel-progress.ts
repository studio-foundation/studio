// cli/src/output/parallel-progress.ts
// Multi-line renderer for parallel stage display.
// Uses ANSI escape codes to update lines in-place without creating concurrent ora spinners.

import chalk from 'chalk';
import { formatStageLine } from './formatters.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface StageEntry {
  prefix: string;
  stageName: string;
  startTime: number;
  done: boolean;
  finalText?: string;
}

/**
 * Renders N parallel stages as N lines that update in-place.
 * Each line shows a spinner + elapsed time while running, then freezes on completion.
 *
 * Visual output:
 *   [5/14] entity-resolution-PERSON ............ ⠇ (12s)
 *   [6/14] entity-resolution-PLACE ............. ⠙ (12s)
 *   [7/14] entity-resolution-ORG ............... ⠹ (12s)
 */
export class ParallelRenderer {
  private stages: StageEntry[] = [];
  private frameIdx = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * Register a new parallel stage and print its initial line.
   * All addStage calls fire synchronously before any stage completes,
   * so lines are built up before the first timer tick.
   */
  addStage(prefix: string, stageName: string): void {
    const entry: StageEntry = {
      prefix,
      stageName,
      startTime: Date.now(),
      done: false,
    };
    this.stages.push(entry);
    process.stdout.write(this.runningText(entry) + '\n');

    if (!this.timer) {
      this.timer = setInterval(() => this.renderAll(), 100);
    }
  }

  /**
   * Freeze a stage's line with its final status text (✓ or ✗).
   */
  completeStage(stageName: string, finalText: string): void {
    const entry = this.stages.find(s => s.stageName === stageName);
    if (!entry) return;
    entry.done = true;
    entry.finalText = finalText;
    this.renderAll();

    if (this.stages.every(s => s.done)) {
      this.stop();
    }
  }

  private runningText(entry: StageEntry): string {
    const elapsed = Math.floor((Date.now() - entry.startTime) / 1000);
    const frame = chalk.cyan(SPINNER_FRAMES[this.frameIdx]);
    return formatStageLine(entry.prefix, entry.stageName, `${frame} (${elapsed}s)`);
  }

  /**
   * Redraw all lines in one pass, moving the cursor to the top of the block first.
   * Node.js is single-threaded so this is safe — timer and event handlers don't interleave.
   */
  private renderAll(): void {
    this.frameIdx = (this.frameIdx + 1) % SPINNER_FRAMES.length;
    const N = this.stages.length;
    if (N === 0) return;

    // Move cursor to the top of the rendered block
    process.stdout.write(`\x1B[${N}A`);

    for (const entry of this.stages) {
      const text = entry.done ? entry.finalText! : this.runningText(entry);
      // Clear line, go to column 0, write text, advance to next line
      process.stdout.write(`\x1B[2K\r${text}\n`);
    }
    // Cursor is now positioned below the last line, ready for more output
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  interrupt(): void {
    this.stop();
  }
}
