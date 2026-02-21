# STU-93 — Compatibilité Format Plugin Claude Code : Design

**Date :** 2026-02-21
**Issue :** [STU-93](https://linear.app/studioag/issue/STU-93)
**Statut :** Design validé, prêt pour implémentation

---

## Contexte

Studio doit supporter le format plugin Claude Code — principalement les MCP servers (`.mcp.json`) et les skills (`skills/*.skill.md`). Un plugin Claude Code placé dans `.studio/plugins/<nom>/` doit être automatiquement exploitable dans un pipeline Studio, sans modification du plugin.

Scope MVP (STU-93) :
- `.mcp.json` — démarrage des MCP servers, exposition des tools aux agents
- `skills/*.skill.md` — injection dans le system prompt des agents

Hors scope (délégué aux issues dédiées) :
- `hooks/` — STU-94
- `agents/` — post-MVP
- `commands/` — post-MVP

---

## Décisions clés

| Question | Décision |
|----------|----------|
| Où vivent les plugins ? | `.studio/plugins/<nom>/` |
| Approche architecturale | Runner owns it all (Approche A) |
| Lifecycle MCP servers | Start/stop par run (finally block) |
| Opt-in des agents | `plugins: [nom]` dans l'agent YAML |
| Injection des skills | Concatenés dans `system_prompt` avant le runner |
| Hooks | Délégués à STU-94 |

---

## Structure Plugin (côté utilisateur)

```
my-project/
└── .studio/
    └── plugins/
        └── code-review/           # Nom du plugin = nom du répertoire
            ├── .mcp.json          # MCP servers à démarrer
            ├── skills/
            │   ├── code-review-guidelines.skill.md
            │   └── security-checklist.skill.md
            └── README.md          # (optionnel)
```

**Format `.mcp.json` (standard Claude Code) :**
```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    }
  }
}
```

**Agent YAML étendu :**
```yaml
name: code-reviewer
provider: anthropic
model: claude-sonnet-4-20250514
plugins:
  - code-review       # Tous les tools MCP + skills de ce plugin
tools:
  - repo_manager-read_file
system_prompt: "You are an expert code reviewer."
```

---

## Types de données

```typescript
// PluginManifest — ce qu'un plugin expose
interface PluginManifest {
  name: string;            // Nom du répertoire
  path: string;            // Chemin absolu vers le plugin
  mcpServers: Record<string, MCPServerDef>;  // Parsé depuis .mcp.json
  skills: SkillManifest[];                   // Parsé depuis skills/*.skill.md
}

interface MCPServerDef {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

// SkillManifest (déjà défini dans skill-loader.ts placeholder)
interface SkillManifest {
  name: string;       // Nom du fichier sans extension
  content: string;    // Contenu markdown complet
}
```

---

## Flux d'exécution

```
CLI: studio run <pipeline>
 │
 ├─ loadPlugins(configsDir/plugins/)
 │     └─ Pour chaque sous-dossier de .studio/plugins/:
 │           lire .mcp.json si présent → MCPServerDefs
 │           lire skills/*.skill.md → SkillManifest[]
 │           → PluginManifest[]
 │
 ├─ startMCPServers(manifests)          ← try block commence ici
 │     └─ Pour chaque MCPServerDef:
 │           new MCPClient(serverName, def)
 │           client.start()             ← spawn process + connect stdio
 │           client.listTools()         → Tool[] avec prefix "code-review-github-"
 │           toolRegistry.register(tools)
 │     → Map<clientId, MCPClient>
 │
 ├─ engine.run(pipeline, input, ...)
 │     └─ Pour chaque stage:
 │           loadAgent("code-reviewer") → AgentProfile avec plugins: ["code-review"]
 │           resolveEffectiveTools(agent, toolRegistry, pluginManifests)
 │                 ← tools: explicites + tous les tools des plugins listés
 │           injectSkills(agent, pluginManifests)
 │                 ← concatene skill content dans agent.system_prompt
 │           runner.runAgent(agentProfile augmenté, context, tools)
 │
 └─ stopMCPServers(clients)             ← finally block (toujours exécuté)
```

**Nommage des tools MCP :** `<plugin-name>-<server-name>-<tool-name>`
- Exemple : `code-review-github-list_issues`, `code-review-github-create_pr_comment`

---

## Changements par package

### `runner/` (nouvelles fonctionnalités)

**Nouveaux fichiers :**
- `runner/src/plugins/plugin-loader.ts` — scan `.studio/plugins/*/`, parse `.mcp.json` et `skills/`
- `runner/src/plugins/mcp-client.ts` — lifecycle MCP server + tool discovery via `@modelcontextprotocol/sdk`
- `runner/src/plugins/index.ts` — exports

**Fichiers modifiés :**
- `runner/src/tools/skills/skill-loader.ts` — implémenter le placeholder existant (actuellement tous les throw "not yet implemented")
- `runner/package.json` — ajouter `@modelcontextprotocol/sdk`
- `runner/src/index.ts` — exporter les nouveaux types

### `contracts/`

**Fichiers modifiés :**
- `contracts/src/agent.ts` (ou équivalent) — ajouter `plugins?: string[]` à `AgentProfile`

### `engine/`

**Fichiers modifiés :**
- `engine/src/pipeline/agent-loader.ts` — parser le champ `plugins: string[]` depuis l'agent YAML

### `cli/`

**Fichiers modifiés :**
- `cli/src/commands/run.ts` — orchestrer le lifecycle plugins (load → start → run → stop)
- `cli/src/commands/tools.ts` (ou list) — afficher source `[plugin: code-review]` pour tools MCP

---

## Implémentation MCPClient

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

class MCPClient {
  private client: Client;
  private transport: StdioClientTransport;

  constructor(private pluginName: string, private serverName: string, private def: MCPServerDef) {
    this.transport = new StdioClientTransport({
      command: def.command,
      args: def.args ?? [],
      env: { ...process.env, ...resolveEnvVars(def.env ?? {}) },
    });
    this.client = new Client({ name: "studio", version: "1.0.0" }, { capabilities: {} });
  }

  async start(): Promise<void> {
    await this.client.connect(this.transport);
  }

  async getTools(): Promise<Tool[]> {
    const { tools } = await this.client.listTools();
    return tools.map(t => ({
      name: `${this.pluginName}-${this.serverName}-${t.name}`,
      description: t.description ?? "",
      inputSchema: t.inputSchema as JSONSchema,
      execute: async (params) => {
        const result = await this.client.callTool({ name: t.name, arguments: params });
        return { success: true, output: formatMCPResult(result) };
      },
    }));
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
```

---

## Injection des Skills

Les skills sont concaténées dans `system_prompt` **avant** de passer au runner — aucun changement à l'interface runner.

```typescript
function injectSkills(agent: AgentProfile, plugins: PluginManifest[]): AgentProfile {
  const activePlugins = plugins.filter(p => agent.plugins?.includes(p.name));
  const skillContent = activePlugins
    .flatMap(p => p.skills)
    .map(s => `## Skill: ${s.name}\n\n${s.content}`)
    .join("\n\n---\n\n");

  if (!skillContent) return agent;

  return {
    ...agent,
    system_prompt: `${agent.system_prompt}\n\n${skillContent}`,
  };
}
```

---

## Critères d'acceptation

1. Un plugin dans `.studio/plugins/code-review/` avec `.mcp.json` démarre ses MCP servers automatiquement au `studio run`
2. Les tools MCP apparaissent dans `studio tools list` avec `[plugin: code-review]` comme source
3. Un agent avec `plugins: [code-review]` a accès aux tools MCP du plugin sans les lister individuellement
4. Les skills markdown sont injectées dans le system prompt des agents qui déclarent le plugin
5. Les MCP servers sont stoppés proprement même si le pipeline plante (finally block)
6. Compatible avec le plugin officiel `@modelcontextprotocol/server-github` (test d'intégration)

---

## Tests à écrire

- `runner/src/plugins/plugin-loader.test.ts` — détection plugins, parse .mcp.json, liste skills
- `runner/src/plugins/mcp-client.test.ts` — test avec mock MCP server (stdio)
- `runner/src/tools/skills/skill-loader.test.ts` — chargement fichiers .skill.md
- `engine/src/pipeline/agent-loader.test.ts` — parse du champ `plugins:` dans YAML
