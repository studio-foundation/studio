import type { RunSpawner } from '@studio/contracts';
import type { Tool, ToolResult } from '../tool-registry.js';

interface StudioRunContext {
  spawner: RunSpawner;
  currentRunId: string;
  currentDepth: number;
  maxDepth: number;
}

export const STUDIO_RUN_PROMPT_SNIPPET = `
## studio_run tool

Use \`studio_run-run_pipeline\` to launch a Studio pipeline run and wait for its result.
The run executes asynchronously but this tool blocks until completion.
Use it to orchestrate sub-pipelines (e.g. generate N items by launching N runs).
`.trim();

export function createStudioRunTool(ctx: StudioRunContext): Tool[] {
  return [
    {
      name: 'studio_run-run_pipeline',
      description: 'Launch a Studio pipeline run and wait for completion. Returns the output of the last stage.',
      parameters: {
        type: 'object',
        properties: {
          pipeline: {
            type: 'string',
            description: 'Name of the pipeline to run (e.g. "recipe-developer")',
          },
          input: {
            type: 'object',
            description: 'Input data for the pipeline',
          },
          wait: {
            type: 'boolean',
            description: 'Whether to wait for completion before returning (default: true)',
            default: true,
          },
        },
        required: ['pipeline', 'input'],
      },
      async execute(args) {
        const pipeline = args['pipeline'] as string;
        const input = args['input'] as Record<string, unknown>;
        const wait = args['wait'] !== false;

        if (!wait) {
          throw new Error('wait: false is not supported in v1. Use wait: true (default).');
        }

        if (ctx.currentDepth + 1 > ctx.maxDepth) {
          throw new Error(
            `studio-run depth limit reached (max: ${ctx.maxDepth}). ` +
            `Current depth: ${ctx.currentDepth}. Recursive pipeline spawning is not allowed at this level.`
          );
        }

        const result = await ctx.spawner.spawnAndWait({
          pipeline,
          input,
          parentRunId: ctx.currentRunId,
          depth: ctx.currentDepth + 1,
        });

        return result as unknown as ToolResult;
      },
    },
  ];
}
