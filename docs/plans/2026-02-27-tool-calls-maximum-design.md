# Design — STU-186 : `tool_calls.maximum`

**Date :** 2026-02-27
**Ticket :** [STU-186](https://linear.app/studioag/issue/STU-186)
**Branch :** `arianedguay/stu-186-contracts-ajouter-tool_callsmaximum-pour-detecter-les`

## Problème

Un agent peut appeler le même tool en boucle indéfiniment. Le contract supporte `tool_calls.minimum` mais pas `maximum`. Observé en prod : stage `recipe-drafting` de Little Chef — 17x `repo_manager-write_file` sur le même fichier.

## Décisions de design

- **`maximum` compte uniquement les appels réussis** — cohérent avec `minimum` (anti-théâtre : les appels échoués ne comptent pas comme travail accompli).
- **Check dans `validateToolCalls`** — `minimum` et `maximum` sont deux bornes du même compteur (`successfulCount`). Pas de nouvelle fonction.
- **Champ optionnel** — aucune régression sur les contracts existants.

## Changements

### 1. `contracts/src/validation.ts`

Ajouter `maximum?: number` à `ToolCallRequirements` :

```typescript
export interface ToolCallRequirements {
  minimum?: number;
  maximum?: number;       // ← nouveau
  required_tools?: string[];
  required_tool_groups?: string[][];
  counted_tools?: string[];
}
```

### 2. `ralph/src/validator.ts`

Dans `validateToolCalls`, factoriser le calcul de `successfulCount` hors des `if`, puis ajouter le check `maximum` :

```typescript
export function validateToolCalls(toolCalls: ToolCall[], requirements?: ToolCallRequirements): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const successfulCount = toolCalls.filter(isSuccessfulToolCall).length;
  const failedCount = toolCalls.length - successfulCount;

  if (requirements?.minimum !== undefined) {
    if (successfulCount < requirements.minimum) {
      const plural = requirements.minimum === 1 ? '' : 's';
      const excluded = failedCount > 0 ? ` (${failedCount} failed excluded)` : '';
      errors.push(
        `Expected at least ${requirements.minimum} successful tool call${plural}, got ${successfulCount} successful${excluded}`
      );
    }
  }

  if (requirements?.maximum !== undefined) {
    if (successfulCount > requirements.maximum) {
      const plural = successfulCount === 1 ? '' : 's';
      errors.push(
        `Tool call limit exceeded: made ${successfulCount} successful call${plural}, maximum is ${requirements.maximum}. ` +
        `This may indicate a loop. Check that the agent is not repeating the same operation.`
      );
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
```

### 3. `ralph/tests/validator.test.ts`

Nouveaux cas dans `describe('validateToolCalls')` :

- passes quand appels réussis < maximum
- passes quand exactement au maximum
- fails quand appels réussis > maximum
- message contient le count réel et le maximum
- message contient "loop"
- maximum seul (sans minimum) fonctionne indépendamment
- minimum + maximum : les deux peuvent failer simultanément

### 4. `CLAUDE.md`

Dans "Contract avec Anti-théâtre (code-generation)" — ajouter `maximum` dans le YAML exemple et une ligne d'explication.

## YAML d'usage

```yaml
tool_calls:
  minimum: 1
  maximum: 10    # Fail si l'agent fait plus de 10 appels réussis
  required_tools:
    - repo_manager-write_file
```

## Injection dans RALPH

Le message d'erreur est automatiquement injecté dans le contexte RALPH via le mécanisme existant : `allFailures` accumule les erreurs de validation, passées comme `previousFailures` à la tentative suivante. Aucun changement nécessaire dans `loop.ts`.
