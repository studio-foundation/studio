# Implémentation --dry-run

## Le concept

`--dry-run` valide toute la configuration sans appeler le LLM. C'est le "preflight check" du pipeline. Si dry-run passe, t'es raisonnablement sûre que le vrai run va pas crasher sur un problème de config.

## Ce que dry-run vérifie

1. **Pipeline existe et charge** — le fichier YAML est valide, les champs requis sont présents
2. **Tous les agents référencés existent** — chaque stage pointe vers un agent qui a un fichier .agent.yaml
3. **Tous les contracts référencés existent** — chaque stage pointe vers un contract qui a un fichier .contract.yaml
4. **Les contracts sont valides** — les required_fields sont des strings, approval config est bien formée
5. **Les tools requis existent** — si un stage demande `repo_manager.write_file`, le tool est dans le registry
6. **Le provider est configuré** — l'agent demande un provider qui est dans .studiorc.yaml avec une API key
7. **Les groups sont bien formés** — si un group existe, il a au moins 2 stages, le dernier a un contract avec approval
8. **L'input est fourni** — --input ou --input-file est présent et lisible

## Ce que dry-run ne vérifie PAS

- Que le LLM répond correctement
- Que les tool calls fonctionnent
- Que le repo existe (pour les pipelines code)
- Que l'API key est valide (juste qu'elle est présente)

## Output attendu

### Tout OK :

```
$ studio run feature-builder --input "Add FAQ" --dry-run

Dry run: feature-builder
  ✓ Pipeline loaded (4 stages)
  ✓ Agent 'analyst' found (anthropic/claude-sonnet-4-20250514)
  ✓ Agent 'coder' found (anthropic/claude-sonnet-4-20250514)
  ✓ Contract 'brief-analysis' found (3 required fields)
  ✓ Contract 'implementation-plan' found (4 required fields)
  ✓ Contract 'code-generation' found (2 required fields, 1 required tool)
  ✓ Contract 'qa-review' found (3 required fields, approval gate)
  ✓ Provider 'anthropic' configured
  ✓ Input provided (23 chars)

All checks passed. Ready to run.
```

### Problèmes détectés :

```
$ studio run feature-builder --input "Add FAQ" --dry-run

Dry run: feature-builder
  ✓ Pipeline loaded (4 stages)
  ✓ Agent 'analyst' found (anthropic/claude-sonnet-4-20250514)
  ✗ Agent 'coder' not found — missing configs/agents/coder.agent.yaml
  ✓ Contract 'brief-analysis' found (3 required fields)
  ✗ Contract 'code-generation' not found — missing configs/contracts/code-generation.contract.yaml
  ✓ Contract 'qa-review' found (3 required fields, approval gate)
  ✗ Provider 'openai' not configured — missing in .studiorc.yaml
  ✓ Input provided (23 chars)

3 errors found. Fix before running.
```

## Implémentation

### Packages modifiés

- **@studio-foundation/engine** — `PipelineEngine.dryRun()`, types `DryRunResult`/`DryRunCheck`, helpers dans `dry-run-helpers.ts`
- **@studio-foundation/cli** — `--dry-run` option, `displayDryRunResult()` dans `dry-run-display.ts`

### Fichiers créés

- `engine/src/pipeline/dry-run-helpers.ts` — flattenStages, extractAgentSlugs, extractContractNames, extractRequiredTools
- `cli/src/output/dry-run-display.ts` — affichage formaté avec chalk (✓/✗/⚠)
- `engine/tests/dry-run.test.ts` — 12 tests pour dryRun()
- `engine/tests/dry-run-helpers.test.ts` — 11 tests pour les helpers

### Fichiers modifiés

- `engine/src/engine.ts` — ajout dryRun(), DryRunCheck, DryRunResult, buildDryRunResult()
- `engine/src/index.ts` — export des nouveaux types
- `cli/src/commands/run.ts` — branchement --dry-run
- `cli/src/index.ts` — option --dry-run dans commander
