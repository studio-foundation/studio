import chalk from 'chalk';
import { findStudioDir } from '../studio-dir.js';
import { parseDuration, pruneRuns } from '../runs-retention.js';

export interface RunsPruneOptions {
  keepLast?: string;
  maxAge?: string;
  keepStatus?: string[];
  dryRun?: boolean;
}

export async function runsPruneCommand(options: RunsPruneOptions): Promise<void> {
  const studioDir = await findStudioDir(process.cwd());
  if (!studioDir) {
    console.error(chalk.red('No .studio/ directory found. Run this from a Studio project.'));
    process.exit(1);
  }

  try {
    const keepLast = options.keepLast === undefined ? undefined : Number(options.keepLast);
    if (keepLast !== undefined && !(Number.isInteger(keepLast) && keepLast >= 0)) {
      throw new Error(`Invalid --keep-last "${options.keepLast}": expected a non-negative integer`);
    }
    const result = await pruneRuns(studioDir, {
      keepLast,
      maxAgeMs: options.maxAge === undefined ? undefined : parseDuration(options.maxAge),
      keepStatus: options.keepStatus,
      dryRun: options.dryRun,
    });

    if (result.runs.length === 0) {
      console.log(chalk.gray('No runs to prune.'));
      return;
    }
    for (const run of result.runs) {
      console.log(chalk.gray(`  ${run.file}  ${run.status}  ${run.ageDays}d old`));
    }
    const summary = `${result.runs.length} run log(s) and ${result.keymaps} anonymization keymap(s)`;
    console.log(options.dryRun ? chalk.yellow(`Would remove ${summary}`) : chalk.green(`✓ Removed ${summary}`));
  } catch (error) {
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}
