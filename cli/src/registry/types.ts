export type PackageType =
  | 'tool'
  | 'template'
  | 'pipeline'
  | 'integration'
  | 'agent'
  | 'plugin'
  | 'skill';

/**
 * Where a package's payload lives. `path` is the package directory in the
 * marketplace repo; `file` is the payload filename for single-file types.
 * Neither is derived from `name` — the two are allowed to diverge.
 */
export interface PackageSource {
  type: 'local';
  path: string;
  file?: string;
}

export interface PackageEntry {
  name: string;
  type: PackageType;
  version: string;
  description: string;
  author: string;
  license: string;
  tags: string[];
  studio_version: string | null;
  downloads: number;
  source: PackageSource;
}

export interface RegistryIndex {
  generated_at: string;
  version: string;
  packages: PackageEntry[];
}

/**
 * Every category resolves identically — by name, through the same index. `plugins`
 * is the form ADR 0002 settles on; the others are the pre-migration spelling and
 * keep working. Entries are `[marketplace:]name[@range]`.
 */
export interface PackageDependencies {
  plugins?:   { required?: string[]; recommended?: string[] };
  tools?:     { required?: string[]; recommended?: string[] };
  agents?:    { required?: string[]; recommended?: string[] };
  skills?:    { required?: string[]; recommended?: string[] };
  templates?: { required?: string[]; recommended?: string[] };
  pipelines?: { required?: string[]; recommended?: string[] };
}

export interface PackageMetadata extends Omit<PackageEntry, 'source'> {
  requires_binaries?: string[];
  dependencies?: PackageDependencies;
}

export interface LockfileEntry {
  version: string;
  type: PackageType;
  installed_at: string;
  sha256: string;
  required_by?: string[];
}

export interface Lockfile {
  installed: Record<string, LockfileEntry>;
}

/** Where packages get installed relative to the project's .studio/ dir */
export const INSTALL_DIRS: Record<PackageType, string> = {
  tool: 'tools',
  template: 'projects',
  pipeline: 'pipelines',
  integration: 'integrations',
  agent: 'agents',
  plugin: 'plugins',
  skill: 'skills',
};

export const REGISTRY_REPO = 'studio-foundation/studio-community';
export const REGISTRY_RAW_BASE = `https://raw.githubusercontent.com/${REGISTRY_REPO}/main`;
export const REGISTRY_API_BASE = `https://api.github.com/repos/${REGISTRY_REPO}`;
