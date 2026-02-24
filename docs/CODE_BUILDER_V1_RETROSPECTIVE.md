# Code Builder v1 — Rétrospective

> Document produit le 2026-02-23, suite à la validation en production.
> Runs analysés : 6 runs, du premier test jusqu'au premier succès sur le repo Studio lui-même.

---

## Ce qui a fonctionné

### Le kernel tient

RALPH, les groups, les contracts, la state machine — tout ça a tenu sous des conditions réelles. Le pipeline a itéré, retryé, et convergé de manière déterministe. Aucun crash d'architecture, aucune violation d'invariant.

Le pipeline `feature-builder` a tourné end-to-end sur le repo Studio lui-même (STU-122), en passant par Linear → fetch → analyse → plan → code → QA → PR → close-ticket. C'est le critère de succès défini depuis le début.

### L'anti-théâtre fonctionne

Le contrat `code-generation` avec `tool_calls.minimum: 1` et `required_tools: [repo_manager-write_file]` a détecté et rejeté les stages qui prétendaient avoir écrit du code sans l'avoir fait. Sur un run, le coder s'est pris un `EISDIR` (lecture d'un dossier), s'est auto-corrigé au deuxième attempt via RALPH. Aucune intervention manuelle.

### La séparation agent/kernel est solide

Switcher de `gpt-4o-mini` à `gpt-4o` sur le publisher a réglé les problèmes de workflow conditionnel (`git-checkout` en boucle) sans toucher une ligne de code kernel. Switcher vers Claude sur le coder a immédiatement amélioré la qualité du code produit. L'orchestration est agnostic — les agents sont vraiment interchangeables.

### Le model `feature-builder-cc-linear`

Pipeline méta : Linear → Claude Code comme coder → PR → close-ticket. Coût de run drastiquement réduit par rapport au pipeline LLM standard. Utile pour le développement quotidien de Studio lui-même.

---

## Ce qui n'a pas fonctionné

### `group_feedback` vide — STU-129

Le bug le plus sérieux. Le `rejection_details` du QA ne se rend jamais dans le contexte du coder à l'itération suivante. Le coder itère en aveugle, corrige par tâtonnement en relisant le fichier lui-même plutôt que par feedback structuré. Le mécanisme de group retry existe mais est inopérant côté transmission de contexte.

Conséquence : 3 iterations pour régler des issues qui auraient dû être corrigées en 1 si le feedback se rendait.

### Le contract `qa-review` mal structuré

Le reviewer listait tous les critères dans `issues`, y compris ceux qui passaient, avec des descriptions qui confirmaient leur succès. La contrainte `array_not_empty → rejected` déclenchait donc un rejet systématique même sur du code correct. Fix : retirer `issues` des `required_fields`, ajouter une règle explicite dans le system prompt ("list only failing criteria").

### Le publisher sous-dimensionné (`gpt-4o-mini`)

`gpt-4o-mini` incapable de suivre des instructions conditionnelles complexes (vérifier la branche courante avant de `git-checkout`). Appelait `git-checkout` 3-4 fois par run, dont plusieurs erreurs "branche existe déjà". Fix : passage à `gpt-4o` pour le publisher.

### Tokens `publish-changes` : 43 744 en pic

`all_stage_tool_results` dans le contexte du publisher incluait le contenu brut de tous les fichiers lus et écrits par le pipeline. Le publisher n'a pas besoin de ça — il a besoin des summaries. Fix : remplacer par `all_stage_outputs`. Résultat : 43 744 → 8 698 tokens (-80%).

### `close-ticket` failed sur le premier run de production

Probablement un tool ou provider mal configuré. S'est réglé au run suivant sans investigation approfondie. À surveiller.

---

## Ajustements appliqués en cours de session

| Problème | Fix | Impact |
|---|---|---|
| Publisher appelle `git-checkout` en boucle | `gpt-4o-mini` → `gpt-4o` sur publisher | Workflow git propre en 1 shot |
| 43k tokens sur publish-changes | `all_stage_tool_results` → `all_stage_outputs` | -80% tokens publisher |
| QA approuve avec issues valides dans la liste | Retirer `issues` de `required_fields`, règle explicite dans system prompt | QA issues actionnables uniquement |
| analyst fait QA et analyse (deux rôles) | Séparation analyst / reviewer (agent dédié) | QA plus strict et prévisible |
| Coder relit le fichier que les stages précédents ont déjà lu | Instruction explicite dans system prompt coder | Réduction des read_file redondants |
| Nom de branche non-unique en mode test | `date +%Y%m%d-%H%M` injecté via `on_pipeline_start` | Branches traçables et uniques |

---

## Métriques

### Runs analysés

| Run | Pipeline | Status | Duration | Total tokens | Group iterations |
|---|---|---|---|---|---|
| 8bbd0ec8 | feature-builder | rejected | 110s | 62 998 | 3/3 (épuisé) |
| caa1e5a1 | feature-builder | success | 88s | 66 983 | 1/3 |
| 4f02b95d | feature-builder | success | 62s | 31 661 | 1/3 |
| 6ee6999b | feature-builder | success | 160s | 76 614 | 3/3 (corrigé) |
| 791317db | feature-builder-from-linear | success | 93s | 110 248 | 1/3 |

### Tokens par stage (run stable, 4f02b95d)

| Stage | Prompt tokens |
|---|---|
| brief-analysis | 2 712 |
| implementation-plan | 4 261 |
| code-generation | 9 420 |
| qa-review | 4 188 |
| publish-changes | 8 696 |
| **Total** | **31 661** |

### Coût estimé (claude-sonnet sur run 791317db, 110k tokens)

~$0.35 USD par feature. Acceptable pour du développement, à optimiser pour de l'usage intensif.

---

## Issues ouvertes à l'issue de la session

| ID | Titre | Priorité |
|---|---|---|
| STU-125 | Ajouter `required_tool_groups` dans ToolCallRequirements (OR sémantique) | High |
| STU-126 | Implémenter `validateToolGroups` dans ralph | High |
| STU-127 | Logger le context pack à chaque stage_start (debug observabilité) | High |
| STU-129 | `group_feedback` vide dans le contexte du coder après rejet QA | **Urgent** |

STU-129 est le bug le plus critique pour la fiabilité du pipeline. STU-127 est le prérequis pour le confirmer et le debugger proprement.

---

## Ce qui est stable et lockable

- Architecture kernel : engine, ralph, runner, contracts — aucune modification nécessaire
- RALPH loop et state machine — déterministes, fiables
- Anti-théâtre detection — fonctionne sur les runs réels
- Structure `.studio/` et résolution de config — aucun problème
- `on_pipeline_start` pour l'injection de contexte dynamique — propre
- Lifecycle hooks — non testés intensivement mais stables en théorie
- Pipeline `feature-builder` (hors `group_feedback` bug)
- Pipeline `feature-builder-cc-linear` — stable, utile pour le dev quotidien

---

## Ce qui est nécessaire avant d'élargir

**Avant plus d'utilisateurs :**
- STU-129 réglé — `group_feedback` doit se rendre au coder
- STU-127 implémenté — observabilité minimum pour debugger en production

**Avant plus de pipelines :**
- Templates validés (`studio init --template software` doit produire un projet fonctionnel out-of-the-box)
- STU-125 / STU-126 pour la flexibilité des contracts

**Ce qui peut attendre :**
- Optimisation tokens (acceptable pour l'instant)
- Tool `git-checkout` gérant nativement la branche existante (workaround system prompt suffisant)

---

## Verdict

Code Builder v1 est validé en production. Le kernel tient. Les agents sont interchangeables. Le pipeline end-to-end depuis Linear jusqu'à une PR sur le repo Studio lui-même fonctionne.

Le chemin critique restant avant un usage quotidien fiable : STU-129 (`group_feedback`) et STU-127 (observabilité). Tout le reste est de l'amélioration incrémentale.