import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import yaml from 'js-yaml';
import chalk from 'chalk';
import type { EngineEvents } from '@studio-foundation/engine';
import { PipelineEngine, loadPipelineByName, DirectEngineSpawner } from '@studio-foundation/engine';
import { createDefaultRegistry, ToolRegistry, loadProjectTools, loadPlugins, MCPClient } from '@studio-foundation/runner';
import { resolveRepoPath } from '@studio-foundation/engine';
import { loadConfig } from '../config.js';
import { ProgressDisplay } from '../output/progress.js';
import { createRunLogger } from '../run-logger.js';
import { FileChangeCollector, formatFileChanges } from '../output/file-changes.js';
import { formatResult } from '../output/formatter.js';
import { validateInputSchema, collectStructuredInput } from '../utils/input-wizard.js';
import { createRunStore } from '../run-store-factory.js';
import type { AnyRunStore } from '@studio-foundation/engine';

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

export function mergeEvents(
  progressEvents: EngineEvents,
  logger: ReturnType<typeof createRunLogger>,
  pipeline: string,
  input: string | Record<string, unknown>
): EngineEvents {
  let totalStages = 0;
  return {
    onPipelineStart: (e) => {
      logger.start(e.run_id, pipeline);
      progressEvents.onPipelineStart?.(e);
      logger.log({
        event: 'pipeline_start',
        run_id: e.run_id,
        pipeline,
        input,
      });
    },
    onPipelineComplete: (e) => {
      progressEvents.onPipelineComplete?.(e);
      logger.log({
        event: 'pipeline_complete',
        run_id: e.run_id,
        pipeline_name: e.pipeline_name,
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
        stage: e.stage_name,
        stage_index: e.stage_index,
        total_stages: e.total_stages,
        max_attempts: e.max_attempts,
      });
    },
    onStageContext: (e) => {
      logger.log({
        event: 'stage_context',
        stage: e.stage,
        run_id: e.run_id,
        context_keys: e.context_keys,
        ...(e.context_content !== undefined ? { context_content: e.context_content } : {}),
        ...(e.system_prompt !== undefined ? { system_prompt: e.system_prompt } : {}),
      });
    },
    onStageComplete: (e) => {
      progressEvents.onStageComplete?.(e);
      logger.log({
        event: 'stage_complete',
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
        tool_calls: e.tool_calls,
        output: e.output,
        ...(e.rejection_reason ? { rejection_reason: e.rejection_reason } : {}),
        ...(e.rejection_details?.length ? { rejection_details: e.rejection_details } : {}),
        ...(e.skipped_reason ? { skipped_reason: e.skipped_reason } : {}),
      });
    },
    onTaskRetry: (e) => {
      progressEvents.onTaskRetry?.(e);
      logger.log({
        event: 'stage_retry',
        stage: e.stage,
        attempt: e.attempt,
        max_attempts: e.max_attempts,
        failures: e.failures,
        ...(e.agent_output_raw ? { agent_output_raw: e.agent_output_raw } : {}),
        ...(e.tool_calls_count !== undefined ? { tool_calls_count: e.tool_calls_count } : {}),
      });
    },
    onGroupStart: (e) => {
      progressEvents.onGroupStart?.(e);
      logger.log({
        event: 'group_start',
        group: e.group_name,
        max_iterations: e.max_iterations,
      });
    },
    onGroupIteration: (e) => {
      progressEvents.onGroupIteration?.(e);
      logger.log({
        event: 'group_iteration',
        group: e.group_name,
        iteration: e.iteration,
        max_iterations: e.max_iterations,
      });
    },
    onGroupFeedback: (e) => {
      progressEvents.onGroupFeedback?.(e);
      logger.log({
        event: 'group_feedback',
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
        group: e.group_name,
        iterations: e.iterations,
        status: e.status,
      });
    },
    onMapStart: (e) => {
      progressEvents.onMapStart?.(e);
      logger.log({
        event: 'map_start',
        map: e.map_name,
        total_items: e.total_items,
        concurrency: e.concurrency,
      });
    },
    onMapItemStart: (e) => {
      progressEvents.onMapItemStart?.(e);
      logger.log({
        event: 'map_item_start',
        map: e.map_name,
        index: e.index,
        total_items: e.total_items,
        label: e.label,
      });
    },
    onMapItemComplete: (e) => {
      progressEvents.onMapItemComplete?.(e);
      logger.log({
        event: 'map_item_complete',
        map: e.map_name,
        index: e.index,
        total_items: e.total_items,
        status: e.status,
        ...(e.label !== undefined ? { label: e.label } : {}),
        ...(e.run_id ? { run_id: e.run_id } : {}),
        ...(e.error ? { error: e.error } : {}),
      });
    },
    onMapComplete: (e) => {
      progressEvents.onMapComplete?.(e);
      logger.log({
        event: 'map_complete',
        map: e.map_name,
        total: e.total,
        succeeded: e.succeeded,
        failed: e.failed,
        status: e.status,
      });
    },
    onPipelineCancelled: (e) => {
      logger.log({
        event: 'pipeline_cancelled',
        run_id: e.run_id,
        cancelled_at_stage: e.cancelled_at_stage,
        duration_ms: e.duration_ms,
      });
    },
    onToolCallStart: (e) => {
      progressEvents.onToolCallStart?.(e);
      logger.log({
        event: 'tool_call_start',
        tool: e.tool,
        params: e.params,
      });
    },
    onToolCallComplete: (e) => {
      progressEvents.onToolCallComplete?.(e);
      logger.log({
        event: 'tool_call_complete',
        tool: e.tool,
        result: e.result,
        ...(e.error ? { error: e.error } : {}),
        duration_ms: e.duration_ms,
      });
    },
    onAgentThinking: (e) => progressEvents.onAgentThinking?.(e),
    onAgentProgress: (e) => progressEvents.onAgentProgress?.(e),
  };
}

export async function runCommand(pipelineName: string, options: RunOptions): Promise<void> {
  try {
    const config = await loadConfig(options.config);

    // Create run store — fail-silent so a broken SQLite never blocks a run
    let runStore: AnyRunStore | null = null;
    try {
      runStore = await createRunStore(config);
    } catch (err) {
      console.warn(chalk.yellow(`⚠ Run store unavailable: ${err instanceof Error ? err.message : String(err)}. Continuing with JSONL logging only.`));
    }

    // Resolve configs dir and parse project/pipeline
    const configsDir = config.paths?.configs
      ? resolve(config.paths.configs)
      : config.resolvedStudioDir
        ? resolve(config.resolvedStudioDir)
        : resolve('./configs');
    const pipelinesDir = join(configsDir, 'pipelines');

    // Load pipeline early (needed for input_schema and repo URL)
    const pipelineDef = await loadPipelineByName(pipelineName, pipelinesDir);

    // Resolve input: --input-file > --input > wizard > error
    let input: string | Record<string, unknown>;
    let inputFileRepoUrl: string | undefined;

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
        const parsedObj = parsed as Record<string, unknown>;
        inputFileRepoUrl = typeof parsedObj['repo_url'] === 'string' ? parsedObj['repo_url'] : undefined;
        delete parsedObj['repo_url'];
        input = parsedObj;
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

    if (!options.json) {
      console.log(chalk.green('\n✓ Input collected\n'));
    }

    // Resolve repo path: --repo > --repo-url > pipeline.repo.url > CWD
    const effectiveRepoUrl = options.repo
      ? undefined
      : (options.repoUrl || inputFileRepoUrl || pipelineDef.repo?.url);
    const effectiveBranch = pipelineDef.repo?.branch;

    if (effectiveRepoUrl && !options.json) {
      console.log(`Cloning ${effectiveRepoUrl}...`);
    }

    let repoPath: string;
    try {
      repoPath = await resolveRepoPath({
        repoPathOverride: options.repo,
        repoUrl: effectiveRepoUrl,
        rawProjectsDir: config.paths?.projects_dir || process.env.STUDIO_PROJECTS_DIR,
        pipelineName,
        branch: effectiveBranch,
      });
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    if (effectiveRepoUrl && !options.json) {
      console.log(`Cloned to: ${repoPath}\n`);
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

    // Handle --provider override
    if (options.provider === 'mock') {
      const mockYamlPath = join(configsDir, 'mock.yaml');
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

    // Load plugins from .studio/plugins/ and start MCP servers
    const pluginsDir = resolve(configsDir, 'plugins');
    const pluginManifests = await loadPlugins(pluginsDir);
    const mcpClients: MCPClient[] = [];
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

    // Build skill map for engine skill injection
    const pluginSkills: Record<string, string[]> = {};
    for (const manifest of pluginManifests) {
      if (manifest.skills.length > 0) {
        pluginSkills[manifest.name] = manifest.skills.map(
          (s) => `## Skill: ${s.name}\n\n${s.content}`
        );
      }
    }

    const progress = new ProgressDisplay(!!options.json, {
      live: !!options.live,
      verbose: !!options.verbose,
    });
    const runLogger = createRunLogger(process.cwd());
    const fileCollector = new FileChangeCollector();
    const baseEvents = mergeEvents(
      progress.getEvents(),
      runLogger,
      pipelineName,
      input
    );
    const events: EngineEvents = {
      ...baseEvents,
      onToolCallComplete: (e) => {
        fileCollector.onToolCallComplete(e);
        baseEvents.onToolCallComplete?.(e);
      },
    };

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

    const engine = new PipelineEngine(
      {
        ...engineConfig,
        spawner,
        maxDepth: 3,
      },
      events
    );

    const controller = new AbortController();
    let forceExitOnNextInterrupt = false;

    const onInterrupt = () => {
      if (forceExitOnNextInterrupt) {
        // Second Ctrl-C: force exit
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
        input,
        anonymize: options.anonymize,
        signal: controller.signal,
      });
    } finally {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onInterrupt);
      await runLogger.close();
      if (runStore && result) {
        await runStore.saveLogPath(result.id, runLogger.getLogPath());
      }
      await runStore?.close?.();
      // Stop all MCP servers (even if pipeline failed)
      await Promise.allSettled(mcpClients.map((c) => c.close()));
    }

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (result.status === 'cancelled') {
        const lastStage = result.stages[result.stages.length - 1];
        const stageName = lastStage?.stage_name ?? 'unknown';
        const stageIdx = result.stages.length;
        console.error(chalk.red(`✗ Run cancelled at stage [${stageIdx}] ${stageName}`));
      } else {
        formatResult(result);
        const changes = fileCollector.computeSummary(repoPath);
        if (changes) {
          console.log(formatFileChanges(changes));
        }
      }
      console.log('');
      console.log(chalk.gray(`Run ID: ${progress.runId}`));
      console.log(chalk.gray(`View details: studio status ${progress.runId}`));
    }

    const exitCode = result.status === 'cancelled' ? 130 : result.status === 'success' ? 0 : 1;
    await exitAfterFlush(exitCode);
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

/**
 * Exit once stdout and stderr have drained to the OS.
 *
 * Writing to a pipe is asynchronous: Node buffers the write and flushes on a
 * later tick, so `process.exit()` immediately after `console.log` terminates
 * before the flush and cuts stdout at the pipe buffer (~8 KiB). A large
 * `--json` payload then never reaches the caller — the exact-8192-byte
 * truncation of STU-594/STU-533. A zero-length trailing write's callback fires
 * after every queued chunk has been handed to the OS (writes drain FIFO), so it
 * is a reliable "flushed" signal; a TTY drains synchronously and calls back at
 * once.
 */
function exitAfterFlush(code: number): Promise<never> {
  const drain = (stream: NodeJS.WriteStream): Promise<void> =>
    new Promise((res) => stream.write('', () => res()));
  return Promise.all([drain(process.stdout), drain(process.stderr)]).then(() =>
    process.exit(code)
  );
}
