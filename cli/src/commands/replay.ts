import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import chalk from 'chalk';
import { ProgressDisplay } from '../output/progress.js';
import type { PipelineDefinition, ToolCall } from '@studio-foundation/contracts';
import { isStageGroup } from '@studio-foundation/contracts';

// ── JSONL file discovery ─────────────────────────────────────────────────────

function normalizeRunId(runId: string): string {
  return runId.replace(/-/g, '');
}

/**
 * Extracts the 8-char run-id suffix from a JSONL filename.
 * Filename format: `<date>-<pipeline>-<shortRunId>.jsonl`
 * The run-id is always the last segment before `.jsonl`.
 */
function extractRunIdFromFilename(filename: string): string {
  const base = filename.replace(/\.jsonl$/, '');
  const lastDash = base.lastIndexOf('-');
  return lastDash >= 0 ? base.slice(lastDash + 1) : base;
}

export function findJsonlFile(runsDir: string, runId: string): string {
  let entries: string[];
  try {
    entries = readdirSync(runsDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    throw new Error(`No runs directory found at ${runsDir}`);
  }

  const needle = normalizeRunId(runId);

  const matching = entries.filter((name) => {
    const fileRunId = extractRunIdFromFilename(name);
    return fileRunId.startsWith(needle);
  });

  if (matching.length === 0) {
    throw new Error(
      `No run log found for run id "${runId}". Use \`studio logs\` to see available runs.`
    );
  }

  if (matching.length > 1) {
    const ids = matching.map((f) => `  - ${extractRunIdFromFilename(f)} (${f})`).join('\n');
    throw new Error(`Multiple runs match "${runId}":\n${ids}\nProvide more characters to disambiguate.`);
  }

  return resolve(runsDir, matching[0]);
}

// ── JSONL → EngineEvents mapping ─────────────────────────────────────────────

export interface MappedEvent {
  handler: string;
  payload: Record<string, unknown>;
}

export function mapJsonlLineToEvent(
  line: Record<string, unknown>
): MappedEvent | null {
  const event = line.event as string;

  switch (event) {
    case 'pipeline_start':
      return {
        handler: 'onPipelineStart',
        payload: {
          pipeline_name: line.pipeline as string,
          run_id: line.run_id as string,
        },
      };

    case 'pipeline_complete':
      return {
        handler: 'onPipelineComplete',
        payload: {
          pipeline_name: line.pipeline_name as string,
          run_id: line.run_id as string,
          status: line.status as string,
          duration_ms: line.duration_ms as number,
          total_tokens: line.total_tokens as number,
          total_tool_calls: line.total_tool_calls as number,
        },
      };

    case 'stage_start':
      return {
        handler: 'onStageStart',
        payload: {
          stage_name: line.stage as string,
          stage_index: line.stage_index as number,
          total_stages: line.total_stages as number,
        },
      };

    case 'stage_complete': {
      const tokens = line.tokens as
        | { prompt: number; completion: number; total: number }
        | undefined;
      return {
        handler: 'onStageComplete',
        payload: {
          stage_name: line.stage as string,
          stage_index: line.stage_index as number,
          total_stages: line.total_stages as number,
          status: line.status as string,
          attempts: line.attempts as number,
          duration_ms: line.duration_ms as number,
          ...(tokens
            ? {
                token_usage: {
                  prompt_tokens: tokens.prompt,
                  completion_tokens: tokens.completion,
                  total_tokens: tokens.total,
                },
              }
            : {}),
          ...(line.tool_calls ? { tool_calls: line.tool_calls } : {}),
          ...(line.output !== undefined ? { output: line.output } : {}),
          ...(line.rejection_reason ? { rejection_reason: line.rejection_reason } : {}),
          ...(line.rejection_details ? { rejection_details: line.rejection_details } : {}),
        },
      };
    }

    case 'stage_retry':
      return {
        handler: 'onTaskRetry',
        payload: {
          stage: line.stage as string,
          attempt: line.attempt as number,
          max_attempts: line.max_attempts as number,
          failures: line.failures as string[],
          ...(line.agent_output_raw ? { agent_output_raw: line.agent_output_raw } : {}),
          ...(line.tool_calls_count !== undefined
            ? { tool_calls_count: line.tool_calls_count }
            : {}),
        },
      };

    case 'group_start':
      return {
        handler: 'onGroupStart',
        payload: {
          group_name: line.group as string,
          max_iterations: line.max_iterations as number,
        },
      };

    case 'group_iteration':
      return {
        handler: 'onGroupIteration',
        payload: {
          group_name: line.group as string,
          iteration: line.iteration as number,
          max_iterations: line.max_iterations as number,
        },
      };

    case 'group_feedback':
      return {
        handler: 'onGroupFeedback',
        payload: {
          group_name: line.group as string,
          iteration: line.iteration as number,
          rejection_reason: line.rejection_reason as string,
          rejection_details: line.rejection_details as string[],
        },
      };

    case 'group_complete':
      return {
        handler: 'onGroupComplete',
        payload: {
          group_name: line.group as string,
          iterations: line.iterations as number,
          status: line.status as string,
        },
      };

    case 'tool_call_start':
      return {
        handler: 'onToolCallStart',
        payload: {
          tool: line.tool as string,
          params: (line.params as Record<string, unknown>) ?? {},
          timestamp: 0,
        },
      };

    case 'tool_call_complete':
      return {
        handler: 'onToolCallComplete',
        payload: {
          tool: line.tool as string,
          result: line.result,
          ...(line.error ? { error: line.error } : {}),
          duration_ms: (line.duration_ms as number) ?? 0,
          timestamp: 0,
        },
      };

    default:
      return null;
  }
}

// ── Resume helpers ───────────────────────────────────────────────────────────

export interface ResumeContext {
  pipelineInput: string | Record<string, unknown>;
  stageOutputs: Map<string, unknown>;
  stageToolResults: Map<string, ToolCall[]>;
  pipelineName?: string;
}

/**
 * Parse a JSONL log string and extract data needed to resume from a stage.
 * Returns input from pipeline_start, and outputs+tool_calls from stage_complete events.
 */
export function parseJsonlForResume(jsonlContent: string): ResumeContext {
  const stageOutputs = new Map<string, unknown>();
  const stageToolResults = new Map<string, ToolCall[]>();
  let pipelineInput: string | Record<string, unknown> = {};
  let pipelineName: string | undefined;

  const lines = jsonlContent.split('\n').filter((l) => l.trim().length > 0);

  for (const raw of lines) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue; // skip corrupt lines
    }

    const event = record.event as string;

    if (event === 'pipeline_start') {
      if (record.input !== undefined) {
        pipelineInput = record.input as string | Record<string, unknown>;
      }
      if (record.pipeline !== undefined) {
        pipelineName = record.pipeline as string;
      }
    }

    if (event === 'stage_complete') {
      const stageName = record.stage as string;
      if (!stageName) continue;

      if (record.output !== undefined) {
        stageOutputs.set(stageName, record.output);
      }

      if (Array.isArray(record.tool_calls) && record.tool_calls.length > 0) {
        stageToolResults.set(stageName, record.tool_calls as ToolCall[]);
      }
    }
  }

  return { pipelineInput, stageOutputs, stageToolResults, pipelineName };
}

/**
 * Resolve a --stage argument (integer index or stage name) to a stage name.
 * Groups are transparent — index counts leaf stages only.
 * Throws with a clear message if not found or out of bounds.
 */
export function resolveStageFromPipeline(
  stageArg: string,
  pipeline: PipelineDefinition
): string {
  // Collect leaf stage names in order (groups are transparent)
  const leafNames: string[] = [];
  for (const entry of pipeline.stages) {
    if (isStageGroup(entry)) {
      for (const s of entry.stages) leafNames.push(s.name);
    } else {
      leafNames.push(entry.name);
    }
  }

  // Try numeric index first (e.g. "0", "3")
  if (/^\d+$/.test(stageArg)) {
    const asNumber = parseInt(stageArg, 10);
    if (asNumber < 0 || asNumber >= leafNames.length) {
      throw new Error(
        `Stage index ${asNumber} is out of bounds. Pipeline has ${leafNames.length} stages (0–${leafNames.length - 1}).`
      );
    }
    return leafNames[asNumber]!;
  }

  // Try name match
  if (leafNames.includes(stageArg)) {
    return stageArg;
  }

  throw new Error(
    `Stage "${stageArg}" not found in pipeline. Available stages: ${leafNames.join(', ')}`
  );
}

// ── Restart command ──────────────────────────────────────────────────────────

interface RestartOptions {
  stage: string;
  verbose?: boolean;
  provider?: string;
}

export async function restartCommand(
  runId: string,
  options: RestartOptions
): Promise<void> {
  try {
    const runsDir = resolve(process.cwd(), '.studio/runs');
    const filePath = findJsonlFile(runsDir, runId);
    const content = readFileSync(filePath, 'utf-8');

    const { pipelineInput, stageOutputs, stageToolResults, pipelineName } = parseJsonlForResume(content);

    if (!pipelineName) {
      throw new Error(`Could not determine pipeline name from run log for run ${runId}`);
    }

    // Load config + dependencies (mirror run.ts pattern exactly)
    const { loadConfig } = await import('../config.js');
    const { PipelineEngine, loadPipelineByName, DirectEngineSpawner, resolveRepoPath } = await import('@studio-foundation/engine');
    const { createDefaultRegistry, ToolRegistry, loadProjectTools, loadPlugins, MCPClient } = await import('@studio-foundation/runner');
    const { createRunStore } = await import('../run-store-factory.js');
    const { createRunLogger } = await import('../run-logger.js');
    const { mergeEvents } = await import('./run.js');
    const yaml = await import('js-yaml');

    const config = await loadConfig();

    let runStore = null;
    try {
      runStore = await createRunStore(config);
    } catch (err) {
      console.warn(chalk.yellow(`⚠ Run store unavailable: ${err instanceof Error ? err.message : String(err)}. Continuing with JSONL logging only.`));
    }

    const configsDir = config.paths?.configs
      ? resolve(config.paths.configs)
      : config.resolvedStudioDir
        ? resolve(config.resolvedStudioDir)
        : resolve('./configs');
    const pipelinesDir = join(configsDir, 'pipelines');

    // Load pipeline to resolve --stage
    const pipelineDef = await loadPipelineByName(pipelineName, pipelinesDir);
    const resolvedStage = resolveStageFromPipeline(options.stage, pipelineDef);

    // Resolve repo path
    let repoPath: string;
    try {
      repoPath = await resolveRepoPath({
        repoPathOverride: undefined,
        repoUrl: pipelineDef.repo?.url,
        rawProjectsDir: config.paths?.projects_dir || process.env.STUDIO_PROJECTS_DIR,
        pipelineName,
        branch: pipelineDef.repo?.branch,
      });
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    const providerRegistry = createDefaultRegistry(
      options.provider === 'mock' ? {} : {
        openai: config.providers?.openai ? { apiKey: config.providers.openai.apiKey } : undefined,
        anthropic: config.providers?.anthropic ? { apiKey: config.providers.anthropic.apiKey } : undefined,
        openaiResponses: config.providers?.openai ? { apiKey: config.providers.openai.apiKey } : undefined,
        ollama: config.providers?.ollama ? { baseUrl: config.providers.ollama.baseUrl } : undefined,
        claudeCode: config.providers?.['claude-code'] !== undefined
          ? { model: config.defaults?.model }
          : undefined,
      }
    );

    if (options.provider === 'mock') {
      const mockYamlPath = join(configsDir, 'mock.yaml');
      let mockRaw: string;
      try {
        mockRaw = readFileSync(mockYamlPath, 'utf-8');
      } catch {
        console.error(`Error: --provider mock requires ${mockYamlPath}`);
        process.exit(1);
      }
      const mockConfig = yaml.default.load(mockRaw) as {
        stages: Record<string, { output: Record<string, unknown>; tool_calls: Array<{ name: string; arguments: Record<string, unknown> }> }>;
      };
      const stagesMap = new Map(Object.entries(mockConfig.stages));
      const { MockProvider } = await import('@studio-foundation/runner');
      const mockProvider = new MockProvider(stagesMap);
      providerRegistry.register(mockProvider);
    } else if (options.provider && !providerRegistry.has(options.provider)) {
      console.error(`Error: Unknown provider "${options.provider}". Available: ${providerRegistry.list().join(', ')}`);
      process.exit(1);
    }

    const toolsDir = resolve(configsDir, 'tools');
    const loadedPlugins = await loadProjectTools(toolsDir, repoPath);
    const toolRegistry = new ToolRegistry();
    for (const plugin of loadedPlugins) {
      toolRegistry.registerPlugin(plugin.name, plugin.tools, plugin.promptSnippet);
    }

    const pluginsDir = resolve(configsDir, 'plugins');
    const pluginManifests = await loadPlugins(pluginsDir);
    const mcpClients: InstanceType<typeof MCPClient>[] = [];
    for (const manifest of pluginManifests) {
      for (const [serverName, serverDef] of Object.entries(manifest.mcpServers)) {
        const client = new MCPClient(manifest.name, serverName, serverDef);
        try {
          await client.start();
          const mcpTools = await client.getTools();
          toolRegistry.registerPlugin(`${manifest.name}-${serverName}`, mcpTools);
          mcpClients.push(client);
        } catch (err) {
          console.warn(chalk.yellow(`⚠ Plugin '${manifest.name}': failed to start MCP server '${serverName}': ${(err as Error).message}`));
        }
      }
    }

    const pluginSkills: Record<string, string[]> = {};
    for (const manifest of pluginManifests) {
      if (manifest.skills.length > 0) {
        pluginSkills[manifest.name] = manifest.skills.map(
          (s: { name: string; content: string }) => `## Skill: ${s.name}\n\n${s.content}`
        );
      }
    }

    console.log(chalk.cyan(`Resuming ${pipelineName} from stage ${chalk.bold(resolvedStage)}`));
    console.log(chalk.gray(`Original run: ${runId}`));
    console.log('');

    const progress = new ProgressDisplay(false, { live: true, verbose: !!options.verbose });
    const runLogger = createRunLogger(process.cwd());
    const events = mergeEvents(progress.getEvents(), runLogger, pipelineName, pipelineInput);

    const engineConfig = {
      configsDir,
      repoPath,
      providerRegistry,
      toolRegistry,
      pluginSkills,
      db: runStore ?? undefined,
      defaultProvider: config.defaults?.provider,
      defaultModel: config.defaults?.model,
      ...(options.provider ? { providerOverride: options.provider } : {}),
    };

    const spawner = new DirectEngineSpawner(engineConfig);
    const engine = new PipelineEngine({ ...engineConfig, spawner, maxDepth: 3 }, events);

    const controller = new AbortController();
    let forceExitOnNextInterrupt = false;

    const onInterrupt = () => {
      if (forceExitOnNextInterrupt) {
        process.exit(130);
      }
      forceExitOnNextInterrupt = true;
      controller.abort();
      progress.interrupt();
      process.stderr.write('\n' + chalk.yellow('⚠ Cancelling run...') + '\n');
    };
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onInterrupt);

    let result;
    try {
      result = await engine.run({
        pipeline: pipelineName,
        input: pipelineInput,
        resumeFromStage: resolvedStage,
        priorStageOutputs: stageOutputs,
        priorStageToolResults: stageToolResults,
        originalRunId: runId,
        signal: controller.signal,
      });
    } finally {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onInterrupt);
      await runLogger.close();
      if (runStore && result) {
        await (runStore as { saveLogPath?: (id: string, path: string) => Promise<void> }).saveLogPath?.(result.id, runLogger.getLogPath());
      }
      await (runStore as { close?: () => Promise<void> } | null)?.close?.();
      await Promise.allSettled(mcpClients.map((c) => c.close()));
    }

    console.log('');
    console.log(chalk.gray(`Run ID: ${progress.runId}`));
    if (result) {
      process.exit(result.status === 'success' ? 0 : 1);
    }
  } catch (error) {
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// ── Replay command ───────────────────────────────────────────────────────────

interface ReplayOptions {
  verbose?: boolean;
}

export async function replayCommand(
  runId: string,
  options: ReplayOptions
): Promise<void> {
  try {
    const runsDir = resolve(process.cwd(), '.studio/runs');
    const filePath = findJsonlFile(runsDir, runId);

    const content = readFileSync(filePath, 'utf-8');
    const lines = content
      .split('\n')
      .filter((l) => l.trim().length > 0);

    const progress = new ProgressDisplay(false, {
      live: true,
      verbose: !!options.verbose,
    });
    const events = progress.getEvents();

    for (const raw of lines) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // Skip corrupt lines
        continue;
      }

      const mapped = mapJsonlLineToEvent(parsed);
      if (!mapped) continue;

      const handler = events[mapped.handler as keyof typeof events];
      if (handler) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (handler as (e: any) => void)(mapped.payload);
      }
    }
  } catch (error) {
    console.error(
      chalk.red('Error:'),
      error instanceof Error ? error.message : error
    );
    process.exit(1);
  }
}
