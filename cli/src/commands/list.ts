import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import chalk from 'chalk';
import { loadConfig } from '../config.js';

const RUNS_DIR = '.studio/runs';

interface ListOptions {
  status?: string;
  limit?: string;
  json?: boolean;
  project?: string;
}

export async function listCommand(
  resource: string,
  options: ListOptions
): Promise<void> {
  try {
    const config = await loadConfig();
    const configsDir = config.paths?.configs
      ? resolve(config.paths.configs)
      : config.resolvedStudioDir
        ? resolve(config.resolvedStudioDir)
        : resolve('./configs');

    switch (resource) {
      case 'projects':
        await listProjects(configsDir, options.json);
        break;
      case 'pipelines':
        await listPipelines(configsDir, options.json);
        break;
      case 'agents':
        await listAgents(configsDir, options.json);
        break;
      case 'runs':
        await listRuns(options);
        break;
      default:
        console.error(
          `Unknown resource: ${resource}. Available: projects, pipelines, agents, runs`
        );
        process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

async function listProjects(configsDir: string, json?: boolean): Promise<void> {
  // With the flat .studio/ structure, there is no projects/ layer.
  if (json) {
    console.log(JSON.stringify([configsDir], null, 2));
    return;
  }
  console.log('\nThis workspace uses a flat .studio/ structure (no projects/ layer).');
  console.log('Run `studio list pipelines` to see available pipelines.');
  console.log('');
}

async function listPipelines(configsDir: string, json?: boolean): Promise<void> {
  const pipelinesDir = join(configsDir, 'pipelines');
  const results = await getFileNames(pipelinesDir, '.pipeline.yaml');

  if (json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  if (results.length === 0) {
    console.log(chalk.yellow('No pipelines found'));
    return;
  }

  console.log('\nPipelines:');
  for (const name of results) {
    console.log(`  - ${name}`);
  }
  console.log('');
}

async function listAgents(configsDir: string, json?: boolean): Promise<void> {
  const agentsDir = join(configsDir, 'agents');
  const results = await getFileNames(agentsDir, '.agent.yaml');

  if (json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  if (results.length === 0) {
    console.log(chalk.yellow('No agents found'));
    return;
  }

  console.log('\nAgents:');
  for (const name of results) {
    console.log(`  - ${name}`);
  }
  console.log('');
}

interface RunListEntry {
  date: string;
  pipeline: string;
  run_id: string;
  status: string;
  filename: string;
}

async function listRuns(options: ListOptions): Promise<void> {
  const runsPath = resolve(process.cwd(), RUNS_DIR);
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(runsPath, { withFileTypes: true });
  } catch {
    if (options.json) {
      console.log('[]');
    } else {
      console.log(chalk.yellow(`No runs directory at ${runsPath}. Run a pipeline first.`));
    }
    return;
  }

  const jsonlFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => e.name);

  const runs: RunListEntry[] = [];
  for (const filename of jsonlFiles) {
    const match = filename.match(/^(\d{4}-\d{2}-\d{2}T\d{1,2}h\d{1,2}m)-(.+)-([a-f0-9]{8})\.jsonl$/i);
    if (!match) continue;
    const datePart = match[1];
    const pipeline = match[2];
    const runId = match[3];

    let status = 'running';
    try {
      const content = await readFile(resolve(runsPath, filename), 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);
      const lastLine = lines[lines.length - 1];
      if (lastLine) {
        const record = JSON.parse(lastLine) as Record<string, unknown>;
        if (record.event === 'pipeline_complete' && typeof record.status === 'string') {
          status = record.status;
        }
      }
    } catch {
      // keep default status
    }
    runs.push({
      date: datePart ?? filename,
      pipeline,
      run_id: runId ?? '',
      status,
      filename,
    });
  }

  runs.sort((a, b) => (b.date > a.date ? 1 : -1));
  const limit = options.limit ? parseInt(options.limit, 10) : 10;
  const limited = runs.slice(0, isNaN(limit) ? 10 : limit);

  if (options.json) {
    console.log(JSON.stringify(limited, null, 2));
    return;
  }

  if (limited.length === 0) {
    console.log(chalk.yellow('No runs found'));
    return;
  }

  const statusColor = (s: string) =>
    s === 'success' ? chalk.green(s) : s === 'rejected' || s === 'failed' ? chalk.red(s) : chalk.gray(s);

  console.log('\nRuns:');
  for (const r of limited) {
    console.log(`  ${r.date}  ${r.pipeline}  ${r.run_id}  ${statusColor(r.status)}`);
  }
  console.log('');
}

async function getFileNames(dir: string, suffix: string): Promise<string[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith(suffix))
    .map((f) => f.replace(suffix, ''))
    .sort();
}
