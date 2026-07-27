import { createHash } from 'node:crypto';
import { chmod, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import chalk from 'chalk';
import { REPO, assetName, checksumFor, detectInstall, platformKey, resolveLatestTag } from '../upgrade.js';
import { STUDIO_VERSION } from '../version-guard.js';

function fail(message: string, ...hints: string[]): never {
  console.error(chalk.red(`Error: ${message}`));
  for (const hint of hints) console.error(`  ${hint}`);
  process.exit(1);
}

async function download(url: string, what: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) fail(`${what} is not available (HTTP ${res.status})`, url);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Swap `path` for `replacement` via rename, which a running executable survives:
 * Windows refuses to overwrite or delete the file it is executing, but does allow
 * renaming it out of the way.
 */
async function swapBinary(path: string, replacement: string): Promise<void> {
  const displaced = `${path}.old`;
  await rm(displaced, { force: true });
  await rename(path, displaced);
  try {
    await rename(replacement, path);
  } catch (error) {
    await rename(displaced, path);
    throw error;
  }
  await rm(displaced, { force: true }).catch(() => {});
}

/** `tag` pins a release (e.g. `v0.11.1`); without it, the latest one wins. */
export async function upgradeCommand(tag?: string): Promise<void> {
  const install = detectInstall();
  if (install.kind === 'npm') {
    console.log(`\n  Studio ${STUDIO_VERSION} was installed through npm — npm owns the update.\n`);
    console.log(`  Run:  ${chalk.cyan('npm i -g @studio-foundation/cli@latest')}\n`);
    return;
  }

  const platform = platformKey();
  if (!platform) fail(`no Studio binary ships for ${process.platform}-${process.arch}.`);

  const release = tag ?? (await resolveLatestTag().catch((e: Error) => fail(e.message)));
  const target = release.replace(/^v/, '');
  if (target === STUDIO_VERSION) {
    console.log(`\n  Already on Studio ${chalk.bold(STUDIO_VERSION)}.\n`);
    return;
  }

  const asset = assetName(platform);
  const base = `https://github.com/${REPO}/releases/download/${release}`;
  console.log(`\n  Downloading Studio ${chalk.bold(target)} (${platform})...`);

  const [binary, manifest] = await Promise.all([
    download(`${base}/${asset}`, `${asset} in ${release}`),
    download(`${base}/SHA256SUMS`, `the checksum manifest for ${release}`),
  ]);

  const expected = checksumFor(manifest.toString('utf-8'), asset);
  if (!expected) fail(`${asset} is not listed in the ${release} SHA256SUMS.`);
  const actual = createHash('sha256').update(binary).digest('hex');
  if (actual !== expected) fail(`checksum mismatch for ${asset} — refusing to install.`);

  const staged = join(dirname(install.path), `.studio-upgrade-${process.pid}`);
  await writeFile(staged, binary);
  await chmod(staged, 0o755);
  try {
    await swapBinary(install.path, staged);
  } catch (error) {
    await rm(staged, { force: true });
    fail(`could not replace ${install.path}: ${(error as Error).message}`, 'Check write permission on that directory.');
  }

  console.log(`  ${chalk.green('✓')} Studio ${STUDIO_VERSION} → ${chalk.bold(target)}  (${install.path})\n`);
}
