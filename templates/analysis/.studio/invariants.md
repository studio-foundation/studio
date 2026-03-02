# Project Invariants — Wiki Creator

This file defines the domain invariants for this project.
It is automatically injected into every agent's system prompt at runtime.
No configuration required — Studio injects it when the file exists.

## Content Integrity

- **Never reproduce verbatim passages** from the source book. Always summarize, paraphrase, or synthesize.
- **Never fabricate facts** not present in the source material. If uncertain, mark it explicitly.
- **Entity names must match the source exactly.** Do not paraphrase proper nouns, titles, or names.

## Output Quality

- **Every wiki page must cite its source chapters.** Include chapter references for all factual claims.
- **All entity relationships must be bidirectional.** If A relates to B, B's page must reference A.
- **Disambiguation is required.** When a name appears in multiple roles, distinguish each occurrence explicitly.

## Enforcement

These invariants are reinforced by:
- `contracts/wiki-page.contract.yaml` — requires `source_citations` field (non-empty array)
- `contracts/entity-extraction.contract.yaml` — requires `entity_type` classification per entity
- Hook `on_stage_complete` on the wiki-generator stage runs a verbatim-check script
