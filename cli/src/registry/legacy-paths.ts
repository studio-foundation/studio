/**
 * Where a package installed by a pre-`files` CLI landed, so `remove` and `audit`
 * still find it. Lockfiles written before ADR 0002 record one of the seven old
 * package types and no file list; paths had to be derived from the type.
 */
const LEGACY_DIRS: Record<string, string> = {
  tool: 'tools',
  template: 'projects',
  pipeline: 'pipelines',
  integration: 'integrations',
  agent: 'agents',
  plugin: 'plugins',
  skill: 'skills',
};

const LEGACY_EXTENSIONS: Record<string, string> = {
  tool: '.tool.yaml',
  pipeline: '.pipeline.yaml',
  integration: '.integration.yaml',
  agent: '.agent.yaml',
  skill: '.skill.md',
};

/** Paths relative to `.studio/`. Empty when the type is unknown. */
export function legacyInstallPaths(name: string, type: string): string[] {
  const dir = LEGACY_DIRS[type];
  if (!dir) return [];
  if (type === 'template' || type === 'plugin') return [`${dir}/${name}`];
  return [`${dir}/${name}${LEGACY_EXTENSIONS[type] ?? '.yaml'}`];
}
