export type PackageType =
  | 'tool'
  | 'template'
  | 'pipeline'
  | 'integration'
  | 'agent'
  | 'plugin'
  | 'skill';

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
}

export interface RegistryIndex {
  generated_at: string;
  version: string;
  packages: PackageEntry[];
}

export interface PackageDependencies {
  tools?:     { required?: string[]; recommended?: string[] };
  agents?:    { required?: string[]; recommended?: string[] };
  skills?:    { required?: string[]; recommended?: string[] };
  templates?: { required?: string[]; recommended?: string[] };
  pipelines?: { required?: string[]; recommended?: string[] };
}

export interface PackageMetadata extends PackageEntry {
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

export const REGISTRY_REPO = 'PipStudio/studio-community';
export const REGISTRY_RAW_BASE = `https://raw.githubusercontent.com/${REGISTRY_REPO}/main`;
export const REGISTRY_API_BASE = `https://api.github.com/repos/${REGISTRY_REPO}`;
