/**
 * Provider registry - factory for LLM providers
 */

import type { Provider } from './provider.js';
import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIResponsesProvider } from './openai-responses.js';
import { OllamaProvider } from './ollama.js';
import { ClaudeCodeProvider } from './claude-code.js';

export class ProviderRegistry {
  private providers: Map<string, Provider> = new Map();
  private factories: Map<string, () => Provider> = new Map();

  /**
   * Register a provider instance
   */
  register(provider: Provider): void {
    this.providers.set(provider.name, provider);
    this.factories.delete(provider.name);
  }

  /**
   * Register a provider built on first use, so a misconfigured provider only
   * fails the run that actually references it.
   */
  registerLazy(name: string, factory: () => Provider): void {
    this.factories.set(name, factory);
  }

  /**
   * Get provider by name
   */
  get(name: string): Provider {
    const provider = this.providers.get(name);
    if (provider) return provider;

    const factory = this.factories.get(name);
    if (factory) {
      let built: Provider;
      try {
        built = factory();
      } catch (err) {
        throw new Error(
          `Provider "${name}" failed to initialize: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      this.providers.set(name, built);
      return built;
    }

    const available = this.list();
    const detail = available.length > 0 ? available.join(', ') : '(none registered)';
    throw new Error(`Provider not found: ${name}. Available providers: ${detail}`);
  }

  /**
   * Check if provider exists
   */
  has(name: string): boolean {
    return this.providers.has(name) || this.factories.has(name);
  }

  /**
   * List available provider names
   */
  list(): string[] {
    return Array.from(new Set([...this.providers.keys(), ...this.factories.keys()]));
  }
}

function requireApiKey(configKey: string, apiKey: string | undefined): string {
  if (!apiKey || apiKey.trim() === '') {
    throw new Error(
      `no API key. Set providers.${configKey}.apiKey in .studio/config.yaml (its env var is empty or unset)`
    );
  }
  return apiKey;
}

/**
 * Factory function to create a registry with default providers
 */
export function createDefaultRegistry(config: {
  openai?: { apiKey: string; baseUrl?: string };
  anthropic?: { apiKey: string };
  openaiResponses?: { apiKey: string };
  ollama?: { baseUrl?: string };
  claudeCode?: { model?: string };
}): ProviderRegistry {
  const registry = new ProviderRegistry();

  if (config.openai) {
    const { apiKey, baseUrl } = config.openai;
    registry.registerLazy('openai', () => new OpenAIProvider(requireApiKey('openai', apiKey), baseUrl));
  }

  if (config.anthropic) {
    const { apiKey } = config.anthropic;
    registry.registerLazy('anthropic', () => new AnthropicProvider(requireApiKey('anthropic', apiKey)));
  }

  if (config.openaiResponses) {
    const { apiKey } = config.openaiResponses;
    registry.registerLazy(
      'openai-responses',
      () => new OpenAIResponsesProvider(requireApiKey('openai', apiKey))
    );
  }

  if (config.ollama) {
    const { baseUrl } = config.ollama;
    registry.registerLazy('ollama', () => new OllamaProvider(baseUrl));
  }

  if (config.claudeCode) {
    const { model } = config.claudeCode;
    registry.registerLazy('claude-code', () => new ClaudeCodeProvider({ model }));
  }

  return registry;
}
