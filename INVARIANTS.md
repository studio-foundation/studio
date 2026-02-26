# INVARIANTS.md — Studio v7

Contrats non-négociables sur le comportement du système. Ces invariants sont
enforced par le code (types TypeScript, structure de packages, dépendances) — ce
fichier les rend explicites pour les humains et les agents IA.

**Règle d'or :** Si tu vois du code qui viole un de ces invariants, c'est une
erreur d'architecture, pas une exception acceptable.

---

## INV-01 — `contracts` est un leaf package

**Description :** `@studio/contracts` n'a aucune dépendance interne vers d'autres
packages `@studio/*`. Zéro. Aucune exception.

**Enforcé par :** [`contracts/package.json`](contracts/package.json) — la section
`dependencies` ne contient aucun `@studio/*`.

**Ce qui casse si violé :** Dépendance circulaire. `ralph`, `runner`, et `engine`
importent tous `contracts` — si `contracts` importe l'un d'eux, le graphe de
dépendances devient un cycle. Tout le système s'effondre à l'initialisation.

---

## INV-02 — `ralph` ne connaît pas `runner`

**Description :** `ralph` prend un `executor: (context: ExecutionContext) =>
Promise<T>` générique. Il ne sait pas que `T` sera un `AgentRunResult`. Il ne
connaît pas les LLMs, les providers, ni les tools.

**Enforcé par :** [`ralph/src/loop.ts`](ralph/src/loop.ts) — `RalphConfig<T>` est
un type générique paramétré. [`ralph/package.json`](ralph/package.json) — dépend
uniquement de `@studio/contracts`, pas de `@studio/runner`.

**Ce qui casse si violé :** `ralph` devient couplé à une implémentation concrète.
Il ne peut plus être testé sans un vrai LLM. La séparation entre "boucle de retry"
et "exécution LLM" disparaît — le retry logic devient impossible à réutiliser pour
d'autres executors.

---

## INV-03 — `runner` n'exécute que, ni valide ni retry

**Description :** `runner.runAgent()` appelle le LLM, collecte le résultat, et
retourne un `AgentRunResult`. Il ne valide pas le format de l'output. Il ne lance
pas de retry. Il retourne immédiatement après l'appel LLM.

**Enforcé par :** [`runner/src/runner.ts`](runner/src/runner.ts) — aucune
référence à `ValidationResult`, aucune boucle de retry. La validation et le retry
sont exclusivement dans `ralph`.

**Ce qui casse si violé :** Double validation (runner + ralph), comportements
contradictoires, et impossibilité de distinguer "format invalide" de "LLM error".
Le pipeline de responsabilités `execute → validate → retry` devient ambigu.

---

## INV-04 — `engine` est domain-agnostic

**Description :** Le engine ne contient aucune référence à des concepts métier :
"code", "git", "QA", "feature", "bug". `StageKind` est défini comme `string` —
une valeur libre. L'engine ne branche jamais sur la valeur de `stage.kind`.

**Enforcé par :** [`contracts/src/stage.ts`](contracts/src/stage.ts) — `kind:
string`. [`engine/src/engine.ts`](engine/src/engine.ts) — `stage_kind` passé au
runner comme métadonnée opaque, jamais utilisé dans la logique du engine.

**Ce qui casse si violé :** Le engine devient un framework pour un domaine
spécifique. Les pipelines d'autres domaines (legal, médical, analytique) ne
peuvent plus l'utiliser sans modifier le core. La YAML-first architecture
s'effondre — le comportement est dans le code, pas dans les configs.

---

## INV-05 — Les tools sont dans `runner`, pas dans `engine`

**Description :** Le registry de tools, le plugin loader, et l'exécuteur de tools
résident dans `runner/src/tools/`. L'engine passe les configurations au runner,
mais ne charge, n'instancie, et ne connaît aucun tool spécifique (ni
`repo_manager-write_file`, ni `shell-run_command`).

**Enforcé par :** [`runner/src/tools/`](runner/src/tools/) — contient
`tool-registry.ts`, `tool-executor.ts`, `plugin-loader.ts`. L'engine n'a pas de
dossier `tools/`.

**Ce qui casse si violé :** L'engine devient dépendant d'implémentations concrètes
de tools. Ajouter un tool nécessite de modifier le engine. La séparation
orchestration/exécution disparaît.

---

## INV-06 — Les prompts sont dans `runner`, pas dans `engine`

**Description :** `prompt-builder.ts` vit dans `runner/src/`. C'est lui qui
assemble le system prompt, les contraintes du contract, les snippets des tool
plugins, et le contexte de retry. L'engine ne construit aucun prompt.

**Enforcé par :** [`runner/src/prompt-builder.ts`](runner/src/prompt-builder.ts)
— unique point d'assemblage des prompts. Aucun fichier `prompt-builder.ts` dans
`engine/`.

**Ce qui casse si violé :** La logique de prompt devient éparpillée entre engine
et runner. Le context propagation, les tool snippets, et les instructions de retry
ne sont plus cohérentes. Impossible de changer le format de prompt sans toucher
plusieurs packages.

---

## INV-07 — La state machine est déterministe

**Description :** `deriveStageStatus(ralphResult)` mappe directement et
exhaustivement le résultat RALPH au status du stage. Pas de logique conditionnelle
sur le contenu de l'output. `ralph 'success' → stage 'success'`, `ralph
'exhausted' → stage 'failed'`, `ralph 'cancelled' → stage 'cancelled'`. Rien
d'autre.

**Enforcé par :**
[`engine/src/state/status-derivation.ts`](engine/src/state/status-derivation.ts)
— mapping exhaustif + `throw` si état inconnu. `RalphResult` est une union
discriminée avec 3 états : `success | exhausted | cancelled`.

**Ce qui casse si violé :** C'était le bug #1 en v6 — le status du stage ne
correspondait pas au résultat du task. En v7, cette fonction est le contrat unique
entre ralph et engine. Si elle devient non-déterministe (branchement sur output
content, états intermédiaires), le pipeline devient imprévisible.

---

## INV-08 — La validation est binaire : pass ou fail

**Description :** `ValidationResult` a un champ `valid: boolean`. Un output est
valide ou invalide, rien entre les deux. Les warnings existent mais ne changent
pas le résultat — un output avec warnings mais `valid: true` est accepté.

**Enforcé par :** [`contracts/src/validation.ts`](contracts/src/validation.ts) —
`ValidationResult.valid: boolean`. Tous les validateurs dans
[`runner/src/`](runner/src/) retournent cette interface.

**Ce qui casse si violé :** Si la validation devient un score ou un gradient, la
logique de retry dans ralph cesse de fonctionner. Le seuil d'acceptation devient
arbitraire et configurable — source de bugs et de comportements surprenants.

---

## INV-09 — Un projet est 100% autonome dans son dossier

**Description :** Tout ce qui concerne un projet (pipelines, agents, contracts,
tools) vit dans `.studio/projects/<projet>/`. Aucun projet ne référence les
configs d'un autre projet. Les loaders sont scopés par dossier projet.

**Enforcé par :** [`engine/src/engine.ts`](engine/src/engine.ts) —
`resolveProjectPaths()` dérive tous les chemins depuis `<configsDir>/<project>/`.
Chaque loader (`loadPipelineByName`, `loadAgentProfile`, `loadContract`,
`loadProjectTools`) prend un répertoire scoped et ne sort jamais de ce scope.

**Ce qui casse si violé :** Les projets s'entremêlent. Modifier les configs d'un
projet peut affecter un autre. Le concept de projet comme unité isolée et
déployable disparaît — impossible de partager un projet entre équipes sans
partager l'ensemble des configs.

---

## INV-10 — Le graphe de dépendances est un DAG strict

**Description :** Les dépendances entre packages forment un graphe acyclique
dirigé (DAG). L'ordre est : `(contracts, anonymizer)` → `(ralph, runner)` →
`engine` → `cli`. Aucune dépendance en sens inverse. `ralph` et `runner` sont
frères — aucun ne connaît l'autre. `anonymizer` est un co-leaf avec `contracts` :
il dépend uniquement de `@redactpii/node` (externe), pas d'un quelconque package
`@studio/*`.

**Enforcé par :** Les `package.json` de chaque package définissent les
dépendances. `pnpm` détecte les cycles à l'install. À vérifier via :

```bash
cat contracts/package.json   # dependencies: {} (aucune dépendance interne)
cat anonymizer/package.json  # dependencies: { "@redactpii/node": ... } (externe uniquement)
cat ralph/package.json       # dependencies: { "@studio/contracts": "workspace:*" }
cat runner/package.json      # dependencies: { "@studio/contracts": "workspace:*", "@studio/anonymizer": "workspace:*" }
cat engine/package.json      # dependencies: { "@studio/ralph": ..., "@studio/runner": ..., "@studio/contracts": ... }
cat cli/package.json         # dependencies: { "@studio/engine": ..., "@studio/contracts": ..., "@studio/api": ... }
```

**Exception documentée — CLI → API :** `@studio/cli` dépend de `@studio/api`.
C'est intentionnel et non une violation du DAG. La commande `studio api start`
importe `bootstrap` depuis `@studio/api` pour démarrer le serveur HTTP directement
depuis le CLI. Cette dépendance va dans le sens du flux (cli est la couche la plus
haute) — `api` ne connaît pas `cli`. Le DAG reste acyclique.

**Ce qui casse si violé :** Dépendance circulaire → crash à l'initialisation des
modules. Ou couplage qui transforme un changement local en cascade de
modifications. L'ensemble du monorepo devient une boule de dépendances
implicites.

---

## Référence rapide

| ID | Invariant | Package(s) | Fichier clé |
|----|-----------|------------|-------------|
| INV-01 | `contracts` = leaf package | contracts | `contracts/package.json` |
| INV-02 | `ralph` ne connaît pas `runner` | ralph | `ralph/src/loop.ts` |
| INV-03 | `runner` exécute seulement | runner | `runner/src/runner.ts` |
| INV-04 | `engine` domain-agnostic | engine, contracts | `engine/src/engine.ts` |
| INV-05 | Tools dans `runner` | runner, engine | `runner/src/tools/` |
| INV-06 | Prompts dans `runner` | runner, engine | `runner/src/prompt-builder.ts` |
| INV-07 | State machine déterministe | engine, ralph | `engine/src/state/status-derivation.ts` |
| INV-08 | Validation binaire | contracts, runner | `contracts/src/validation.ts` |
| INV-09 | Projets autonomes | engine | `engine/src/engine.ts` |
| INV-10 | DAG de dépendances strict | tous | `*/package.json` |
