import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(__dirname, '../../templates');

export async function initCommand(): Promise<void> {
  try {
    const cwd = process.cwd();

    console.log(chalk.blue('\nInitializing Studio project...\n'));

    // Create directories
    const dirs = ['pipelines', 'configs/agents', 'configs/contracts'];
    for (const dir of dirs) {
      await mkdir(resolve(cwd, dir), { recursive: true });
      console.log(chalk.gray(`  Created ${dir}/`));
    }

    // Copy .studiorc.yaml template
    const configTemplate = await readFile(
      resolve(TEMPLATES_DIR, '.studiorc.yaml'),
      'utf-8'
    );
    await writeFile(resolve(cwd, '.studiorc.yaml'), configTemplate);
    console.log(chalk.gray('  Created .studiorc.yaml'));

    // Copy hello-world pipeline template
    const pipelineTemplate = await readFile(
      resolve(TEMPLATES_DIR, 'pipelines/hello-world.pipeline.yaml'),
      'utf-8'
    );
    await writeFile(
      resolve(cwd, 'pipelines/hello-world.pipeline.yaml'),
      pipelineTemplate
    );
    console.log(chalk.gray('  Created pipelines/hello-world.pipeline.yaml'));

    console.log(chalk.green('\n✓ Studio project initialized'));
    console.log('');
    console.log('Next steps:');
    console.log(`  1. Set your API key: ${chalk.cyan('export ANTHROPIC_API_KEY=...')}`);
    console.log(`  2. Run the hello-world pipeline: ${chalk.cyan('studio run hello-world --input "Hello!"')}`);
    console.log('');
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
