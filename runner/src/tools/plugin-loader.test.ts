import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadProjectTools } from './plugin-loader.js';
import { ToolYamlError } from './errors.js';

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'studio-tool-loader-test-'));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeToolYaml(name: string, content: string): Promise<string> {
  const dir = join(tmpDir, name);
  await mkdir(dir, { recursive: true });
  const toolsDir = join(dir, 'tools');
  await mkdir(toolsDir, { recursive: true });
  await writeFile(join(toolsDir, `${name}.tool.yaml`), content);
  return toolsDir;
}

describe('loadProjectTools — shell template validation', () => {
  it('throws ToolYamlError when template uses undeclared placeholder', async () => {
    const toolsDir = await writeToolYaml('bad-search', `
name: bad_search
version: 1
commands:
  - name: bad_search-search
    description: Search
    parameters:
      query:
        type: string
        required: true
    execute:
      type: shell
      command: 'curl "https://api.example.com?q={{search_query}}"'
`);
    const promise = loadProjectTools(toolsDir, '/tmp');
    await expect(promise).rejects.toThrow(ToolYamlError);
    await expect(promise).rejects.toThrow(
      "template uses {{search_query}} but no such parameter is declared"
    );
  });

  it('loads successfully when all template placeholders are declared', async () => {
    const toolsDir = await writeToolYaml('good-search', `
name: good_search
version: 1
commands:
  - name: good_search-search
    description: Search
    parameters:
      query:
        type: string
        required: true
    execute:
      type: shell
      command: 'curl "https://api.example.com?q={{query}}"'
`);
    await expect(loadProjectTools(toolsDir, '/tmp')).resolves.toHaveLength(1);
  });

  it('does not flag {{else}} as an undeclared placeholder', async () => {
    const toolsDir = await writeToolYaml('conditional-tool', `
name: conditional_tool
version: 1
commands:
  - name: conditional_tool-run
    description: Run with optional flag
    parameters:
      verbose:
        type: boolean
        required: false
    execute:
      type: shell
      command: 'echo {{#if verbose}}--verbose{{else}}--quiet{{/if}}'
`);
    await expect(loadProjectTools(toolsDir, '/tmp')).resolves.toHaveLength(1);
  });

  it('error message includes filename, command name, and declared parameters', async () => {
    const toolsDir = await writeToolYaml('err-msg', `
name: err_msg
version: 1
commands:
  - name: err_msg-run
    description: Run
    parameters:
      query:
        type: string
        required: true
    execute:
      type: shell
      command: 'curl {{typo}}'
`);
    const promise = loadProjectTools(toolsDir, '/tmp');
    await expect(promise).rejects.toThrow(
      "err-msg.tool.yaml › command 'err_msg-run'"
    );
    await expect(promise).rejects.toThrow(
      "Declared parameters: query"
    );
  });

  it('error message shows (none) when command has no parameters declared', async () => {
    const toolsDir = await writeToolYaml('no-params', `
name: no_params
version: 1
commands:
  - name: no_params-run
    description: Run
    parameters: {}
    execute:
      type: shell
      command: 'curl {{typo}}'
`);
    await expect(loadProjectTools(toolsDir, '/tmp')).rejects.toThrow(ToolYamlError);
    await expect(loadProjectTools(toolsDir, '/tmp')).rejects.toThrow(
      "Declared parameters: (none)"
    );
  });
});
