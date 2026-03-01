# @studio/ralph

RALPH loop engine — retry intelligent avec validation.
"Recursive Automated Loop for Persistent Handling"

## Concept

`ralph<T>()` prend un `executor` générique et un `validator`. Il exécute, valide, retry si fail, s'arrête sur AbortSignal.
C'est tout. C'est générique. Ça marche pour n'importe quoi, pas juste des LLMs.

## Règles

- `ralph()` est UNE fonction. Pas une classe, pas un framework.
- Le `executor` est `() => Promise<T>` — ralph ne sait pas que c'est un LLM derrière
- La validation est composable via `compose(...validators)`
- Les stratégies de retry sont pluggables (`exponentialBackoff`, `fixedDelay`, `noDelay`)
- JAMAIS de dépendance sur `@studio/runner` ou `@studio/engine` — ralph est agnostique
- Dépend UNIQUEMENT de `@studio/contracts`

## Résultat

```typescript
type RalphResult<T> =
  | { status: 'success';   result: T;     attempts: number }
  | { status: 'exhausted'; lastResult: T; failures: string[]; attempts: number }
  | { status: 'cancelled'; lastResult?: T; attempts: number }  // AbortSignal
```

## Fichiers clés

- `loop.ts` — `ralph()` la fonction principale + `RalphConfig`, `RalphResult`
- `validator.ts` — `validateSchema`, `validateToolCalls`, `validateRequiredTools`, `compose`
- `retry-strategy.ts` — `exponentialBackoff(min, max)`, `fixedDelay(ms)`, `noDelay()`
- `context-enricher.ts` — enrichir contexte entre retries
- `contracts.ts` — types internes ralph

## Anti-patterns

- NE PAS mettre de logique LLM ici
- NE PAS importer `@studio/runner`
- NE PAS hardcoder des règles de validation — tout vient des contracts YAML
