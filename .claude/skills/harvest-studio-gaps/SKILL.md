---
name: harvest-studio-gaps
description: Use when auditing a project built on Studio to find what Studio itself should have shipped — the orchestration, retries, caches, fan-outs and artifact checks the project had to hand-roll. Produces a kernel/plugin/won't-do verdict per finding and Linear issues on the Studio backlog. Direction is downstream project → Studio. For the opposite direction (making that project use the Studio it already has), use studio-native-migration.
---

# Harvest Studio Gaps

A project that uses Studio is the only honest test of Studio's surface. Every hack it
carries is a place the runtime made someone write code instead of YAML.

The output of this audit is a **Studio backlog**, so the bar is not "what hurt" — it is
"what changes Studio". Most friction in a downstream project is that project's own
problem, and saying so is the audit's main job.

## The rule: domain-free plumbing

One question decides whether a hack is a finding:

> Strip every noun belonging to the project's domain. Is there anything left?

| Counts | Doesn't count |
|---|---|
| `subprocess.run(["studio","run", …])` + stdout scraping — orchestration | A prompt that mishandles a book's chapter titles — domain |
| A `load_cache`/`save_cache` keyed on the input rows — resume | A cache key that has to know what a "roster row" is — domain |
| A `for` loop calling one pipeline per item — fan-out | Which items are worth fanning out over — domain |
| `if not os.path.exists(out)` after a run — artifact assertion | Which files a book build must produce — domain |
| Parsing provider session files to price a run — observability | Whether $4/book is acceptable — domain |

This is INV-04 read from the outside: the engine is domain-agnostic, so the only thing a
project may legitimately hand-roll is domain. Plumbing it hand-rolled is Studio's debt.

## 1. Get the repo

```bash
GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 <url> /home/user/<owner>/<repo>
git -C /home/user/<owner>/<repo> fetch --depth 300 origin main   # history scan needs depth
```

A private repo cannot be cloned from a session scoped to another owner. Say so and ask
for a session opened on that repo rather than auditing from memory.

## 2. Three scans

**A — glue code and `.studio/`.** The hack lives in the code *around* Studio.

```bash
grep -rnE "studio (run|replay)|subprocess|check_output" --include=*.py --include=*.ts --include=*.sh --include=Makefile .
ls .studio/pipelines .studio/contracts .studio/agents 2>/dev/null
grep -rnE "retry|attempt|backoff|cache|resume|exists\(|glob\(|ThreadPool|asyncio.gather" <glue dirs>
```

Read every orchestrator entry point end to end (the `run_*.py`, the `Makefile` target,
the CI job). Its shape *is* the finding list.

**B — git history.** The archive says what hurt and how often.

```bash
git log --oneline --grep -iE "workaround|hack|temporar|manual|because studio|studio doesn't|fallback"
git log --oneline -- <the orchestrator file>   # its churn measures the pain
```

**C — run artifacts.** What the project had to go scrape because Studio didn't hand it over.

```bash
ls .studio/runs/*.jsonl 2>/dev/null && head -1 .studio/runs/*.jsonl
grep -rn "runs/\|\.jsonl\|token" <glue dirs>   # who reads Studio's own output, and why
```

## 3. Write the finding

One record per candidate. No record without a `file:line` or a commit sha — an audit
that cannot cite is a wish list.

```
Symptom      what the project wrote
Evidence     scripts/entity_species.py:86-105, commit a1474f2
Worked around what Studio didn't do
Studio shape the named surface: a YAML key, a stage type, a flag, an event
```

"Studio should handle caching better" is not a finding. `map: resume: true`, keyed on the
resolved item input, is.

## 4. Verdict — kernel, plugin, or won't-do

**Default is plugin.** The kernel needs an argument; the marketplace does not.

- **kernel** — engine/CLI surface that is domain-free by construction (a stage key, a
  status, a contract key, a run field). For a **tool**, all three INV-11 criteria must
  hold: primitive, no domain choice, bootstrap-necessary. `git` and `search` failed this;
  so will most things.
- **plugin** — real, reusable, but carries a product or vendor opinion. Tools, triggers,
  agents, skills, whole templates.
- **won't-do** — with the reason. The three that recur:
  - *already exists* — name the key and the doc line. Hand it to **studio-native-migration**;
    it is a migration, not a gap.
  - *domain leak* — the kernel would have to learn a noun from the project's world.
  - *n=1* — one project, one shape, no second caller. Say what would change the verdict
    (a second project hitting it).

## 5. Ship it

Report in conversation first — findings grouped by verdict, won't-do included with its
reason. Then one Linear issue per kernel or plugin candidate, on the Studio team:

```
Title   the Studio surface, not the project's symptom
Body    Symptom / Evidence (repo + file:line + sha) / What Studio lacks /
        Proposed surface (the YAML or CLI shape, written out) / Verdict + why /
        What the project deletes when this ships
```

That last line is the acceptance criterion. A gap that closes without deleting glue
downstream was never the gap.

Won't-do findings stay in the report. Filing them is how a backlog stops being read.

## Not findings

- A feature Studio already has that the project didn't adopt → studio-native-migration.
- Domain logic, however ugly.
- A change that only improves this project's numbers.
- A prompt or model complaint. That is the agent's YAML, which the project owns.
