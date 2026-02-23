import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { ProgressDisplay } from '../output/progress.js';

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
