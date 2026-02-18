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
        ? resolve(config.resolvedStudioDir, 'projects')
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
  const projects = await getProjects(configsDir);

  if (json) {
    console.log(JSON.stringify(projects, null, 2));
    return;
  }

  if (projects.length === 0) {
    console.log(chalk.yellow(`No projects found in ${configsDir}`));
    return;
  }

  console.log('\nProjects:');
  for (const name of projects) {
    console.log(`  - ${name}`);
  }
  console.log('');
}

async function listPipelines(configsDir: string, json?: boolean): Promise<void> {
  const projects = await getProjects(configsDir);
  const results: string[] = [];

  for (const project of projects) {
    const pipelinesDir = join(configsDir, project, 'pipelines');
    const names = await getFileNames(pipelinesDir, '.pipeline.yaml');
    for (const name of names) {
      results.push(`${project}/${name}`);
    }
  }

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
  const projects = await getProjects(configsDir);
  const results: string[] = [];

  for (const project of projects) {
    const agentsDir = join(configsDir, project, 'agents');
    const names = await getFileNames(agentsDir, '.agent.yaml');
    for (const name of names) {
      results.push(`${project}/${name}`);
    }
  }

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
  project: string;
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
    const middle = match[2];
    const runId = match[3];
    const lastHyphen = middle.lastIndexOf('-');
    if (lastHyphen <= 0) continue;
    const project = middle.slice(0, lastHyphen);
    const pipeline = middle.slice(lastHyphen + 1);
    if (options.project && project !== options.project) continue;

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
      project,
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

  console.log('\nRuns:');
  for (const r of limited) {
    const statusColor =
      r.status === 'success' ? chalk.green : r.status === 'rejected' || r.status === 'failed' ? chalk.red : chalk.gray;
    console.log(`  ${r.date}  ${r.project}/${r.pipeline}  ${r.run_id}  ${statusColor(r.status)}`);
  }
  console.log('');
}

async function getProjects(configsDir: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(configsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
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
