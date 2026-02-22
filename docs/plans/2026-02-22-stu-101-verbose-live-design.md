# STU-101: Flag --verbose pour --live sans truncation

## Contexte

En mode `--live`, les outputs de stage et les resultats de tool calls sont tronques. `summarizeToolResult()` coupe a 60 chars, et les objets profonds sont aplatis en JSON brut. En debug, c'est bloquant.

## Decision

Reutiliser le flag `--verbose` existant. Quand combine avec `--live`, il desactive toute truncation. Seul ou sans `--live`, il garde son comportement actuel.

## Design

### Changement de modele: tri-state → deux booleans

**Avant:** `displayMode: 'live' | 'verbose' | 'quiet'` (mutuellement exclusif, `--live --verbose` affiche un warning).

**Apres:** `ProgressDisplay` recoit `live: boolean` et `verbose: boolean` independamment. La combinaison `live + verbose` est un mode valide.

### Fichiers touches

**`cli/src/commands/run.ts`**
- Supprimer le warning `--live includes all --verbose output`
- Passer `live` et `verbose` comme booleans separés a `ProgressDisplay`

**`cli/src/output/progress.ts` (ProgressDisplay)**
- Constructeur: accepter `live` et `verbose` au lieu de `displayMode`
- `onToolCallComplete`: quand `live && verbose`, afficher le resultat complet indente en gris sous la ligne spinner (via `formatToolResult`) au lieu de `summarizeToolResult()`
- `onStageComplete`: quand `live && verbose`, passer `maxDepth: Infinity` a `formatStageOutput` + afficher le token breakdown
- Sans verbose, comportement identique a aujourd'hui

**`cli/src/output/formatters.ts`**
- Ajouter `formatToolResult(result: unknown): string` — formate le resultat complet d'un tool call:
  - String → indente (2 espaces par ligne)
  - Objet avec `.content` string → contenu indente
  - Autre → JSON.stringify indente

### Ce qui ne change pas

- Comportement sans `--verbose` (live seul, verbose seul, quiet)
- Engine, ralph, runner, contracts — tout reste dans cli/
- Events et leurs payloads
- `formatStageOutput` (utilise tel quel, juste maxDepth change)
