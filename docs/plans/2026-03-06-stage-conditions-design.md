# Design — Stage Conditions (STU-239)

Skip conditionnel de stages basé sur l'input du pipeline ou l'output d'un stage précédent.

## Contexte

Certains pipelines ont des stages qui ne doivent s'exécuter que sous certaines conditions. Sans ce mécanisme, on crée des pipelines dupliqués ou on abuse de `studio_run` comme dispatcher. Deux use cases concrets : Little Chef (nombre de repas variable par profil) et Wiki Creator (skip de `entity-resolution-OTHER` si aucune entité OTHER détectée).

## Solution retenue

Directive `condition?: string` optionnelle sur `StageDefinition`. Évaluée avant le RALPH loop dans `StageExecutor.execute()` (Approach A — early return). Évaluateur custom sans dépendance externe (pas d'`eval`).

## Fichiers touchés (5 total, 0 nouvelle dépendance)

| Fichier | Nature |
|---------|--------|
| `contracts/src/pipeline.ts` | +1 ligne : `condition?: string` sur `StageDefinition` |
| `engine/src/pipeline/condition-evaluator.ts` | Nouveau — ~70 lignes |
| `engine/src/pipeline/stage-executor.ts` | ~15 lignes : early return après `onStageStart` |
| `engine/src/pipeline/group-orchestrator.ts` | ~10 lignes : handle `skipped` en séquentiel + parallèle |
| `engine/src/engine.ts` | **Aucun changement** — `skipped` est non-fatal par la logique existante |

## Syntaxe YAML

```yaml
# Basé sur l'input du pipeline
- name: generate-meal-6
  agent: chef
  contract: meal
  condition: "input.meals_count >= 6"

# Basé sur l'output d'un stage précédent
- name: entity-resolution-OTHER
  agent: resolver
  contract: entity-resolution
  condition: "stages.entity-extraction.output.counts.OTHER > 0"
```

## Section 1 — Contract (`contracts/src/pipeline.ts`)

```typescript
export interface StageDefinition {
  name: string;
  condition?: string;   // opaque string, évaluée par le engine
  // ... reste inchangé
}
```

Aucune logique dans contracts — c'est un leaf package. La string est opaque à ce niveau.

## Section 2 — Condition Evaluator (`engine/src/pipeline/condition-evaluator.ts`)

### Signature

```typescript
export function evaluateCondition(
  condition: string,
  context: { input: PipelineInput; stageOutputs: Map<string, unknown> }
): boolean
```

### Algorithme de parsing

1. **Split sur opérateur** — regex longest-first : `===`, `!==`, `>=`, `<=`, `==`, `!=`, `>`, `<`
2. **Résolution du LHS** :
   - `input.meals_count` → traverse `context.input` (si objet) par chemin pointé
   - `stages.entity-extraction.output.counts.OTHER` → split sur la première occurrence de `.output.` pour isoler le nom du stage (qui peut contenir des tirets), puis `stageOutputs.get(stageName)` + traversée du reste
3. **Parsing du RHS** : nombre si numérique, booléen si `true`/`false`, string sinon
4. **Comparaison** : numérique si les deux membres sont des nombres (ou LHS coercible en nombre) ; `==`/`!=` pour les types mixtes
5. **LHS undefined → `false`** (skip-safe par défaut)

### Cas limite

- Noms de stages avec tirets : gérés en splitant sur `.output.` (première occurrence) plutôt que sur chaque `.`
- `context.input` est une string (pas un objet) → LHS `input.*` retourne `undefined` → `false`
- Chemin profond absent (`stages.foo.output.nested.missing`) → `undefined` → `false`

## Section 3 — StageExecutor early return

Inséré juste après `onStageStart` (ligne ~120), avant le chargement de l'agent :

```typescript
if (stageDef.condition !== undefined) {
  const shouldRun = evaluateCondition(stageDef.condition, {
    input: pipelineContext.input,
    stageOutputs: pipelineContext.stageOutputs,
  });
  if (!shouldRun) {
    stageRun.status = 'skipped';
    stageRun.completed_at = new Date().toISOString();
    stageRun.tasks = [];
    this.config.events?.onStageComplete?.({
      stage_name: stageDef.name, stage_index: stageIndex,
      total_stages: totalStages, status: 'skipped',
      attempts: 0, duration_ms: 0,
    });
    this.config.emitter.emit({ type: 'stage_complete', stageId: stageRunId, stageName: stageDef.name });
    return { stageRun, status: 'skipped' };
  }
}
```

`onStageStart` est émis avant le check (cohérent avec le pattern des hooks `on_stage_start`) → le CLI voit le stage dans le run avec son status.

## Section 4 — GroupOrchestrator

### Séquentiel

`skipped` est non-fatal : ne stoppe pas le groupe, ne déclenche pas de feedback loop. On track `anyStageExecuted` pour détecter le cas all-skipped :

```typescript
let anyStageExecuted = false;
// dans la boucle :
if (result.status !== 'skipped') anyStageExecuted = true;

// à la branche groupSucceeded :
const groupStatus = anyStageExecuted ? 'success' : 'skipped';
```

### Parallèle

Après collecte des résultats, un check supplémentaire :

```typescript
const allSkipped = group.stages.every(s => resultMap.get(s.name)?.status === 'skipped');
if (allSkipped) groupStatus = 'skipped';
```

### engine.ts — aucun changement

Un groupe avec `status: 'skipped'` n'est pas dans la liste `failed | rejected | cancelled` → le pipeline continue naturellement.

## Section 5 — Tests

- `engine/src/pipeline/condition-evaluator.test.ts` — tests unitaires :
  - Namespace `input.*` : objet, string, champ manquant
  - Namespace `stages.*.output.*` : champ présent, absent, stage manquant, nom avec tirets
  - Les 8 opérateurs
  - Coercition numérique
  - Undefined → false
- Test d'intégration dans les tests engine existants : pipeline avec un stage conditionnel qui se skips

## Invariants respectés

- INV-04 : le engine est domain-agnostic — la condition est une string opaque évaluée dynamiquement, aucune logique métier codée en dur
- `contracts` est un leaf package — `condition` est un champ typé sans logique
- `ralph` ne connaît pas les conditions — le check est avant le RALPH loop, pas dedans
- Zéro nouvelle dépendance
