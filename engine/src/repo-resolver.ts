import { execSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

export interface RepoResolveOptions {
  repoPathOverride?: string;
  repoUrl?: string;
  rawProjectsDir?: string;
  pipelineName: string;
  branch?: string;
}

export async function cloneRepo(
  repoUrl: string,
  projectsDir: string,
  pipelineName: string,
  branch?: string
): Promise<string> {
  await mkdir(projectsDir, { recursive: true });

  const timestamp = new Date().toISOString()
    .replace(/:/g, 'h')
    .replace(/\..+$/, '')
    .replace('T', 'T');
  const dirName = `${pipelineName}-${timestamp}`;
  const clonePath = join(projectsDir, dirName);

  const branchArg = branch ? `--branch ${branch}` : '';
  const cmd = `git clone --depth 1 ${branchArg} ${repoUrl} ${clonePath}`;

  try {
    execSync(cmd, { stdio: 'pipe' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to clone ${repoUrl}: ${msg}`);
  }

  return clonePath;
}

export async function resolveRepoPath(options: RepoResolveOptions): Promise<string> {
  const { repoPathOverride, repoUrl, rawProjectsDir, pipelineName, branch } = options;

  if (repoPathOverride) {
    return resolve(repoPathOverride);
  }

  if (repoUrl) {
    const rawDir = rawProjectsDir || process.env['STUDIO_PROJECTS_DIR'];
    const projectsDir = rawDir?.replace(/^~/, homedir());
    if (!projectsDir) {
      throw new Error(
        'STUDIO_PROJECTS_DIR is not set. Set it in config.yaml paths.projects_dir or as an environment variable.'
      );
    }
    return cloneRepo(repoUrl, projectsDir, pipelineName, branch);
  }

  return '.';
}
