# @studio/anonymizer

Bibliothèque de détection et anonymisation de PII. Remplace les données sensibles par des tokens avant envoi au LLM, avec keymap pour restaurer les valeurs originales.

## Concept

`anonymize(text)` → `{ text: "Hi [PERSON_1]...", keymap: { "PERSON_1": "Marie" } }`
`deanonymize(text, keymap)` → texte original restauré.

Même valeur → même token, au sein d'un appel et entre appels si `seedKeymap` fourni.

## Règles

- **ZERO dépendance `@studio/*`** — bibliothèque pure, réutilisable hors de Studio
- Stateless : `Tokenizer` créé à chaque appel (ou seedé via `seedKeymap`)
- Détection en 2 phases : regex haute précision (email, phone, SSN, credit card) + noms via patterns de salutation (best-effort)
- La détection de personnes est non-fatale — silencieusement skippée sur erreur
- Les spans sont non-overlapping : premier match gagne, position marquée occupée

## Fichiers clés

- `index.ts` — `anonymize(text, options?)`, `deanonymize(text, keymap)`, exports publics
- `detector.ts` — `detectPII(text)` : détection regex + noms par salutation
- `tokenizer.ts` — `Tokenizer` : génération et résolution de tokens séquentiels
- `types.ts` — `PIICategory`, `PIISpan`, `PIIDetectionResult`, `AnonymizerOptions`

## Catégories PII

`person` → `PERSON_N`, `email` → `EMAIL_N`, `phone` → `PHONE_N`,
`ssn` → `SSN_N`, `credit_card` → `CREDIT_CARD_N`, `address` → `ADDRESS_N` (réservé)

## Intégration dans Studio

Utilisé par `runner/src/middleware/anonymization.ts` (`AnonymizationMiddleware`).
Activé via `--anonymize` sur `studio run` ou `anonymize: true` dans l'agent YAML.
Keymap persisté dans `.studio/runs/anonymization/<run-id>.keymap.json`.

## Dépendances

Aucune `@studio/*`. Bibliothèque autonome.
