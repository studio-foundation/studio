# Cancellation — Ctrl+C pendant un stream LLM actif

Ce document décrit le comportement complet de Studio lorsque l'utilisateur appuie sur **Ctrl+C** pendant qu'un LLM est en train de streamer une réponse.

---

## Vue d'ensemble

Studio supporte une annulation **gracieuse** sur le premier Ctrl+C, et une annulation **forcée** sur le second. Le signal se propage via un `AbortController` à travers toutes les couches : CLI → engine → ralph → runner → provider.

```
Premier Ctrl+C
  ↓
CLI onInterrupt()
  ↓
controller.abort()          ← AbortSignal tire
  ↓
provider.call() reçoit AbortError
  ↓
ralph détecte signal.aborted → retourne { status: 'cancelled' }
  ↓
engine marque le stage 'cancelled'
  ↓
pipeline retourne { status: 'cancelled' }
  ↓
CLI → process.exit(130)

Deuxième Ctrl+C (si le premier n'a pas encore abouti)
  ↓
process.exit(130) immédiat
```

---

## Couche 1 — CLI (`cli/src/commands/run.ts`)

```typescript
const controller = new AbortController();
let forceExitOnNextInterrupt = false;

const onInterrupt = () => {
  if (forceExitOnNextInterrupt) {
    process.exit(130);          // Deuxième Ctrl+C : force-exit immédiat
  }
  forceExitOnNextInterrupt = true;
  controller.abort();           // Tire l'AbortSignal
  progress.interrupt();         // Suspend l'affichage progress
  process.stderr.write('\n⚠ Cancelling run...\n');
};

process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onInterrupt);
```

Le signal `controller.signal` est transmis à `engine.run({ signal })`.

**Exit code 130** = convention POSIX pour "terminé par SIGINT" (128 + 2).

---

## Couche 2 — Ralph (`ralph/src/loop.ts`)

Ralph vérifie `signal.aborted` à **trois points** dans sa boucle :

```typescript
// 1. Avant chaque tentative
if (signal?.aborted) {
  return { status: 'cancelled', lastResult, attempts: attempt };
}

// 2. Si l'executor throw (AbortError propagé depuis le provider)
} catch (err) {
  if (signal?.aborted) {
    return { status: 'cancelled', lastResult, attempts: attempt };
  }
  throw err; // Re-throw des erreurs non-abort
}

// 3. Avant le délai de retry
if (signal?.aborted) {
  return { status: 'cancelled', lastResult: result, attempts: attempt };
}
```

Le `abortableDelay` (délai entre retries) se résout aussi immédiatement si le signal est aborted.

Ralph ne throw jamais d'`AbortError` vers l'extérieur — il retourne proprement `{ status: 'cancelled' }`.

---

## Couche 3 — Runner (`runner/src/runner.ts`)

Le runner vérifie `signal.aborted` avant chaque appel LLM dans la boucle d'outil :

```typescript
if (signal?.aborted) {
  throw new DOMException('The operation was aborted', 'AbortError');
}

const response = await provider.call({ ... }, onToken, signal);
```

L'`AbortError` remonte vers ralph qui le catch et retourne `'cancelled'`.

---

## Couche 4 — Providers

### Anthropic (`runner/src/providers/anthropic.ts`)

Le provider Anthropic utilise l'API **streaming** (`messages.stream`). La problématique spécifique à ce provider :

**Le problème :** Quand l'`AbortSignal` tire pendant un stream actif, le SDK Anthropic kill la connexion HTTP. Mais `stream.finalMessage()` attend l'événement `'end'` du stream pour se résoudre — événement qui **ne fire jamais** quand la connexion est tuée en cours de route. Sans protection, `finalMessage()` pend indéfiniment.

**La solution :** `raceSignal()` — race `finalMessage()` contre le signal :

```typescript
// Streaming path
const stream = this.client.messages.stream(params, { signal });
stream.on('text', (textDelta) => {
  if (signal?.aborted) return; // Guard: n'émet pas après abort
  onToken(textDelta);
});
// KEY FIX: sans raceSignal, finalMessage() pend forever après kill HTTP
const response = await raceSignal(stream.finalMessage(), signal);
```

Dès que le signal fire, `raceSignal` rejette avec `DOMException('Aborted', 'AbortError')` sans attendre la fin du stream.

### OpenAI (`runner/src/providers/openai.ts`)

Le provider OpenAI utilise un `for await` sur le stream de chunks. L'approche diffère :

```typescript
for await (const chunk of stream) {
  // KEY FIX: check signal au début de chaque chunk pour ne pas
  // continuer à consommer des données bufferisées après Ctrl-C
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  // ...
}
```

Le `signal` est aussi passé au `create()` initial pour terminer la connexion HTTP. La boucle `for await` se termine naturellement quand le stream error, et le check explicite en tête de boucle garantit que les chunks déjà bufferisés ne sont pas consommés inutilement.

---

## Utilitaire `raceSignal` (`runner/src/utils/race-signal.ts`)

```typescript
export function raceSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });

    promise
      .then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); })
      .catch((e) => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}
```

- Si la promise se résout avant le signal → retourne la valeur normalement
- Si le signal fire avant la promise → rejette avec `AbortError` immédiatement
- Nettoie le listener dans tous les cas (pas de fuite mémoire)

---

## Couche 5 — Engine (`engine/src/pipeline/stage-executor.ts`)

Quand ralph retourne `{ status: 'cancelled' }`, le StageExecutor marque le stage `cancelled` :

```typescript
if (stageStatus === 'cancelled') {
  stageRun.status = transition('running', 'cancel'); // → 'cancelled'
  // Skip post-validation et hooks
  return { stageRun, status: 'cancelled' };
}
```

La state machine (`engine/src/state/state-machine.ts`) a la transition `running:cancel → cancelled`.

Le GroupOrchestrator et PipelineEngine propagent le `'cancelled'` vers le haut sans retry.

---

## Flow complet — timeline

```
t=0    Ctrl+C
t=0    CLI: onInterrupt() → controller.abort(), progress.interrupt()
t=0    CLI: stderr ← "⚠ Cancelling run..."
t=0+ε  AbortSignal: 'abort' event fire
t=0+ε  raceSignal(finalMessage(), signal) → rejects AbortError
t=0+ε  runner.runAgent() throws AbortError
t=0+ε  ralph catch(err): signal.aborted → return { status: 'cancelled' }
t=0+ε  StageExecutor: stage marked 'cancelled'
t=0+ε  GroupOrchestrator: propagates 'cancelled'
t=0+ε  PipelineEngine.run() resolves: { status: 'cancelled' }
t=ε    CLI finally: runLogger.close(), runStore.close(), MCP servers close
t=ε    CLI: stderr ← "✗ Run cancelled at stage [N] stageName"
t=ε    CLI: process.exit(130)
```

---

## Tests de régression

| Test | Fichier | Ce qu'il vérifie |
|------|---------|-----------------|
| `exits with code 130 on SIGINT during a run` | `cli/tests/integration/sigint.test.ts` | End-to-end : SIGINT → process.exit(130) |
| `aborts streaming call when signal fires` | `runner/src/providers/anthropic.test.ts` | `raceSignal(finalMessage())` reject avec AbortError |
| `aborts non-streaming call when signal fires` | `runner/src/providers/anthropic.test.ts` | Non-streaming path aussi couvert |
| `rejects when signal fires after creation` | `runner/src/utils/race-signal.test.ts` | Promise pendante + signal → AbortError immédiat |
| `executor throw in group → group reruns` | `engine/tests/...` | ralph catch AbortError → cancelled (pas rethrow) |

---

## Invariants à préserver

1. **Premier Ctrl+C = gracieux.** Le pipeline retourne `{ status: 'cancelled' }` proprement, les ressources sont fermées (MCP servers, DB, logs).

2. **Deuxième Ctrl+C = force.** `process.exit(130)` immédiat — dernier recours si le cleanup prend trop de temps.

3. **Exit code 130.** Convention POSIX pour "killed by SIGINT". Les CI/CD peuvent détecter qu'un run a été annulé manuellement (vs failure = code 1).

4. **`raceSignal` sur `finalMessage()`.** Ne jamais `await stream.finalMessage()` sans le wrapper — le stream Anthropic pend forever quand la connexion HTTP est tuée.

5. **Ralph ne throw pas.** Ralph intercepte toujours l'AbortError et retourne `{ status: 'cancelled' }`. L'StageExecutor ne reçoit jamais un AbortError non géré de ralph.
