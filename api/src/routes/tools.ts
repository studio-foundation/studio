import { readdir, readFile, writeFile, unlink, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';
import type { FastifyInstance } from 'fastify';
import type { ServerDeps } from '../server.js';
import {
  BUILTIN_TOOL_NAMES,
  listAvailableToolTemplates,
  getBundledToolTemplate,
} from '@studio-foundation/runner';

function toolPath(configsDir: string, name: string): string {
  return join(configsDir, 'tools', `${name}.tool.yaml`);
}

async function isCustomTool(configsDir: string, name: string): Promise<boolean> {
  try {
    await access(toolPath(configsDir, name));
    return true;
  } catch {
    return false;
  }
}

export async function toolsRoutes(
  fastify: FastifyInstance,
  options: { deps: ServerDeps }
): Promise<void> {
  const { configsDir } = options.deps;
  const errorSchema = { type: 'object', properties: { error: { type: 'string' } } };

  // GET /api/tools — list builtins + custom
  fastify.get('/tools', {
    schema: {
      tags: ['tools'],
      summary: 'List all available tools (builtins + custom)',
      response: {
        200: {
          type: 'object',
          properties: {
            tools: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string' },
                  is_builtin: { type: 'boolean' },
                },
              },
            },
          },
        },
      },
    },
  }, async (_request, reply) => {
    const toolsList: { name: string; description: string; is_builtin: boolean }[] = [];

    // Builtins from bundled templates (skip if overridden by a custom file)
    const available = await listAvailableToolTemplates();
    for (const t of available) {
      const overridden = await isCustomTool(configsDir, t.name);
      if (!overridden) {
        toolsList.push({ name: t.name, description: t.description, is_builtin: true });
      }
    }

    // Custom tools from .studio/tools/
    const toolsDir = join(configsDir, 'tools');
    let entries: string[] = [];
    try {
      entries = await readdir(toolsDir);
    } catch {
      // dir doesn't exist — no custom tools
    }
    for (const file of entries.filter(f => f.endsWith('.tool.yaml'))) {
      const name = file.replace('.tool.yaml', '');
      const content = await readFile(join(toolsDir, file), 'utf-8');
      const def = yaml.load(content) as { description?: string };
      const isBuiltin = BUILTIN_TOOL_NAMES.has(name);
      toolsList.push({ name, description: def.description ?? '', is_builtin: isBuiltin });
    }

    return reply.send({ tools: toolsList });
  });

  // GET /api/tools/:name — read a tool definition
  fastify.get<{ Params: { name: string } }>('/tools/:name', {
    schema: {
      tags: ['tools'],
      summary: 'Get a tool definition by name',
      params: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      response: {
        200: { type: 'object', additionalProperties: true },
        404: errorSchema,
      },
    },
  }, async (request, reply) => {
    const { name } = request.params;

    // Custom tool takes priority
    if (await isCustomTool(configsDir, name)) {
      const content = await readFile(toolPath(configsDir, name), 'utf-8');
      const parsed = yaml.load(content) as Record<string, unknown>;
      return reply.send({ ...parsed, is_builtin: BUILTIN_TOOL_NAMES.has(name) });
    }

    // Fall back to bundled builtin template
    const template = await getBundledToolTemplate(name);
    if (template) {
      const parsed = yaml.load(template) as Record<string, unknown>;
      return reply.send({ ...parsed, is_builtin: true });
    }

    return reply.status(404).send({ error: `Tool '${name}' not found` });
  });

  // PUT /api/tools/:name — create or update a custom tool
  fastify.put<{ Params: { name: string }; Body: unknown }>(
    '/tools/:name',
    {
      schema: {
        tags: ['tools'],
        summary: 'Create or update a custom tool (YAML text or JSON body)',
        params: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        body: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'string' }] },
        response: {
          200: { type: 'object', properties: { name: { type: 'string' } } },
          400: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const { name } = request.params;
      const contentType = request.headers['content-type'] ?? '';

      let yamlContent: string;
      if (contentType.includes('application/json')) {
        yamlContent = yaml.dump(request.body);
      } else {
        yamlContent = request.body as string;
      }

      try {
        yaml.load(yamlContent);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid YAML';
        return reply.status(400).send({ error: message });
      }

      await mkdir(join(configsDir, 'tools'), { recursive: true });
      await writeFile(toolPath(configsDir, name), yamlContent, 'utf-8');
      return reply.send({ name });
    }
  );

  // DELETE /api/tools/:name — delete a custom tool (403 for builtins not overridden)
  fastify.delete<{ Params: { name: string } }>('/tools/:name', {
    schema: {
      tags: ['tools'],
      summary: 'Delete a custom tool',
      params: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      response: {
        200: { type: 'object', properties: { deleted: { type: 'string' } } },
        403: errorSchema,
        404: errorSchema,
      },
    },
  }, async (request, reply) => {
    const { name } = request.params;

    // 403 if builtin with no custom override file
    if (BUILTIN_TOOL_NAMES.has(name) && !(await isCustomTool(configsDir, name))) {
      return reply.status(403).send({ error: `Cannot delete builtin tool '${name}'` });
    }

    try {
      await unlink(toolPath(configsDir, name));
    } catch {
      return reply.status(404).send({ error: `Tool '${name}' not found` });
    }
    return reply.send({ deleted: name });
  });

  // POST /api/tools/install — install from the bundled registry
  fastify.post<{ Body: { name: string } }>('/tools/install', {
    schema: {
      tags: ['tools'],
      summary: 'Install a tool from the bundled registry',
      body: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      response: {
        200: { type: 'object', properties: { installed: { type: 'string' } } },
        404: errorSchema,
        409: errorSchema,
      },
    },
  }, async (request, reply) => {
    const { name } = request.body;

    const template = await getBundledToolTemplate(name);
    if (!template) {
      const available = await listAvailableToolTemplates();
      return reply.status(404).send({
        error: `Tool '${name}' not found in registry. Available: ${available.map(t => t.name).join(', ')}`,
      });
    }

    const destPath = toolPath(configsDir, name);
    const alreadyInstalled = await access(destPath).then(() => true).catch(() => false);
    if (alreadyInstalled) {
      return reply.status(409).send({ error: `Tool '${name}' is already installed` });
    }

    await mkdir(join(configsDir, 'tools'), { recursive: true });
    await writeFile(destPath, template, 'utf-8');
    return reply.send({ installed: name });
  });
}
