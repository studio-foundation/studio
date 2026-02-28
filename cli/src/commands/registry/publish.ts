import chalk from 'chalk';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { PackageMetadata } from '../../registry/types.js';

const REQUIRED_METADATA_FIELDS = ['name', 'version', 'description', 'author', 'license', 'type'];

export async function validatePublishPayload(packagePath: string): Promise<PackageMetadata> {
  const absPath = resolve(packagePath);

  if (!existsSync(absPath)) {
    throw new Error(`Path does not exist: ${absPath}`);
  }

  const packageDir = dirname(absPath);
  const metadataPath = resolve(packageDir, 'metadata.json');

  if (!existsSync(metadataPath)) {
    throw new Error(`metadata.json not found in ${packageDir}`);
  }

  const meta = JSON.parse(await readFile(metadataPath, 'utf8')) as Partial<PackageMetadata>;
  const missing = REQUIRED_METADATA_FIELDS.filter(f => !(f in meta));
  if (missing.length > 0) {
    throw new Error(`Missing required metadata fields: ${missing.join(', ')}`);
  }

  return meta as PackageMetadata;
}

interface PublishOptions {
  dryRun?: boolean;
}

export async function publishCommand(packagePath: string, options: PublishOptions = {}): Promise<void> {
  try {
    console.log('Validating package...');
    const meta = await validatePublishPayload(packagePath);
    console.log(chalk.green(`✓ ${meta.name} v${meta.version} [${meta.type}]`));

    if (options.dryRun) {
      console.log(chalk.gray('Dry run — skipping GitHub PR'));
      return;
    }

    // Check gh CLI is available and authenticated
    const ghCheck = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' });
    if (ghCheck.status !== 0) {
      throw new Error('GitHub CLI not authenticated. Run: gh auth login');
    }

    const packageDir = dirname(resolve(packagePath));
    const branchName = `${meta.type}-${meta.name}-v${meta.version}`;
    const registryPath = `${meta.type}s/${meta.name}`;

    console.log('Creating GitHub PR...');

    // Fork the registry (idempotent)
    spawnSync('gh', ['repo', 'fork', 'studio-community/registry', '--clone=false'], {
      encoding: 'utf8',
    });

    // Get the authenticated user's login for the fork URL
    const userResult = spawnSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8' });
    const userLogin = userResult.stdout.trim();
    if (!userLogin) throw new Error('Failed to get GitHub username');

    // Clone fork to temp dir
    const tmp = `/tmp/studio-registry-publish-${Date.now()}`;
    const cloneResult = spawnSync('git', ['clone', `https://github.com/${userLogin}/registry.git`, tmp], {
      encoding: 'utf8',
    });
    if (cloneResult.status !== 0) throw new Error(`Failed to clone fork: ${cloneResult.stderr}`);

    // Create branch, copy files, push
    spawnSync('git', ['-C', tmp, 'checkout', '-b', branchName], { encoding: 'utf8' });
    spawnSync('cp', ['-r', packageDir, resolve(tmp, registryPath)], { encoding: 'utf8' });
    spawnSync('git', ['-C', tmp, 'add', registryPath], { encoding: 'utf8' });
    spawnSync('git', ['-C', tmp, 'commit', '-m', `[${meta.type}] ${meta.name} v${meta.version}`], {
      encoding: 'utf8',
    });
    const pushResult = spawnSync('git', ['-C', tmp, 'push', '-u', 'origin', branchName], {
      encoding: 'utf8',
    });
    if (pushResult.status !== 0) throw new Error(`Failed to push branch: ${pushResult.stderr}`);

    // Open PR
    const prResult = spawnSync('gh', [
      'pr', 'create',
      '--repo', 'studio-community/registry',
      '--title', `[${meta.type}] ${meta.name} v${meta.version}`,
      '--body', `## ${meta.name}\n\n${meta.description}\n\n**Author:** ${meta.author}\n**License:** ${meta.license}\n**Version:** ${meta.version}`,
      '--head', `${userLogin}:${branchName}`,
    ], { encoding: 'utf8', cwd: tmp });

    // Cleanup
    spawnSync('rm', ['-rf', tmp]);

    if (prResult.status === 0) {
      const prUrl = prResult.stdout.trim();
      console.log(chalk.green(`✓ PR opened: ${prUrl}`));
    } else {
      throw new Error(`Failed to create PR: ${prResult.stderr}`);
    }
  } catch (err) {
    console.error(chalk.red(`Publish failed: ${err instanceof Error ? err.message : err}`));
    process.exit(1);
  }
}
