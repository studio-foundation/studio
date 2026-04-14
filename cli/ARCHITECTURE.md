# @studio-foundation/cli

Interface terminal pour Studio. Composition root — câble toutes les dépendances et délègue.

## Règles

- ZERO logique métier — tout est dans engine
- Le CLI est le **composition root** : il instancie `ProviderRegistry`, `ToolRegistry`, `MCPClient`, `PipelineEngine`. Exception documentée au DAG dans INVARIANTS.md.
- Pretty output pour humains (`--live`), JSON pour machines (`--json`)
- `findStudioDir()` remonte l'arbre de dossiers — les tests doivent utiliser `/tmp`, jamais un sous-dossier du repo Studio (qui a lui-même un `.studio/`)
- Dépend de : `@studio-foundation/engine`, `@studio-foundation/runner`, `@studio-foundation/contracts` (+ `@studio-foundation/api` pour `studio api start`)

## Fichiers clés

- `index.ts` — entry point Commander, registre de toutes les commandes
- `commands/run.ts` — `studio run` (commande principale)
- `commands/status.ts`, `logs.ts`, `replay.ts` — inspection des runs
- `commands/list.ts` — `studio list projects|pipelines`
- `commands/init.ts` — `studio init` (wizard interactif + mode direct)
- `commands/config.ts` — `studio config set|list|add-provider`
- `commands/tools.ts` — `studio tools list|add|remove|info`
- `commands/registry/` — `studio registry install|remove|search|publish|audit|sync|update`
- `commands/templates.ts` — `studio templates`
- `commands/template/` — `studio template validate`
- `commands/integrations.ts` — `studio integrations`
- `commands/project.ts` — `studio project`
- `commands/api.ts` — `studio api start`
- `commands/validate.ts` — `studio validate <contract> <output.json>`
- `output/` — formatter, logger, progress/spinner, file-changes renderer
- `utils/input-wizard.ts` — prompts interactifs pour `studio run` sans `--input`
- `registry/` — client HTTP registry, lockfile, resolver, cache

## Usage quotidien

```bash
studio run <pipeline> --input "..." --live
studio status
studio logs
studio registry install git
```
