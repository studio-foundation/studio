import { execSync } from 'node:child_process';
import chalk from 'chalk';

const KNOWN_EXTENSIONS: Record<string, string> = {
  api: '@studio/api',
};

export async function installExtensionCommand(extension: string): Promise<void> {
  const pkg = KNOWN_EXTENSIONS[extension];
  if (!pkg) {
    console.error(`Unknown extension: ${extension}. Available: ${Object.keys(KNOWN_EXTENSIONS).join(', ')}`);
    process.exit(1);
  }

  console.log(`Installing ${pkg}...`);
  try {
    execSync(`npm install -g ${pkg}`, { stdio: 'inherit' });
    console.log(chalk.green(`✓ ${pkg} installed. Run: studio api start`));
  } catch {
    console.error(chalk.red(`Failed to install ${pkg}`));
    process.exit(1);
  }
}
