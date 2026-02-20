import { resolve } from 'node:path';
import chalk from 'chalk';
import { validateTemplateDir } from './validate.js';

export async function templateCommand(action: string, args: string[]): Promise<void> {
  try {
    switch (action) {
      case 'validate': {
        const pathArg = args[0];
        if (!pathArg) {
          console.error('Usage: studio template validate <path>');
          process.exit(1);
        }
        const templatePath = resolve(pathArg);
        console.log('');
        console.log(`Validating template at: ${chalk.cyan(templatePath)}`);
        console.log('');

        const result = await validateTemplateDir(templatePath);

        if (result.valid) {
          console.log(chalk.green('✓ Structural validation passed'));
          console.log(chalk.green('✓ Semantic validation passed'));
        } else {
          if (result.structuralErrors.length > 0) {
            console.log(chalk.red('✗ Structural validation failed'));
          } else {
            console.log(chalk.green('✓ Structural validation passed'));
            console.log(chalk.red('✗ Semantic validation failed'));
          }
          console.log('');
          const allErrors = [...result.structuralErrors, ...result.semanticErrors];
          for (const error of allErrors) {
            for (const line of error.split('\n')) {
              console.log(`  ${chalk.red(line)}`);
            }
          }
        }

        if (result.warnings.length > 0) {
          console.log('');
          for (const warning of result.warnings) {
            console.log(`  ${chalk.yellow('⚠')} ${chalk.gray(warning)}`);
          }
        }

        console.log('');
        process.exit(result.valid ? 0 : 1);
      }

      default:
        console.error(`Unknown template action: ${action}. Available: validate`);
        process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
