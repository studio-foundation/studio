# STU-241 — CLI feedback : timer en temps réel + streaming visible

## Problème

Pour les pipelines longs (10+ minutes), le CLI n'émet aucun feedback pendant l'exécution d'un stage. L'utilisateur voit `⠼ Thinking...` pendant des minutes sans savoir si ça progresse.

## Solution retenue

**Approche B — Timer sur le thinking spinner**, sans dépendance supplémentaire.

- Non-live : `setInterval` met à jour le spinner ora toutes les secondes avec `(Xs)`
- Live : `setInterval` sur le `thinkingSpinner`, avec timer accumulé affiché lors des redémarrages après tool call
- Tokens continuent à streamer naturellement en-dessous (comportement existant conservé)

## Rendu attendu

**Non-live (mode par défaut) :**
```
[2/14] entity-extraction  ⠇ (23s)
[2/14] entity-extraction  ✓ (45s, 1.2k tokens)
```

**Live (`--live`) :**
```
[2/14] entity-extraction
  ⠇ Thinking... (7s)
  Les personnages principaux identifiés sont Carla
  et Eduardo. Je vais maintenant écrire le fichier...
  ✓ 📝 repo_manager-write_file entities.json → 234 bytes
  ⠇ Thinking... (from 14s)
  ✓ (45s, 1.2k tokens)
```

## Architecture

Tout le changement est dans `cli/src/output/progress.ts`. Aucune modification dans engine, runner, ou contracts — les events consommés (`onAgentToken`, `onToolCallStart`, etc.) existent déjà.

## Nouveau state dans `ProgressDisplay`

```typescript
private stageStartTime: number = 0;
private timerInterval: NodeJS.Timeout | null = null;
```

## Méthodes utilitaires privées

```typescript
private startTimer(updateFn: (elapsed: string) => void): void {
  this.stageStartTime = Date.now();
  this.timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - this.stageStartTime) / 1000);
    updateFn(`${s}s`);
  }, 1000);
}

private clearTimer(): void {
  if (this.timerInterval) {
    clearInterval(this.timerInterval);
    this.timerInterval = null;
  }
}

private elapsedSeconds(): number {
  return Math.floor((Date.now() - this.stageStartTime) / 1000);
}
```

## Handlers modifiés

### `onStageStart`

**Non-live :** démarre `startTimer` qui update `spinner.text` avec `formatStageLine(prefix, name, `(${s}`)`.

**Live :** démarre `startTimer` qui update `thinkingSpinner.text` avec `Thinking... (${s}s)`.

### `onAgentToken`

Appelle `clearTimer()` avant de stopper le thinkingSpinner (évite une update parasite pendant le stream).

### `onToolCallStart`

Appelle `clearTimer()` avant d'arrêter le thinkingSpinner.

### `onToolCallComplete`

Redémarre le thinkingSpinner avec `Thinking... (from ${elapsedSeconds()}s)`. Redémarre `startTimer` avec `stageStartTime` **inchangé** (pas de reset — le timer continue à partir du début du stage).

### `onStageComplete`

Appelle `clearTimer()` avant de succéder/fail le spinner.

### `onTaskRetry`

Appelle `clearTimer()` en tête du handler (avant les stops existants).

### `interrupt()`

Appelle `clearTimer()` en plus des stops existants.

## Ce qui ne change pas

- Levels 3 (tool calls en live) et 4 (retry feedback) : déjà implémentés, aucune modification.
- Streaming de tokens bruts en live : comportement inchangé.
- Mode JSON (`--json`) : inchangé (`if (this.jsonMode) return` existe déjà).

## Tests

Nouveaux tests unitaires dans `cli/tests/progress-timer.test.ts` :

- Timer démarre sur `onStageStart`, s'arrête sur `onStageComplete`
- Timer s'arrête sur `onTaskRetry`
- Timer s'arrête sur `interrupt()`
- Après tool call, thinkingSpinner montre `from Xs` avec temps accumulé
- `clearTimer` est idempotent (appelé plusieurs fois = pas d'erreur)

## Fichiers touchés

- `cli/src/output/progress.ts` — ajout timer
- `cli/tests/progress-timer.test.ts` — nouveaux tests
