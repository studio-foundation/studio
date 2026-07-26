import chalk from 'chalk';
import { loadConfig } from '../config.js';
import { findStudioDir } from '../studio-dir.js';
import { collectChecks } from '../preflight.js';
import type { PreflightCheck } from '../preflight.js';

const SYMBOL: Record<PreflightCheck['status'], string> = {
  ok: chalk.green('✓'),
  warn: chalk.yellow('⚠'),
  fail: chalk.red('✗'),
};

export async function doctorCommand(): Promise<void> {
  const studioDir = await findStudioDir(process.cwd());
  if (!studioDir) {
    console.error(chalk.red('Error: no .studio/ directory found from here.'));
    console.error('  Create one: studio init');
    process.exit(1);
  }

  const config = await loadConfig();
  const checks = await collectChecks(studioDir, config);
  const width = Math.max(...checks.map((c) => c.name.length));

  console.log();
  for (const check of checks) {
    console.log(`  ${SYMBOL[check.status]} ${check.name.padEnd(width)}  ${check.detail}`);
  }

  const problems = checks.filter((c) => c.status !== 'ok');
  if (problems.length === 0) {
    console.log(`\n  ${chalk.green('No problems found.')} This machine can run this project.\n`);
    return;
  }

  const failures = problems.filter((c) => c.status === 'fail');
  console.log(
    `\n  ${problems.length} problem${problems.length > 1 ? 's' : ''} found${failures.length > 0 ? ' — fix before running' : ''}:\n`
  );
  for (const problem of problems) {
    if (problem.fix) console.log(`${problem.fix}\n`);
  }

  if (failures.length > 0) process.exit(1);
}
