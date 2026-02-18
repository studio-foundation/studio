# @studio/ralph

RALPH loop engine — retry intelligent avec validation.
"Recursive Automated Loop for Persistent Handling" (Ralph Wiggum approved)

## Concept

ralph() prend un executor et un validator. Il execute, valide, retry si fail.
C'est tout. C'est générique. Ça marche pour n'importe quoi, pas juste des LLMs.

## Règles

- ralph() est UNE fonction. Pas une classe, pas un framework.
- La validation est composable (compose(...validators))
- Les stratégies de retry sont pluggables
- JAMAIS de dépendance sur runner ou engine — ralph est agnostique
- Dépend UNIQUEMENT de @studio/contracts

## Fichiers clés

- `loop.ts` — ralph() la fonction principale
- `validator.ts` — moteur de validation + composition
- `contracts.ts` — chargement output contracts YAML
- `retry-strategy.ts` — fixed, exponential, prompt escalation
- `context-enricher.ts` — enrichir contexte entre retries

## Anti-patterns

- NE PAS mettre de logique LLM ici
- NE PAS importer @studio/runner
- NE PAS hardcoder des règles de validation — tout vient des contracts YAML

## Usage

```typescript
import { ralph } from '@studio/ralph';

const result = await ralph({
  executor: () => doSomething(),
  validator: (result) => validate(result),
  maxAttempts: 3,
  retryStrategy: exponentialBackoff(1000, 10000),
});
```
