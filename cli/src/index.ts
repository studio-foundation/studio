#!/usr/bin/env node

import 'dotenv/config';
import { Command } from 'commander';
import { runCommand } from './commands/run.js';
import { statusCommand } from './commands/status.js';
import { listCommand } from './commands/list.js';
import { logsCommand } from './commands/logs.js';
import { validateCommand } from './commands/validate.js';
import { initCommand } from './commands/init.js';
import { configCommand } from './commands/config.js';

const program = new Command();

program
  .name('studio')
  .description('Studio v7 — Agentic pipeline orchestrator')
  .version('0.1.0');

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
  .command('init')
  .description('Initialize a new Studio project in the current directory')
  .option('--template <name>', 'Project template to use (e.g. software)')
  .action(initCommand);

program
  .command('config <action> [args...]')
  .description('Manage Studio configuration (list, get, set)')
  .option('--api-key <key>', 'API key (used with: config set provider <name> --api-key <key>)')
  .action(configCommand);

program.parse();
