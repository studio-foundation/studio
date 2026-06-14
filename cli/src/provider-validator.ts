import { spawnSync } from 'node:child_process';
import { parseAndCacheModels } from './models-cache.js';

export type ValidationResult =
  | { status: 'valid' }
  | { status: 'invalid'; error: string }
  | { status: 'warning'; message: string };

export interface ValidateOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

export async function validateApiKeyLive(
  provider: string,
  apiKey: string,
  options: ValidateOptions = {}
): Promise<ValidationResult> {
  const abort = new AbortController();
  const timer = setTimeout(
    () => abort.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );

  try {
    if (provider === 'anthropic') {
      return await validateAnthropicKey(apiKey, abort.signal);
    } else if (provider === 'openai') {
      return await validateOpenAIKey(apiKey, abort.signal);
    } else if (provider === 'google') {
      return await validateGoogleKey(apiKey, abort.signal);
    } else if (provider === 'ollama') {
      return await validateLocalOllama(
        options.baseUrl ?? 'http://localhost:11434',
        abort.signal
      );
    } else if (provider === 'claude-code') {
      return validateClaudeCode();
    } else {
      return { status: 'warning', message: `Cannot validate unknown provider '${provider}'` };
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { status: 'warning', message: 'Validation timed out — proceeding anyway' };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'warning', message: `Could not validate key: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}

async function validateAnthropicKey(
  apiKey: string,
  signal: AbortSignal
): Promise<ValidationResult> {
  const res = await fetch('https://api.anthropic.com/v1/models', {
    signal,
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
  });
  if (res.status === 200) {
    try { parseAndCacheModels('anthropic', apiKey, await res.json()); } catch { /* ignore */ }
    return { status: 'valid' };
  }
  if (res.status === 401 || res.status === 403) {
    return { status: 'invalid', error: `Invalid key (${res.status} Unauthorized)` };
  }
  return { status: 'warning', message: `Unexpected response ${res.status} — proceeding anyway` };
}

async function validateOpenAIKey(
  apiKey: string,
  signal: AbortSignal
): Promise<ValidationResult> {
  const res = await fetch('https://api.openai.com/v1/models', {
    signal,
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (res.status === 200) {
    try { parseAndCacheModels('openai', apiKey, await res.json()); } catch { /* ignore */ }
    return { status: 'valid' };
  }
  if (res.status === 401 || res.status === 403) {
    return { status: 'invalid', error: `Invalid key (${res.status} Unauthorized)` };
  }
  return { status: 'warning', message: `Unexpected response ${res.status} — proceeding anyway` };
}

async function validateGoogleKey(
  apiKey: string,
  signal: AbortSignal
): Promise<ValidationResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, { signal });
  if (res.status === 200) return { status: 'valid' };
  if (res.status === 400 || res.status === 403) {
    return { status: 'invalid', error: `Invalid key (${res.status})` };
  }
  return { status: 'warning', message: `Unexpected response ${res.status} — proceeding anyway` };
}

function validateClaudeCode(): ValidationResult {
  const which = spawnSync('which', ['claude'], { encoding: 'utf-8' });
  if (which.status !== 0 || which.error) {
    return { status: 'invalid', error: 'claude CLI not found — install Claude Code from https://claude.ai/code' };
  }
  const test = spawnSync(
    'claude',
    ['--print', '--output-format', 'json', '--no-verbose', '--dangerously-skip-permissions', 'respond with the word OK'],
    { encoding: 'utf-8', timeout: 15000 }
  );
  if (test.status !== 0 || test.error) {
    return { status: 'invalid', error: 'Claude Code session inactive — run `claude` to log in first' };
  }
  return { status: 'valid' };
}

async function validateLocalOllama(
  baseUrl: string,
  signal: AbortSignal
): Promise<ValidationResult> {
  const url = baseUrl.replace(/\/$/, '') + '/api/tags';
  const res = await fetch(url, { signal });
  if (res.status === 200) return { status: 'valid' };
  return { status: 'warning', message: `Ollama returned ${res.status} — proceeding anyway` };
}
