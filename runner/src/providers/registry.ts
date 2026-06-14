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

  /**
   * Register a provider instance
   */
  register(provider: Provider): void {
    this.providers.set(provider.name, provider);
  }

  /**
   * Get provider by name
   */
  get(name: string): Provider {
    const provider = this.providers.get(name);
    if (!provider) {
      const available = this.list();
      const detail = available.length > 0 ? available.join(', ') : '(none registered)';
      throw new Error(`Provider not found: ${name}. Available providers: ${detail}`);
    }
    return provider;
  }

  /**
   * Check if provider exists
   */
  has(name: string): boolean {
    return this.providers.has(name);
  }

  /**
   * List available provider names
   */
  list(): string[] {
    return Array.from(this.providers.keys());
  }
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
    registry.register(new OpenAIProvider(config.openai.apiKey, config.openai.baseUrl));
  }

  if (config.anthropic) {
    registry.register(new AnthropicProvider(config.anthropic.apiKey));
  }

  if (config.openaiResponses) {
    registry.register(new OpenAIResponsesProvider(config.openaiResponses.apiKey));
  }

  if (config.ollama) {
    registry.register(new OllamaProvider(config.ollama.baseUrl));
  }

  if (config.claudeCode) {
    registry.register(new ClaudeCodeProvider({ model: config.claudeCode.model }));
  }

  return registry;
}
