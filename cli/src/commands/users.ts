// cli/src/commands/users.ts
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import chalk from 'chalk';
import { findStudioDir } from '../studio-dir.js';
import { UserStore } from '@studio/api/user-store';

async function getStore(): Promise<{ store: UserStore; close: () => void }> {
  const studioDir = await findStudioDir(process.cwd());
  if (!studioDir) throw new Error('No .studio/ directory found. Run studio init first.');

  const dbPath = join(studioDir, 'runs', 'runs.db');
  await mkdir(join(studioDir, 'runs'), { recursive: true });
  const store = new UserStore(dbPath);
  return { store, close: () => store.close() };
}

export async function usersCommand(
  subcommand: string,
  args: string[],
  options: { plan?: string },
): Promise<void> {
  switch (subcommand) {
    case 'list': {
      const { store, close } = await getStore();
      try {
        const users = store.listUsers();
        if (users.length === 0) {
          console.log(chalk.gray('No users found.'));
        } else {
          console.log(chalk.bold('Users:'));
          for (const { email, plan, id } of users) {
            console.log(`  ${chalk.cyan(email)} — plan: ${chalk.yellow(plan)} — id: ${chalk.gray(id)}`);
          }
        }
      } finally {
        close();
      }
      break;
    }

    case 'add': {
      const email = args[0];
      if (!email) {
        console.error(chalk.red('Usage: studio users add <email> [--plan pro]'));
        process.exit(1);
      }
      const { store, close } = await getStore();
      try {
        if (store.getUserByEmail(email)) {
          console.error(chalk.red(`User ${email} already exists.`));
          process.exit(1);
        }
        const apiKey = randomBytes(32).toString('hex');
        const user = {
          id: randomUUID(),
          email,
          plan: options.plan ?? 'free',
          api_key: apiKey,
          created_at: new Date().toISOString(),
        };
        store.saveUser(user);
        console.log(chalk.green(`✓ User created: ${email} (plan: ${user.plan})`));
        console.log(chalk.bold('API Key (shown only once):'));
        console.log(chalk.yellow(apiKey));
      } finally {
        close();
      }
      break;
    }

    case 'remove': {
      const email = args[0];
      if (!email) {
        console.error(chalk.red('Usage: studio users remove <email>'));
        process.exit(1);
      }
      const { store, close } = await getStore();
      try {
        const user = store.getUserByEmail(email);
        if (!user) {
          console.error(chalk.red(`User ${email} not found.`));
          process.exit(1);
        }
        store.deleteUser(user.id);
        console.log(chalk.green(`✓ User ${email} deleted.`));
      } finally {
        close();
      }
      break;
    }

    case 'info': {
      const email = args[0];
      if (!email) {
        console.error(chalk.red('Usage: studio users info <email>'));
        process.exit(1);
      }
      const { store, close } = await getStore();
      try {
        const user = store.getUserByEmail(email);
        if (!user) {
          console.error(chalk.red(`User ${email} not found.`));
          process.exit(1);
        }
        const today = new Date().toISOString().slice(0, 10);
        const usage = store.getDailyUsage(user.id, today);
        console.log(chalk.bold(`User: ${user.email}`));
        console.log(`  Plan:       ${chalk.yellow(user.plan)}`);
        console.log(`  ID:         ${chalk.gray(user.id)}`);
        console.log(`  Created:    ${user.created_at}`);
        console.log(chalk.bold(`Today (${today}):`));
        console.log(`  Runs:       ${usage.runs_count}`);
        console.log(`  Tokens:     ${usage.tokens_used}`);
      } finally {
        close();
      }
      break;
    }

    default:
      console.error(chalk.red(`Unknown subcommand: ${subcommand}`));
      console.error('Usage: studio users <list|add|remove|info>');
      process.exit(1);
  }
}
