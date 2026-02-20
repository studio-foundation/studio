import { execSync } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import yaml from 'js-yaml';
import chalk from 'chalk';
import type { EngineEvents } from '@studio/engine';
import { PipelineEngine, parseProjectPipeline, loadPipelineByName } from '@studio/engine';
import { createDefaultRegistry, ToolRegistry, loadProjectTools } from '@studio/runner';
import { loadConfig } from '../config.js';
import { ProgressDisplay } from '../output/progress.js';
import { formatResult } from '../output/formatter.js';
import { createRunLogger } from '../run-logger.js';
import { validateInputSchema, collectStructuredInput } from '../utils/input-wizard.js';

interface RunOptions {
  input?: string;
  inputFile?: string;
  repo?: string;
  repoUrl?: string;
  config?: string;
  json?: boolean;
  verbose?: boolean;
  live?: boolean;
  provider?: string;
  anonymize?: boolean;
}

async function cloneRepo(
  repoUrl: string,
  projectsDir: string,
  pipelineName: string,
  branch?: string
): Promise<string> {
  await mkdir(projectsDir, { recursive: true });

  const timestamp = new Date().toISOString()
    .replace(/:/g, 'h')
    .replace(/\..+$/, '')
    .replace('T', 'T');
  const dirName = `${pipelineName}-${timestamp}`;
  const clonePath = join(projectsDir, dirName);

  const branchArg = branch ? `--branch ${branch}` : '';
  const cmd = `git clone --depth 1 ${branchArg} ${repoUrl} ${clonePath}`;

  try {
    execSync(cmd, { stdio: 'pipe' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to clone ${repoUrl}: ${msg}`);
  }

  return clonePath;
}

function inputSummary(input: string | Record<string, unknown>): string {
  const s = typeof input === 'string' ? input : JSON.stringify(input);
  return s.length > 200 ? s.slice(0, 200) + '...' : s;
}

function mergeEvents(
  progressEvents: EngineEvents,
  logger: ReturnType<typeof createRunLogger>,
  project: string,
  pipeline: string,
  input: string | Record<string, unknown>
): EngineEvents {
  let totalStages = 0;
  return {
    onPipelineStart: (e) => {
      logger.start(e.run_id, pipeline, project);
      progressEvents.onPipelineStart?.(e);
      logger.log({
        event: 'pipeline_start',
        run_id: e.run_id,
        project,
        pipeline,
        input_summary: inputSummary(input),
      });
    },
    onPipelineComplete: (e) => {
      progressEvents.onPipelineComplete?.(e);
      logger.log({
        event: 'pipeline_complete',
        run_id: e.run_id,
        status: e.status,
        duration_ms: e.duration_ms,
        total_tokens: e.total_tokens,
        total_tool_calls: e.total_tool_calls,
        total_stages: totalStages,
      });
    },
    onStageStart: (e) => {
      totalStages = e.total_stages;
      progressEvents.onStageStart?.(e);
      logger.log({
        event: 'stage_start',
        run_id: undefined,
        stage: e.stage_name,
        stage_index: e.stage_index,
        total_stages: e.total_stages,
      });
    },
    onStageComplete: (e) => {
      progressEvents.onStageComplete?.(e);
      const output = e.output;
      const output_fields =
        output && typeof output === 'object' && !Array.isArray(output)
          ? Object.keys(output as Record<string, unknown>)
          : undefined;
      const output_summary =
        output !== undefined
          ? (typeof output === 'string' ? output : JSON.stringify(output)).slice(0, 200)
          : undefined;
      logger.log({
        event: 'stage_complete',
        run_id: undefined,
        stage: e.stage_name,
        status: e.status,
        attempts: e.attempts,
        duration_ms: e.duration_ms,
        tokens: e.token_usage
          ? {
              prompt: e.token_usage.prompt_tokens,
              completion: e.token_usage.completion_tokens,
              total: e.token_usage.total_tokens,
            }
          : undefined,
        tool_calls: e.tool_calls?.length ?? 0,
        output_fields,
        ...(output_summary ? { output_summary } : {}),
        ...(e.rejection_reason ? { rejection_reason: e.rejection_reason } : {}),
        ...(e.rejection_details?.length ? { rejection_details: e.rejection_details } : {}),
      });
    },
    onTaskRetry: (e) => {
      progressEvents.onTaskRetry?.(e);
      logger.log({
        event: 'stage_retry',
        run_id: undefined,
        stage: e.stage,
        attempt: e.attempt,
        max_attempts: 5,
        failure_reason: e.failures?.length ? e.failures[0] : undefined,
      });
    },
    onGroupStart: (e) => {
      progressEvents.onGroupStart?.(e);
      logger.log({
        event: 'group_start',
        run_id: undefined,
        group: e.group_name,
        max_iterations: e.max_iterations,
      });
    },
    onGroupIteration: (e) => {
      progressEvents.onGroupIteration?.(e);
      logger.log({
        event: 'group_iteration',
        run_id: undefined,
        group: e.group_name,
        iteration: e.iteration,
        max_iterations: e.max_iterations,
      });
    },
    onGroupFeedback: (e) => {
      progressEvents.onGroupFeedback?.(e);
      logger.log({
        event: 'group_feedback',
        run_id: undefined,
        group: e.group_name,
        iteration: e.iteration,
        rejection_reason: e.rejection_reason,
        rejection_details: e.rejection_details,
      });
    },
    onGroupComplete: (e) => {
      progressEvents.onGroupComplete?.(e);
      logger.log({
        event: 'group_complete',
        run_id: undefined,
        group: e.group_name,
        iterations: e.iterations,
        status: e.status,
      });
    },
    onToolCallStart: (e) => progressEvents.onToolCallStart?.(e),
    onToolCallComplete: (e) => progressEvents.onToolCallComplete?.(e),
    onAgentThinking: (e) => progressEvents.onAgentThinking?.(e),
    onAgentProgress: (e) => progressEvents.onAgentProgress?.(e),
  };
}

export async function runCommand(pipelineName: string, options: RunOptions): Promise<void> {
  try {
    const config = await loadConfig(options.config);

    // Resolve configs dir and parse project/pipeline
    const configsDir = config.paths?.configs
      ? resolve(config.paths.configs)
      : config.resolvedStudioDir
        ? resolve(config.resolvedStudioDir, 'projects')
        : resolve('./configs');
    const { project, pipeline: pipelineBase } = parseProjectPipeline(pipelineName);
    const pipelinesDir = join(configsDir, project, 'pipelines');

    // Load pipeline early (needed for input_schema and repo URL)
    const pipelineDef = await loadPipelineByName(pipelineBase, pipelinesDir);

    // Resolve input: --input-file > --input > wizard > error
    let input: string | Record<string, unknown>;

    if (options.inputFile) {
      const inputPath = resolve(options.inputFile);
      let raw: string;
      try {
        raw = await readFile(inputPath, 'utf-8');
      } catch {
        console.error(`Error: Input file not found: ${inputPath}`);
        process.exit(1);
      }
      const parsed = yaml.load(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        input = parsed as Record<string, unknown>;
      } else {
        console.error('Error: Input file must contain a YAML object (key-value pairs)');
        process.exit(1);
      }
    } else if (options.input) {
      input = options.input;
    } else if (pipelineDef.input_schema?.type === 'structured') {
      try {
        const schema = validateInputSchema(pipelineDef.input_schema);
        input = await collectStructuredInput(schema);
      } catch (err) {
        console.error(`Error: Invalid input_schema in pipeline: ${(err as Error).message}`);
        process.exit(1);
      }
    } else {
      console.error('Error: --input or --input-file is required');
      process.exit(1);
    }

    // Resolve repo path: --repo > --repo-url > pipeline.repo.url > CWD
    let repoPath: string;

    if (options.repo) {
      repoPath = resolve(options.repo);
    } else {
      const repoUrl = options.repoUrl || pipelineDef.repo?.url;
      const effectiveBranch = pipelineDef.repo?.branch;

      if (repoUrl) {
        const projectsDir = config.paths?.projects_dir || process.env.STUDIO_PROJECTS_DIR;
        if (!projectsDir) {
          console.error('Error: STUDIO_PROJECTS_DIR is not set. Set it in .env or .studiorc.yaml paths.projects_dir');
          process.exit(1);
        }

        console.log(`Cloning ${repoUrl}...`);
        repoPath = await cloneRepo(repoUrl, projectsDir, pipelineName, effectiveBranch);
        console.log(`Cloned to: ${repoPath}\n`);
      } else {
        repoPath = '.';
      }
    }

    const providerRegistry = createDefaultRegistry(
      options.provider === 'mock' ? {} : {
        openai: config.providers?.openai ? { apiKey: config.providers.openai.apiKey } : undefined,
        anthropic: config.providers?.anthropic ? { apiKey: config.providers.anthropic.apiKey } : undefined,
        openaiResponses: config.providers?.openai ? { apiKey: config.providers.openai.apiKey } : undefined,
      }
    );

    // Handle --provider override
    if (options.provider === 'mock') {
      const mockYamlPath = join(configsDir, project, 'mock.yaml');
      let mockRaw: string;
      try {
        mockRaw = await readFile(mockYamlPath, 'utf-8');
      } catch {
        console.error(`Error: --provider mock requires ${mockYamlPath}`);
        process.exit(1);
      }

      const mockConfig = yaml.load(mockRaw) as {
        stages: Record<string, {
          output: Record<string, unknown>;
          tool_calls: Array<{ name: string; arguments: Record<string, unknown> }>;
        }>;
      };
      const stagesMap = new Map(Object.entries(mockConfig.stages));
      const { MockProvider } = await import('@studio/runner');
      const mockProvider = new MockProvider(stagesMap);
      providerRegistry.register(mockProvider);
    } else if (options.provider && !providerRegistry.has(options.provider)) {
      console.error(`Error: Unknown provider "${options.provider}". Available: ${providerRegistry.list().join(', ')}`);
      process.exit(1);
    }

    const toolsDir = resolve(configsDir, project, 'tools');
    const loadedPlugins = await loadProjectTools(toolsDir, repoPath);
    const toolRegistry = new ToolRegistry();
    for (const plugin of loadedPlugins) {
      toolRegistry.registerPlugin(plugin.name, plugin.tools, plugin.promptSnippet);
    }

    if (options.live && options.verbose) {
      console.warn(chalk.yellow('⚠ Warning: --live includes all --verbose output. Ignoring --verbose.\n'));
    }

    const displayMode = options.live ? 'live' : options.verbose ? 'verbose' : 'quiet';
    const progress = new ProgressDisplay(!!options.json, displayMode);
    const runLogger = createRunLogger(process.cwd());
    const events = mergeEvents(
      progress.getEvents(),
      runLogger,
      project,
      pipelineBase,
      input
    );

    const engine = new PipelineEngine(
      {
        configsDir,
        repoPath,
        providerRegistry,
        toolRegistry,
        ...(options.provider ? { providerOverride: options.provider } : {}),
      },
      events
    );

    let result;
    try {
      result = await engine.run({
        pipeline: pipelineName,
        input,
        anonymize: options.anonymize,
      });
    } finally {
      runLogger.close();
    }

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      formatResult(result);
    }

    process.exit(result.status === 'success' ? 0 : 1);
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
