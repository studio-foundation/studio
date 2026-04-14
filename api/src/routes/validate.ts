import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';
import type { FastifyInstance } from 'fastify';
import type { ServerDeps } from '../server.js';
import {
  createRepoManagerTools,
  createShellTools,
  createSearchTools,
  createPatchTools,
  createGitTools,
} from '@studio-foundation/runner';

// Derived at module load from the actual factory functions — single source of truth.
// Using '.' as a dummy repoPath: only `execute` uses the path, `name` is hardcoded.
const BUILTIN_TOOL_ACTIONS: Set<string> = new Set([
  ...createRepoManagerTools('.').map(t => t.name),
  ...createShellTools('.').map(t => t.name),
  ...createSearchTools('.').map(t => t.name),
  ...createPatchTools('.').map(t => t.name),
  ...createGitTools('.').map(t => t.name),
]);

async function listNames(dir: string, suffix: string): Promise<Set<string>> {
  try {
    const entries = await readdir(dir);
    return new Set(
      entries
        .filter(f => f.endsWith(suffix))
        .map(f => f.slice(0, -suffix.length))
    );
  } catch {
    return new Set();
  }
}

/**
 * Read tool plugin YAMLs and return the `name` field from each.
 * Falls back to the filename stem if the YAML cannot be parsed.
 */
async function listToolPluginNames(dir: string): Promise<Set<string>> {
  try {
    const { readFile } = await import('node:fs/promises');
    const entries = await readdir(dir);
    const names = new Set<string>();
    await Promise.all(
      entries
        .filter(f => f.endsWith('.tool.yaml'))
        .map(async (f) => {
          try {
            const raw = await readFile(join(dir, f), 'utf-8');
            const parsed = yaml.load(raw) as Record<string, unknown> | null;
            const name = parsed && typeof parsed.name === 'string'
              ? parsed.name
              : f.slice(0, -'.tool.yaml'.length);
            names.add(name);
          } catch {
            names.add(f.slice(0, -'.tool.yaml'.length));
          }
        })
    );
    return names;
  } catch {
    return new Set();
  }
}

type StageRef = { agents: string[]; contracts: string[] };

function collectStageRefs(stage: Record<string, unknown>): StageRef {
  const agents: string[] = [];
  const contracts: string[] = [];
  if (typeof stage.agent === 'string') agents.push(stage.agent);
  if (typeof stage.contract === 'string') contracts.push(stage.contract);
  // Recurse into group stages
  if (Array.isArray(stage.stages)) {
    for (const s of stage.stages) {
      if (s && typeof s === 'object' && !Array.isArray(s)) {
        const inner = collectStageRefs(s as Record<string, unknown>);
        agents.push(...inner.agents);
        contracts.push(...inner.contracts);
      }
    }
  }
  return { agents, contracts };
}

export async function validateRoutes(
  fastify: FastifyInstance,
  options: { deps: ServerDeps }
): Promise<void> {
  const { configsDir } = options.deps;

  const errorSchema = { type: 'object', properties: { error: { type: 'string' } } };

  fastify.post<{
    Body: { type: string; name?: string; content: string };
  }>('/validate', {
    schema: {
      tags: ['validate'],
      summary: 'Validate a Studio config for structural coherence',
      body: {
        type: 'object',
        required: ['type', 'content'],
        properties: {
          type: {
            type: 'string',
            enum: ['pipeline', 'contract', 'agent', 'tool', 'skill'],
          },
          name: { type: 'string' },
          content: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            valid: { type: 'boolean' },
            errors: { type: 'array', items: { type: 'string' } },
          },
          required: ['valid', 'errors'],
        },
        400: errorSchema,
      },
    },
  }, async (request, reply) => {
    const { type, content } = request.body;
    const errors: string[] = [];

    // Skills are markdown — just check non-empty
    if (type === 'skill') {
      if (!content.trim()) errors.push('Skill content is empty');
      return reply.send({ valid: errors.length === 0, errors });
    }

    // Parse YAML
    let parsed: unknown;
    try {
      parsed = yaml.load(content);
    } catch (e) {
      errors.push(`YAML parse error: ${e instanceof Error ? e.message : String(e)}`);
      return reply.send({ valid: false, errors });
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push('Content must be a YAML object');
      return reply.send({ valid: false, errors });
    }

    const obj = parsed as Record<string, unknown>;

    if (type === 'pipeline') {
      const stages = obj.stages;
      if (!Array.isArray(stages)) {
        errors.push('Pipeline must have a "stages" array');
        return reply.send({ valid: false, errors });
      }

      const [agentNames, contractNames] = await Promise.all([
        listNames(join(configsDir, 'agents'), '.agent.yaml'),
        listNames(join(configsDir, 'contracts'), '.contract.yaml'),
      ]);

      for (const stage of stages) {
        if (!stage || typeof stage !== 'object' || Array.isArray(stage)) continue;
        const { agents: refs_a, contracts: refs_c } = collectStageRefs(
          stage as Record<string, unknown>
        );
        for (const agent of refs_a) {
          if (!agentNames.has(agent)) errors.push(`Agent '${agent}' not found`);
        }
        for (const contract of refs_c) {
          if (!contractNames.has(contract)) errors.push(`Contract '${contract}' not found`);
        }
      }
    }

    if (type === 'agent') {
      const toolsUsed = obj.tools;
      if (Array.isArray(toolsUsed)) {
        const customPlugins = await listToolPluginNames(join(configsDir, 'tools'));
        for (const tool of toolsUsed) {
          if (typeof tool !== 'string') continue;
          // Custom tool actions follow <plugin>-<action> naming (e.g. claude_code-run
          // from claude_code.tool.yaml). Match if any plugin name is a prefix.
          const isCustom = [...customPlugins].some(p => tool === p || tool.startsWith(p + '-'));
          if (!BUILTIN_TOOL_ACTIONS.has(tool) && !isCustom) {
            errors.push(`Tool '${tool}' not found`);
          }
        }
      }
    }

    return reply.send({ valid: errors.length === 0, errors });
  });
}
