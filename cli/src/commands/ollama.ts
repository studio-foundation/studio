import { spawnSync } from 'node:child_process';
import chalk from 'chalk';

const OLLAMA_DOCKER_IMAGE = 'ollama/ollama';

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 ** 3);
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 ** 2)).toFixed(0)} MB`;
}

async function isOllamaRunning(baseUrl: string): Promise<false | { models: Array<{ name: string; size: number }> }> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`);
    if (!res.ok) return false;
    const data = await res.json() as { models?: Array<{ name: string; size: number }> };
    return { models: data.models ?? [] };
  } catch {
    return false;
  }
}

export async function ollamaStatusCommand(baseUrl: string): Promise<void> {
  const result = await isOllamaRunning(baseUrl);
  if (!result) {
    console.log(chalk.red('  ✗ Ollama not running'));
    console.log('');
    console.log('To start Ollama:');
    console.log(`  ${chalk.cyan('ollama serve')}                              # native`);
    console.log(`  ${chalk.cyan(`docker run -d -p 11434:11434 ${OLLAMA_DOCKER_IMAGE}`)}   # Docker`);
    return;
  }
  console.log(chalk.green(`  ✓ Ollama running at ${baseUrl}`));
  if (result.models.length === 0) {
    console.log('  No models pulled yet. Run: studio ollama pull llama3.3');
  } else {
    console.log('');
    console.log('  Pulled models:');
    for (const model of result.models) {
      console.log(`    ${chalk.bold(model.name.padEnd(30))} ${formatBytes(model.size)}`);
    }
  }
}

export async function ollamaStartCommand(baseUrl: string): Promise<void> {
  const running = await isOllamaRunning(baseUrl);
  if (running) {
    console.log(chalk.green(`  ✓ Ollama already running at ${baseUrl}`));
    return;
  }

  const hasNative = spawnSync('ollama', ['--version'], { stdio: 'ignore' }).status === 0;
  if (hasNative) {
    console.log('Ollama is installed but not running. Start it with:');
    console.log('');
    console.log(`  ${chalk.cyan('ollama serve')}`);
    return;
  }

  const hasDocker = spawnSync('docker', ['--version'], { stdio: 'ignore' }).status === 0;
  if (hasDocker) {
    console.log('Docker is available. Start Ollama with:');
    console.log('');
    console.log(`  ${chalk.cyan(`docker run -d -p 11434:11434 --name ollama ${OLLAMA_DOCKER_IMAGE}`)}`);
    console.log('');
    console.log('Then pull a model:');
    console.log(`  ${chalk.cyan('studio ollama pull llama3.3')}`);
    return;
  }

  console.log(chalk.yellow('  Neither Ollama nor Docker found.'));
  console.log('');
  console.log('Options:');
  console.log(`  Install Ollama natively: ${chalk.cyan('https://ollama.com')}`);
  console.log(`  Install Docker:          ${chalk.cyan('https://docker.com')}`);
}

export async function ollamaStopCommand(): Promise<void> {
  console.log('To stop Ollama:');
  console.log('');
  console.log(`  Native:  ${chalk.cyan('Ctrl+C')} in the terminal running ${chalk.cyan('ollama serve')}`);
  console.log(`  Docker:  ${chalk.cyan('docker stop ollama')}`);
}

export async function ollamaPullCommand(model: string, baseUrl: string): Promise<void> {
  const running = await isOllamaRunning(baseUrl);
  if (!running) {
    console.error(chalk.red(`  ✗ Ollama not running at ${baseUrl}`));
    console.error(`  Run: ${chalk.cyan('studio ollama start')}`);
    process.exit(1);
  }

  process.stdout.write(`Pulling ${chalk.bold(model)}...`);

  try {
    const res = await fetch(`${baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
    });

    if (!res.ok || !res.body) {
      process.stdout.write('\n');
      console.error(`Pull failed: HTTP ${res.status}`);
      process.exit(1);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let lastStatus = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed) as { status?: string; error?: string };
          if (event.error) {
            process.stdout.write('\n');
            console.error(chalk.red(`  ✗ ${event.error}`));
            process.exit(1);
          }
          if (event.status && event.status !== lastStatus) {
            process.stdout.write(`\r${event.status.padEnd(60)}`);
            lastStatus = event.status;
          }
        } catch {
          // ignore non-JSON lines
        }
      }
    }

    process.stdout.write('\n');
    console.log(chalk.green(`  ✓ Pulled ${model}`));
  } catch (err) {
    process.stdout.write('\n');
    console.error(chalk.red(`  ✗ Pull failed: ${err instanceof Error ? err.message : String(err)}`));
    console.error(`  You can retry with: ${chalk.cyan(`studio ollama pull ${model}`)}`);
    process.exit(1);
  }
}

export async function ollamaCommand(action: string, modelArg: string | undefined, baseUrl: string): Promise<void> {
  if (action === 'status') {
    await ollamaStatusCommand(baseUrl);
  } else if (action === 'start') {
    await ollamaStartCommand(baseUrl);
  } else if (action === 'stop') {
    await ollamaStopCommand();
  } else if (action === 'pull') {
    if (!modelArg) {
      console.error('Usage: studio ollama pull <model>');
      console.error('Example: studio ollama pull llama3.3');
      process.exit(1);
    }
    await ollamaPullCommand(modelArg, baseUrl);
  } else {
    console.error(`Unknown ollama action: ${action}. Use: studio ollama start|stop|status|pull <model>`);
    process.exit(1);
  }
}
