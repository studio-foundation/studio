import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { findJsonlFile, parseJsonlForResume } from './replay.js';

interface RunsShowOptions {
  stage?: string;
  json?: boolean;
}

export async function runsShowCommand(runId: string, options: RunsShowOptions): Promise<void> {
  try {
    if (!options.stage) throw new Error('--stage <name> is required');
    const file = findJsonlFile(resolve(process.cwd(), '.studio/runs'), runId);
    const { stageOutputs } = parseJsonlForResume(readFileSync(file, 'utf-8'));
    if (!stageOutputs.has(options.stage)) {
      throw new Error(`No output recorded for stage "${options.stage}" in run ${runId}`);
    }
    const output = stageOutputs.get(options.stage);
    process.stdout.write(
      (options.json || typeof output !== 'string' ? JSON.stringify(output, null, 2) : output) + '\n',
    );
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
