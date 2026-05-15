#!/usr/bin/env node

import 'dotenv/config';
import { createRequire } from 'module';
import { Command } from 'commander';
import chalk from 'chalk';
import { runCommand } from './commands/run.js';
import { statusCommand } from './commands/status.js';
import { listCommand } from './commands/list.js';
import { logsCommand } from './commands/logs.js';
import { replayCommand, restartCommand } from './commands/replay.js';
import { validateCommand } from './commands/validate.js';
import { initCommand } from './commands/init.js';
import { configCommand } from './commands/config.js';
import { toolsCommand } from './commands/tools.js';
import { integrationsCommand } from './commands/integrations.js';
import { templatesCommand } from './commands/templates.js';
import { templateCommand } from './commands/template/index.js';
import { projectCommand } from './commands/project.js';
import { apiStartCommand, apiStopCommand, apiStatusCommand } from './commands/api.js';
import { installExtensionCommand } from './commands/install.js';
import { createRegistryCommand } from './commands/registry/index.js';
import { usersCommand } from './commands/users.js';
import { ollamaCommand } from './commands/ollama.js';
import { loadConfig } from './config.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const program = new Command();

program
  .name('studio')
  .description('Studio — Declarative YAML runtime for AI agents')
  .version(version);

program
  .command('run <project/pipeline>')
  .description('Run a pipeline (e.g. studio run cuisine/recipe-generator)')
  .option('-i, --input <text>', 'Input description for the pipeline')
  .option('-f, --input-file <path>', 'Path to YAML input file')
  .option('-r, --repo <path>', 'Path to the target repository')
  .option('--repo-url <url>', 'Git URL to clone as target repository')
  .option('--config <path>', 'Path to .studiorc.yaml config file')
  .option('--provider <name>', 'Override LLM provider for all stages (e.g. mock)')
  .option('--json', 'Output results as JSON')
  .option('--verbose', 'Show detailed execution logs')
  .option('--live', 'Show live per-tool-call spinners during execution')
  .option('--anonymize', 'Anonymize PII in inputs and outputs before sending to LLM')
  .action(runCommand);

program
  .command('status [run-id]')
  .description('Show status of a pipeline run')
  .option('--json', 'Output as JSON')
  .action(statusCommand);

program
  .command('logs <run-id>')
  .description('Show log for a pipeline run (from .studio/runs/*.jsonl)')
  .option('--raw', 'Output raw JSONL lines')
  .option('--json', 'Output as pretty-printed JSON array')
  .action(logsCommand);

program
  .command('replay <run-id>')
  .description('Replay a past pipeline run from JSONL logs, or re-execute from a specific stage')
  .option('--verbose', 'Show complete outputs and tool call results')
  .option('--restart', 'Re-execute pipeline from a specific stage (requires --stage)')
  .option('--stage <index|name>', 'Stage index (0-based) or name to restart from (use with --restart)')
  .option('--provider <name>', 'Override LLM provider (e.g. mock) — applies to resumed stages only')
  .action((runId: string, options: { verbose?: boolean; restart?: boolean; stage?: string; provider?: string }) => {
    if (options.restart) {
      if (!options.stage) {
        console.error(chalk.red('Error: --restart requires --stage <index|name>'));
        process.exit(1);
      }
      return restartCommand(runId, { stage: options.stage, verbose: options.verbose, provider: options.provider });
    }
    return replayCommand(runId, options);
  });

program
  .command('list <resource>')
  .description('List projects, pipelines, agents, or runs')
  .option('--status <status>', 'Filter runs by status')
  .option('--limit <n>', 'Limit number of results', '10')
  .option('--project <name>', 'Filter runs by project')
  .option('--json', 'Output as JSON')
  .action(listCommand);

program
  .command('validate <contract> <output>')
  .description('Validate an output against a contract')
  .action(validateCommand);

program
  .command('init [name]')
  .description('Initialize a new Studio project in the current directory')
  .option('--template <name>', 'Project template to use (e.g. software)')
  .option('--project <name>', 'Project name (defaults to directory name or "default")')
  .option('--provider <name>', 'LLM provider (anthropic, openai, ollama) — enables direct mode')
  .option('--model <name>', 'Default model (e.g. qwen2.5:14b for ollama, claude-sonnet-4-20250514 for anthropic)')
  .option('--api-key <key>', 'API key for the provider')
  .option('--force', 'Backup existing .studio/ and reinitialize')
  .option('--yes', 'Skip confirmation prompts (for CI/CD); auto-selects ollama if available')
  .option('--no-tools', 'Skip tool installation (direct mode only)')
  .action(initCommand);

program
  .command('config <action> [args...]')
  .description('Manage Studio configuration (list, get, set, add-provider)')
  .option('--api-key <key>', 'API key (used with: config set provider <name> --api-key <key>; config add-provider <name> --api-key <key>)')
  .option('--set-default', 'Set as default provider (used with: config add-provider)')
  .action(configCommand);

program
  .command('tools <action> [args...]')
  .description('Manage Studio tools (list, add, remove, info)')
  .action(toolsCommand);

program
  .command('integrations <action> [args...]')
  .description('Manage Studio integrations (install, list, remove, test, set)')
  .action((action: string, args: string[]) => {
    void integrationsCommand(action, args, {});
  });

program
  .command('templates <action> [args...]')
  .description('Manage Studio templates (list)')
  .action(templatesCommand);


program
  .command('template <action> [args...]')
  .description('Template operations (validate)')
  .action(templateCommand);

program
  .command('project <action> [args...]')
  .description('Manage Studio projects (add)')
  .option('--template <name>', 'Template to use (blank, software, …)')
  .option('--description <desc>', 'Project description')
  .action(projectCommand);

program
  .command('api <action>')
  .description('Manage the Studio API server (start, stop, status)')
  .option('--port <port>', 'Port to listen on (default: 3700)')
  .option('--config <path>', 'Path to config file')
  .action((action: string, options: { port?: string; config?: string }) => {
    if (action === 'start') {
      void apiStartCommand(options);
    } else if (action === 'stop') {
      void apiStopCommand();
    } else if (action === 'status') {
      void apiStatusCommand(options);
    } else {
      console.error(`Unknown api action: ${action}. Use: studio api start|stop|status`);
      process.exit(1);
    }
  });

program
  .command('install <extension>')
  .description('Install a Studio extension (api)')
  .action((extension: string) => {
    void installExtensionCommand(extension);
  });

program.addCommand(createRegistryCommand());

const usersCmd = program.command('users').description('Manage users');

usersCmd
  .command('list')
  .description('List all users')
  .action(() => { void usersCommand('list', [], {}); });

usersCmd
  .command('add <email>')
  .description('Create a new user')
  .option('--plan <plan>', 'User plan (free|pro|unlimited)', 'free')
  .action((email: string, opts: { plan?: string }) => { void usersCommand('add', [email], opts); });

usersCmd
  .command('remove <email>')
  .description('Remove a user')
  .action((email: string) => { void usersCommand('remove', [email], {}); });

usersCmd
  .command('info <email>')
  .description("Show user details and today's usage")
  .action((email: string) => { void usersCommand('info', [email], {}); });

program
  .command('ollama <action> [model]')
  .description('Manage local Ollama instance (start, stop, status, pull <model>)')
  .action(async (action: string, model: string | undefined) => {
    const config = await loadConfig();
    const baseUrl = config.providers?.ollama?.baseUrl ?? 'http://localhost:11434';
    void ollamaCommand(action, model, baseUrl);
  });

program.parse();
