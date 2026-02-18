# @studio/cli

Interface terminal pour Studio. Thin wrapper sur engine.

## Règles

- ZERO logique métier — tout est dans engine
- Pretty output pour humains, JSON pour machines (--json flag)
- Commandes simples et évidentes
- Dépend de @studio/contracts et @studio/engine (PAS de ralph/runner direct)

## Fichiers clés

- `commands/run.ts` — studio run <pipeline> [--input "..."]
- `commands/validate.ts` — studio validate <contract> <output>
- `commands/list.ts` — studio list pipelines|agents|runs
- `commands/status.ts` — studio status [run-id]
- `commands/init.ts` — studio init (setup nouveau projet)
- `output/` — formatter, logger, progress bar

## Usage

```bash
$ studio run feature-builder --input "Add FAQ to About page"
$ studio status last
$ studio list runs --failed
```
