# @studio/runner

Agent runner multi-provider. Parle aux LLMs, exécute les tools, streame les tokens.

## Concept

`runAgent()` prend un `AgentConfig` + contexte, appelle le LLM, exécute les tool calls en boucle, retourne un `AgentRunResult` complet avec tous les tool calls trackés et l'usage de tokens.

## Règles

- Multi-provider : Anthropic, OpenAI, OpenAI Responses API, Mock — même interface `runAgent()`
- CHAQUE tool call réel est tracké dans `AgentRunResult.tool_calls`
- Le runner ne valide PAS — c'est le job de ralph
- Le runner ne retry PAS — c'est le job de ralph
- Les prompts sont assemblés ici (`prompt-builder.ts`) — le engine ne touche jamais aux prompts
- Les tools sont enregistrés ici (`ToolRegistry`) — le engine ne sait pas ce qu'est `repo_manager-write_file`
- Dépend UNIQUEMENT de `@studio/contracts`

## Fichiers clés

- `runner.ts` — `runAgent()` fonction principale, deux chemins : agent loop provider et chat completions standard
- `prompt-builder.ts` — assemblage system prompt + skills + context + task
- `providers/anthropic.ts` — Claude (prompt caching, 90% cost reduction sur retries)
- `providers/openai.ts` — OpenAI chat completions
- `providers/openai-responses.ts` — OpenAI Responses API (provider owns the loop)
- `providers/mock.ts` — mock provider pour tests sans API keys
- `providers/registry.ts` — `ProviderRegistry`, `createDefaultRegistry()`
- `tools/tool-registry.ts` — `ToolRegistry` (register, lookup)
- `tools/tool-executor.ts` — `ToolExecutor` (dispatch tool calls)
- `tools/plugin-loader.ts` — charge les `.tool.yaml` plugins
- `tools/builtin/repo-manager.ts` — `repo_manager-read_file`, `write_file`, `list_files`
- `tools/builtin/shell.ts` — `shell-run_command`
- `tools/builtin/search.ts` — `search-search_codebase`
- `tools/builtin/git.ts` — `git-checkout`, `git-commit`, `git-push`, `git-pull`, `git-status`, `git-diff`
- `tools/builtin/patch.ts` — `patch-apply_patch`
- `tools/builtin/studio-run.ts` — `studio_run` (spawn sous-pipeline, requiert `RunSpawner`)
- `tools/skills/skill-loader.ts` — charge les `.skill.md` files
- `middleware/anonymization.ts` — `AnonymizationMiddleware` (wraps `@studio/anonymizer`)
- `plugins/plugin-loader.ts` — charge les plugins Claude Code (`.mcp.json` + `skills/`)
- `plugins/mcp-client.ts` — `MCPClient` (connexion aux serveurs MCP)
- `integrations/integration-loader.ts` — charge les `.integration.yaml`

## Hooks callbacks

`RunnerCallbacks` (dans `@studio/contracts`) wire les hooks du engine vers le runner :

- `onPreToolUse` — peut bloquer un tool call (`{ blocked: true }`)
- `onPostToolUse` — peut injecter du feedback (`{ append_message: '...' }`)
- `onToolCallStart/Complete`, `onAgentThinking/Progress/Token` — observabilité

## Anti-pattern : LE THÉÂTRE

Le problème fondamental : les agents génèrent du JSON décrivant des actions au lieu de FAIRE les actions (`tool_calls: 0`). Le runner DOIT tracker tous les tool calls réels. La validation du théâtre est dans ralph, mais le runner fournit les données.
