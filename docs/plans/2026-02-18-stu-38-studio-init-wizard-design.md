# STU-38 — `studio init` Wizard Design (Phase 1)

**Date:** 2026-02-18
**Issue:** [STU-38](https://linear.app/studioag/issue/STU-38)
**Package:** `@studio-foundation/cli`

---

## Objective

Replace the current non-interactive `studio init` with a step-by-step wizard using `@inquirer/prompts`. Phase 1 is wizard-only. Direct mode with flags is Phase 2.

---

## Approach

**Approach A — Wizard in-place.** Rewrite `initCommand` in `cli/src/commands/init.ts`. `createStudioStructure()` remains untouched (already tested). After structure creation, the wizard writes the provider config with `js-yaml`. No new files.

---

## Wizard Flow

```
$ studio init

  ╭─────────────────────────────────╮
  │  Studio — Pipeline Creator      │
  ╰─────────────────────────────────╯

Step 1: input   Project name
                Default: current folder name
                Guard: empty input falls back to folder name (no empty project)

Step 2: input   Description (optional, wizard-only)
                Placeholder: "e.g., AI-powered code generation for my project"
                Press Enter to skip — value is never persisted

Step 3: select  Template
                Choices built dynamically from listTemplates()
                Each choice: "<metadata.name> — <metadata.description>"

Step 4: select  LLM Provider
                ❯ Anthropic (Claude)
                  OpenAI (GPT)
                  Configure later

Step 5: [if provider selected] password  API Key
                Format validation only (no network call):
                  Anthropic → /^sk-ant-/
                  OpenAI    → /^sk-/
                Invalid format → inquirer validation error, re-prompt same field
                Valid → ✓ Valid shown by inquirer

Step 6: ora spinner "Creating project..."
                → createStudioStructure(cwd, projectName, templateName)
                → if provider + key: writeProviderToConfig(studioDir, provider, key)
                → if "configure later": config.yaml keeps env-var template unchanged

Step 7: Success output
                ✓ .studio/config.yaml
                ✓ .studio/projects/<name>/
                ✓ Copied template files
                ✓ Updated .gitignore

Step 8: Next steps
                Done! Run your first pipeline:
                  $ studio run <name>/<first-pipeline-name> --input "..."
```

---

## Config Write Logic

`writeProviderToConfig(studioDir, provider, apiKey)`:

1. Read existing `.studio/config.yaml` (created by `createStudioStructure`)
2. Parse with `js-yaml.load()`
3. Set `providers.<provider>.apiKey = apiKey` (literal value)
4. Set `defaults.provider = provider`
5. Set `defaults.model`:
   - Anthropic → `claude-sonnet-4-20250514`
   - OpenAI → `gpt-4o`
6. Write back with `js-yaml.dump()` — **comments are lost**, accepted for Phase 1

**"Configure later":** nothing written. `config.yaml` keeps the env-var references from the template.

---

## API Key Validation

Format-only, no network call:

| Provider  | Regex     | Notes |
|-----------|-----------|-------|
| Anthropic | `/^sk-ant-/` | Covers all key generations (api01, api02, api03…) |
| OpenAI    | `/^sk-/`  | Standard OpenAI key prefix |

If invalid: `@inquirer/prompts` validation callback returns an error string, re-prompts same field.

---

## Files Changed

| File | Change |
|------|--------|
| `cli/package.json` | Add `@inquirer/prompts` to dependencies |
| `cli/src/commands/init.ts` | Replace `initCommand`; add `validateApiKeyFormat`, `writeProviderToConfig` helpers |
| `cli/tests/commands/init.test.ts` | Add tests for `validateApiKeyFormat` + `writeProviderToConfig`; existing tests unchanged |

No other packages touched.

---

## Out of Scope (Phase 2)

- `--template`, `--project`, `--provider` flags as direct mode
- `--force` flag
- Detecting existing `.studio/` with migration suggestions
- Tools selection wizard
