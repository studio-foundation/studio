import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import chalk from 'chalk';
import yaml from 'js-yaml';
import type { OutputContract } from '@studio-foundation/contracts';
import { validateSchema } from '@studio-foundation/engine';

export async function validateCommand(
  contractPath: string,
  outputPath: string
): Promise<void> {
  try {
    // Load contract YAML
    const contractRaw = await readFile(resolve(contractPath), 'utf-8');
    const contract = yaml.load(contractRaw) as OutputContract;

    // Load output JSON
    const outputRaw = await readFile(resolve(outputPath), 'utf-8');
    const output: unknown = JSON.parse(outputRaw);

    // Validate
    const result = validateSchema(output, contract);

    if (result.valid) {
      console.log(chalk.green('✓ Valid'));
    } else {
      console.log(chalk.red('✗ Invalid'));
      console.log('');
      for (const error of result.errors) {
        console.log(chalk.red(`  - ${error}`));
      }
    }

    if (result.warnings.length > 0) {
      console.log('');
      for (const warning of result.warnings) {
        console.log(chalk.yellow(`  ⚠ ${warning}`));
      }
    }

    process.exit(result.valid ? 0 : 1);
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
