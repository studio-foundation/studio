import { access, readFile, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import * as yaml from 'js-yaml';
import { spawnSync } from 'node:child_process';

export interface ValidationResult {
  valid: boolean;
  structuralErrors: string[];
  semanticErrors: string[];
  warnings: string[];
}

interface StageDefinition {
  name: string;
  agent?: string;
  contract?: string;
}

interface PipelineEntry {
  group?: string;
  stages?: StageDefinition[];
  name?: string;
  agent?: string;
  contract?: string;
}

function collectStages(entries: PipelineEntry[]): StageDefinition[] {
  const stages: StageDefinition[] = [];
  for (const entry of entries) {
    if (entry.group && Array.isArray(entry.stages)) {
      stages.push(...entry.stages);
    } else {
      stages.push(entry as StageDefinition);
    }
  }
  return stages;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function listYamlFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((e) => e.endsWith('.yaml') || e.endsWith('.yml'));
  } catch {
    return [];
  }
}

export async function validateTemplateDir(templatePath: string): Promise<ValidationResult> {
  const warnings: string[] = [];

  // ── Level 1: Structural ──────────────────────────────────────────────

  const structuralErrors: string[] = [];

  if (!(await pathExists(templatePath))) {
    return { valid: false, structuralErrors: [`Template directory not found: ${templatePath}`], semanticErrors: [], warnings };
  }

  const metaPath = join(templatePath, 'metadata.json');
  try {
    const raw = await readFile(metaPath, 'utf-8');
    const meta = JSON.parse(raw) as Record<string, unknown>;
    for (const field of ['name', 'version', 'description']) {
      if (!meta[field]) structuralErrors.push(`metadata.json: missing required field '${field}'`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      structuralErrors.push('metadata.json: file not found');
    } else {
      structuralErrors.push(`metadata.json: ${(err as Error).message}`);
    }
  }

  const projectDir = join(templatePath, 'project');
  if (!(await pathExists(projectDir))) {
    structuralErrors.push('project/ directory not found');
    return { valid: false, structuralErrors, semanticErrors: [], warnings };
  }

  const pipelinesDir = join(projectDir, 'pipelines');
  const pipelineFiles = (await listYamlFiles(pipelinesDir)).filter((f) => f.endsWith('.pipeline.yaml'));
  if (pipelineFiles.length < 2) {
    structuralErrors.push(`project/pipelines/: found ${pipelineFiles.length} pipeline(s), need at least 2`);
  }

  const agentsDir = join(projectDir, 'agents');
  const agentFiles = (await listYamlFiles(agentsDir)).filter((f) => f.endsWith('.agent.yaml'));
  if (agentFiles.length < 1) {
    structuralErrors.push('project/agents/: no .agent.yaml files found (need at least 1)');
  }

  const contractsDir = join(projectDir, 'contracts');
  if (!(await pathExists(contractsDir))) {
    structuralErrors.push('project/contracts/ directory not found');
  }

  if (structuralErrors.length > 0) {
    return { valid: false, structuralErrors, semanticErrors: [], warnings };
  }

  // ── Level 2: Semantic ────────────────────────────────────────────────

  const semanticErrors: string[] = [];

  const knownAgents = new Set(agentFiles.map((f) => basename(f, '.agent.yaml')));
  const contractFiles = (await listYamlFiles(contractsDir)).filter((f) => f.endsWith('.contract.yaml'));
  const knownContracts = new Set(contractFiles.map((f) => basename(f, '.contract.yaml')));

  const allYamlDirs: [string, string][] = [
    [pipelinesDir, 'pipelines'],
    [agentsDir, 'agents'],
    [contractsDir, 'contracts'],
    [join(projectDir, 'tools'), 'tools'],
  ];

  const parsedPipelines: Array<{ file: string; parsed: Record<string, unknown> }> = [];

  for (const [dir, label] of allYamlDirs) {
    const files = await listYamlFiles(dir);
    for (const file of files) {
      const filePath = join(dir, file);
      try {
        const content = await readFile(filePath, 'utf-8');
        const parsed = yaml.load(content);
        if (parsed === null || parsed === undefined) {
          semanticErrors.push(`${label}/${file}: YAML file is empty`);
          continue;
        }
        if (typeof parsed !== 'object' || Array.isArray(parsed)) {
          semanticErrors.push(`${label}/${file}: YAML file must be a mapping (object)`);
          continue;
        }
        if (label === 'pipelines') {
          parsedPipelines.push({ file, parsed: parsed as Record<string, unknown> });
        }
      } catch (err) {
        semanticErrors.push(`${label}/${file}: YAML parse error — ${(err as Error).message}`);
      }
    }
  }

  for (const { file, parsed } of parsedPipelines) {
    if (!parsed || !Array.isArray(parsed.stages)) continue;
    const stages = collectStages(parsed.stages as PipelineEntry[]);
    for (const stage of stages) {
      if (stage.contract && !knownContracts.has(stage.contract)) {
        semanticErrors.push(
          `pipelines/${file}: stage '${stage.name ?? '?'}' references contract '${stage.contract}' which does not exist in contracts/`
        );
      }
      if (stage.agent && !knownAgents.has(stage.agent)) {
        semanticErrors.push(
          `pipelines/${file}: stage '${stage.name ?? '?'}' references agent '${stage.agent}' which does not exist in agents/`
        );
      }
    }
  }

  if (semanticErrors.length > 0) {
    return { valid: false, structuralErrors: [], semanticErrors, warnings };
  }

  // ── Level 3: Optional TypeScript compilation ─────────────────────────

  const tsConfigPath = join(templatePath, 'tsconfig.json');
  if (await pathExists(tsConfigPath)) {
    // spawnSync is intentional: this is a CLI command, not a server.
    // Blocking during tsc --noEmit is acceptable for a validation step.
    const result = spawnSync('tsc', ['--noEmit'], { cwd: templatePath, encoding: 'utf-8' });
    if (result.status !== 0) {
      const output = (result.stdout ?? '') + (result.stderr ?? '');
      semanticErrors.push(`TypeScript compilation failed:\n${output.trim()}`);
    }
  }

  const prismaSchema = join(templatePath, 'prisma', 'schema.prisma');
  if (await pathExists(prismaSchema)) {
    warnings.push('prisma/schema.prisma found (migration testing not automated — run prisma validate manually)');
  }

  return { valid: semanticErrors.length === 0, structuralErrors: [], semanticErrors, warnings };
}
