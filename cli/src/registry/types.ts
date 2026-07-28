/**
 * Two packaging types, each defined by its install verb (ADR 0002). What used to
 * be a type — tool, agent, skill… — is a content kind carried inside a plugin.
 */
export type PackageType = 'template' | 'plugin';

/** What a plugin delivers into `.studio/`. */
export type ContentKind = 'tool' | 'agent' | 'skill' | 'trigger' | 'pipeline' | 'contract' | 'input';

/** A plugin's declared contents, by kind. Search reads it; install verifies nothing against it. */
export type PackageProvides = Partial<Record<`${ContentKind}s`, string[]>>;

/**
 * Where a package's payload lives: `path` is the package directory in the
 * marketplace repo, never derived from `name` — the two may diverge. Payload
 * filenames are discovered by listing that directory.
 */
export interface LocalSource {
  type: 'local';
  path: string;
}

/**
 * A payload hosted outside the marketplace repo (ADR 0001). `sha` is the commit
 * actually installed; `ref` is what it is checked against, so an upstream push
 * that moves the tag fails the install instead of silently changing the payload.
 */
export interface GitSource {
  type: 'git';
  url: string;
  /** Package directory inside the repo. Absent means the repository root. */
  path?: string;
  ref: string;
  sha: string;
}

export type PackageSource = LocalSource | GitSource;

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
  provides?: PackageProvides;
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
  /** `template` or `plugin`, or one of the pre-migration types on an older lockfile. */
  type: string;
  /** Marketplace it came from. Absent on entries written before marketplaces existed. */
  marketplace?: string;
  version: string;
  installed_at: string;
  sha256: string;
  /** What the package wrote, relative to `.studio/`. Absent on pre-migration entries. */
  files?: string[];
  required_by?: string[];
  /**
   * Range declared by each dependent, e.g. `{ "software": ">=1.2.0" }`. Without it
   * an update has no way to tell "newest" from "newest my dependents accept".
   * Only dependents that declared a range appear.
   */
  constraints?: Record<string, string>;
}

export interface Lockfile {
  installed: Record<string, LockfileEntry>;
}

/** Where each content kind lands, relative to the project's `.studio/` dir. */
export const CONTENT_DIRS: Record<ContentKind, string> = {
  tool: 'tools',
  agent: 'agents',
  skill: 'skills',
  trigger: 'triggers',
  pipeline: 'pipelines',
  contract: 'contracts',
  input: 'inputs',
};

/**
 * Payload filename suffix → content kind. The suffix is the only thing that
 * decides where a plugin's file lands; `provides` is a declaration, not authority.
 */
export const CONTENT_EXTENSIONS: Record<string, ContentKind> = {
  '.tool.yaml': 'tool',
  '.agent.yaml': 'agent',
  '.skill.md': 'skill',
  '.trigger.yaml': 'trigger',
  '.pipeline.yaml': 'pipeline',
  '.contract.yaml': 'contract',
  '.input.yaml': 'input',
};

export function contentKindOf(filename: string): ContentKind | null {
  for (const [ext, kind] of Object.entries(CONTENT_EXTENSIONS)) {
    if (filename.endsWith(ext)) return kind;
  }
  return null;
}

/** Where an installed template's payload lands, relative to `.studio/`. */
export const TEMPLATE_DIR = 'projects';

export const REGISTRY_REPO = 'studio-foundation/studio-community';
