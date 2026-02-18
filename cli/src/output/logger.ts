import chalk from 'chalk';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export function log(level: LogLevel, message: string, data?: unknown): void {
  const timestamp = new Date().toISOString().slice(11, 19);
  const prefix = {
    debug: chalk.gray('[DEBUG]'),
    info: chalk.blue('[INFO]'),
    warn: chalk.yellow('[WARN]'),
    error: chalk.red('[ERROR]'),
  }[level];

  console.log(`${chalk.gray(timestamp)} ${prefix} ${message}`);
  if (data) {
    console.log(chalk.gray(JSON.stringify(data, null, 2)));
  }
}
