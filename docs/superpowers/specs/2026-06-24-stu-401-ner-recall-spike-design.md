# STU-401 — NER recall bake-off (model-selection spike)

**Status:** Design approved
**Date:** 2026-06-24
**Linear:** [STU-401](https://linear.app/studioag/issue/STU-401/provider-ner-pour-la-detection-de-noms-en-texte-libre-fr-prerequis)
**Related:** STU-397 (`DetectionProvider` + RegexDetector, merged), STU-393 (policy→fields), STU-325/326 (deployment)
**Placement:** `research/ner-eval/` — a top-level sibling directory, **outside the 7 published packages**. No TS kernel changes.

## What this iteration is (and is not)

STU-401 is a sizable deployment prerequisite: a NER provider for detecting person
names in free-text French (lowercase, no salutation), the kind that appears in real
parent emails. The full ticket spans model choice, transport, deployment topology
(incl. the resource-constrained Pi secondary), composition with the regex detector,
and false-positive measurement on a real corpus.

**This iteration delivers exactly one decision: which model.** It is a **recall-only
bake-off** of three candidate NER tools on a *hard synthetic French corpus*, producing
a documented recommendation.

### In scope

- A **deterministic, committed** hard synthetic FR corpus (slot-injection) with exact
  gold-standard name spans.
- Three model runners — **Presidio**, **spaCy-FR**, **GLiNER** — each mapping native
  output to person-typed spans.
- A scorer computing **per-model, per-bucket recall** (global + hardness buckets).
- `results.md`: the numbers + a model recommendation + the standing FP gate.

### Out of scope (deferred, named here so they are not forgotten)

- **The TS `NerProvider`** implementing `DetectionProvider` and its transport
  (HTTP / subprocess). Not wired this iteration.
- **Deployment topology** — Pi-secondary muscle question, central service vs per-node,
  degraded fallback.
- **Composition mode** with `RegexDetector` (additive vs replace for `person`).
- **False-positive-rate measurement.** See next section — this is a deliberate,
  principled exclusion, not an oversight.

## Why recall-only, and why synthetic is honest for recall but not for FP

The corpus exists to measure **recall** = of the real names present, how many does each
model catch. Recall is measurable from data we generate, because **we know exactly where
we put the names** (the gold spans are an output of construction, not a measurement).

**False positives cannot be honestly measured on a synthetic corpus.** An FP is the model
seeing a name where there is none — structure we never authored. You cannot synthetically
generate the FPs you don't anticipate; that is nearly the definition of a blind spot. Real
FPs come from messy real language: sport vocabulary, tournament/venue names, Québécois
place names, sport terms. We will not invent those faithfully.

**Therefore FP measurement remains a deployment gate**, performed later in *observation
mode* (run the chosen detector over a real sample from the target context, count FPs, deploy nothing) before
any live processing of third-party / minor data. `results.md` carries this as a standing
section so the spike's "recall looks great" can never be mistaken for "safe to deploy."

> Note on word-like names (below): a model that aces "rose-the-person" by aggressively
> tagging every "rose" is buying recall with future false positives. So even this recall-only
> spike surfaces **FP risk signal** via the word-like / surname-collision buckets — without
> claiming to measure FP rate.

## Kernel-purity (acceptance criterion satisfied by location)

STU-401 requires "no Python runtime added to the kernel nor to the `npm i -g` distribution."
This is satisfied **by placement, not by constraining the plugin's language**: NER lives in
the community-plugin space, external to the kernel by construction ("the kernel owns the
mechanism, detection is an external plugin"). `research/ner-eval/` is a top-level sibling of
the 7 packages; npm publishes only the package dirs, so the Python harness is never in the
distribution. The plugin may be Python freely — it is external by location.

## Corpus: slot-injection, deterministic, committed

**Principle: a benchmark corpus is an artifact, not a process.** The corpus is committed and
*fixed*; all three models see byte-identical text; the comparison is replayable when models
change or are tuned. The generator is committed too, so the artifact is **regenerable
identically with zero external dependency** (offline, on the Pi, in CI).

### Construction

- **Name bank** — must reflect the **onomastic diversity of a multiethnic Québec youth-sport
  context**, not only QC-franco linguistic traps. Loaded with:
  - **word-like / collision** first names: Rose, Pierre, Olive, …
  - **surname collisions** (name *and* common word, more treacherous): Roy, Côté, Boucher,
    Berger, Lévesque (e.g. "Côté" vs "à côté").
  - **hyphenated compounds** (ubiquitous in QC, esp. kids): Marie-Pier, Jean-François,
    Pierre-Luc, Anne-Sophie.
  - **diminutives / familiar forms** (the actual register of a parent email): "p'tit Jeff",
    Max (Maxime), Ben.
  - **non-old-stock-franco names spanning the communities present in a multiethnic Québec
    youth-sport context.** The origin mix is a **names-based reading of the target context**
    (which onomastic origins actually appear in the mail), used only to decide *which origins to
    cover* — never as test data. We generate **synthetic equivalent names** per origin. **Never a
    real name, never a minor's name** in the corpus. Origins to span (at minimum): QC-franco,
    Romanian, Hispanic,
    francophone African, **anglophone/West African**, **East Asian** (incl. Vietnamese), South
    Asian, Haitian, and **Middle Eastern / Arabic** (generously loaded — see below). **Every
    origin gets a measurement floor of ~30 cases**, with franco & arabic raised to ~50–60 for a
    realistic shape — see the methodology note on instrument-vs-sample.

> **Methodology — name origin ≠ appearance; the corpus measures, it doesn't represent.** Two
> cautions on how the target context feeds the bank:
> 1. **You cannot infer a name's origin from a person's appearance**, and the NER never sees the
>    person anyway — it sees only the email text. What matters is the distribution of *names*
>    arriving in the inbox — a **names-based reading of the target context**, not impressions from
>    photos. Arabic is loaded because that names-based signal says so, which is the reliable kind.
> 2. **A test corpus is a measuring instrument, not a representative sample.** Corpus *shape* and
>    corpus *measurement power* are different goals. The target population is genuinely franco-heavy
>    with Middle-Eastern second, so franco-first + arabic-second is the right **shape** — but you
>    must not infer "rare in the population → rare in the corpus": those names *will* arrive in the
>    inbox, and one minority child's name leaking to an LLM is still a leak. Per-origin recall must
>    be **statistically readable for every origin regardless of its rarity**. Hence a
>    **two-layer rule**: a realistic hierarchy on top (**franco & arabic ~50–60 each**) plus a
>    **measurement floor underneath (~30 cases for *every* origin**, including the rare ones).
>    Raise the minority floor without lowering the dominant groups. Case count is driven by a
>    **per-origin target**, not by how many names happen to be in each origin's list.
  - **Middle Eastern / Arabic — a major origin, generously loaded, with its own structural
    traps.** A names-based reading of the target context says **Middle Eastern is a major group**
    — and it is the most sensitive one: minors, girls, an already over-surveilled community, names
    arriving in parent emails. A detector that specifically fails here is the most ethically
    problematic leak, and **a model weak on this group is disqualified regardless of its franco
    recall.** The bank must represent the structures NERs particularly miss:
    - **`al-`/`el-` prefixes** (synthetic: Al-Rashid, El-Amin) — a hyphen/particle split trap,
      the QC-compound problem aggravated; cross-tagged `hyphenated`.
    - **particle compounds** (multi-token given+family forms).
    - **multiple transliterations of the same name as distinct surfaces** (Mohammed / Muhammad /
      Mohamed; Yousef / Youssef / Yusuf) — recall is per-surface, not per-name, so each variant
      must appear and be measured.
- **Frame bank** — a *large* set of varied free-text sentence frames with `{NAME}` slots,
  including no-salutation and possessive structures ("la mère de {NAME}", "{NAME} sera pas là
  demain", "mon fils {NAME}", FR with bits of English).
- **Slot-injection** — fill slots programmatically. Because we place the names, **gold offsets
  are exact by construction** — zero annotation, zero drift. (LLM self-annotation was rejected:
  LLMs reason in tokens not bytes, so self-reported char offsets shift/hallucinate — measuring
  a ruler with an elastic ruler.)
- **Seeded programmatic roughener** — applied to **connective prose only, never to name
  slots**: seeded typo injection, oral Québécois contractions (pis, fak), varied lengths.
  Seeded RNG → byte-identical output every run. **Offsets re-verified after roughening**
  (any case whose name span no longer matches its recorded text is dropped — a fail-loud
  guard, not silent).

> Realism note: connective-prose realism is secondary to **name hardness** (case, word-likeness,
> structure) — that is what actually tests the NER. A programmatic roughener captures the realism
> that matters; an LLM pass was rejected as corpus-engineering beyond a throwaway spike's need,
> and because it costs determinism for marginal gain on the dimension that counts least.

### Outputs (committed)

- `corpus.jsonl` — `{ "id": str, "text": str }`
- `gold.jsonl` — `{ "id": str, "spans": [{ "start": int, "end": int, "buckets": [str] }] }`

## Hardness buckets — the decisive signal

Recall is reported **per bucket, not just global.** A model at 90% global but 40% on
word-like names is disqualified for a youth-sport population full of kids — and only per-bucket reporting
surfaces that. Each gold span carries one or more buckets:

| Bucket | What it traps |
|---|---|
| `lowercase` | name not capitalized ("marie sera pas là") |
| `word_like` | first name colliding with a common word (Rose, Pierre, Olive) |
| `surname_collision` | surname that is also a common word (Côté, Roy, Boucher) |
| `hyphenated` | compound hyphenated name (Marie-Pier, Jean-François) |
| `diminutif` | familiar/diminutive form (p'tit Jeff, Max, Ben) |
| `no_salutation` | name in free text, no "Bonjour X" cue |
| `multi_token` | two+ space-separated tokens (first + last name) |
| `possessive` | relational structure ("la mère de X") |
| `typo_adjacent` | roughened/typo'd context around the name |
| `english_mixed` | FR text with English fragments |
| `name_origin_diverse` | non-old-stock-franco names (Vietnamese, South Asian, Arabic, West African, Haitian, Latino) — the multiethnic Québec youth-sport population, where NER bias and leak sensitivity are highest |

## Model runners

Three adapters, each reads `corpus.jsonl`, writes `predictions.<model>.jsonl`
(`{ "id": str, "spans": [{ "start", "end" }] }`), mapping native output → **person** spans:

| Model | Person label mapped | Notes |
|---|---|---|
| **Presidio** | `PERSON` | spaCy FR backend; recognizer framework |
| **spaCy-FR** | `PER` | `fr_core_news_lg`; optionally CamemBERT via `spacy-transformers` |
| **GLiNER** | (zero-shot labels we pass) | multilingual; **label string is a tested variable** |

**GLiNER label sweep:** GLiNER is zero-shot — the label string materially moves recall. The
runner sweeps a small label set (e.g. `personne`, `nom de personne`, `prénom`) and reports the
**best-performing label** rather than fixing one arbitrarily. The winning label is recorded in
`results.md`.

Model/library versions are **pinned** in `research/ner-eval/requirements.txt`. The runners are
heavy (torch/transformers) and **dev-machine-only**; the corpus generator and scorer are
stdlib-light and run anywhere (incl. the Pi).

## Scoring

**Primary metric — overlap-lenient recall.** A gold span counts as recalled iff some predicted
person-span **overlaps it by ≥1 char**. Lenient overlap is correct here because models disagree
on multi-token name boundaries, and for this use-case what matters is *did the model see a name was
there* — tokenizing a char short/long is recoverable; missing the name entirely is the leak.

**Secondary column — exact-match recall** (gold span == predicted span exactly).

**Derived metric — boundary-leak risk on `hyphenated`.** Overlap-lenient recall can *mask* a real
leak: if a model detects "Pier" in "Marie-Pier" (≥1 char overlap → counted recalled) but
anonymization only tokenizes "Pier", then "Marie-" ships to the LLM in cleartext. Recall says ✓,
PII partially leaks. So `results.md` computes and surfaces the **(overlap − exact) gap on the
`hyphenated` bucket** as an explicit boundary-leak-risk indicator — not left for a human to eyeball.
This does not change the primary metric (still overlap-lenient for model *choice*); it keeps model
choice and deployment safety as two distinct questions.

Recall = recalled gold spans / total gold spans, computed **global + per-bucket + per-model**, for
both overlap and exact.

**Per-origin recall (a second axis, distinct from hardness buckets).** Onomastic origin is a
separate dimension from hardness: "weak on Romanian names" is a different failure than "weak on
word-like names," and conflating them hides it. Each gold span therefore carries an `origin`
(`franco`, `romanian`, `hispanic`, `african_franco`, `african_anglo`, `east_asian`,
`vietnamese`, `south_asian`, `arabic`, `haitian`), and recall is reported **per origin group**
in addition to per bucket. A model
strong on franco names but weak on Romanian/African/**Arabic** names is **as disqualifying for
this use-case as one weak on word-like names** — and only the per-origin table surfaces that gap.
(`name_origin_diverse` remains the umbrella *hardness* bucket = "any non-franco name"; the `origin`
axis is the finer breakdown within it.) **The `arabic` origin group is the highest-stakes row in
the per-origin table** — `results.md` calls it out explicitly, and a model weak on it is rejected
regardless of global recall.

## Deliverable: `research/ner-eval/results.md`

- Per-model **global recall** (overlap primary, exact secondary).
- The **per-bucket recall table** (all three models × 11 buckets).
- The **per-origin recall table** (all three models × origin groups).
- The **boundary-leak-risk** figure on `hyphenated`.
- The winning **GLiNER label**.
- Qualitative failure notes (which buckets each model fails).
- **The recommendation** (which model, and why).
- A standing **"FP measurement remains a deployment gate"** section: what real-corpus
  observation-mode looks like, and that it blocks live third-party/minor-data processing.

## Proposed file layout

```
research/ner-eval/
├── README.md                 # how to run (venv, generate, run models, score)
├── requirements.txt          # pinned: presidio-analyzer, spacy + fr_core_news_lg, gliner, ...
├── .gitignore                # venv/, model caches
├── names.py                  # the hard name bank (+ bucket tags per name)
├── frames.py                 # the frame bank (+ structure bucket tags)
├── generate_corpus.py        # slot-injection + seeded roughener → corpus.jsonl, gold.jsonl
├── corpus.jsonl              # committed artifact
├── gold.jsonl                # committed artifact
├── runners/
│   ├── run_presidio.py
│   ├── run_spacy.py
│   └── run_gliner.py         # sweeps the label set
├── score.py                  # overlap + exact, global + per-bucket, boundary-leak gap
└── results.md                # the deliverable
```

## Acceptance for this spike

- [ ] `generate_corpus.py` is deterministic (seeded): two runs produce byte-identical
      `corpus.jsonl` / `gold.jsonl`; the roughener never moves a name slot; post-roughen
      offset re-verification passes (no silently dropped/shifted spans).
- [ ] Corpus includes every hardness bucket, with the QC trap names generously represented
      (word-like, surname-collision, hyphenated, diminutif) **and the target population's onomastic
      diversity represented as synthetic equivalents**. **Two-layer distribution: every origin
      meets a ~30-case measurement floor; franco & arabic raised to ~50–60 for a realistic
      shape** (franco / Romanian / Hispanic / francophone-African / anglophone-African / East-Asian /
      Vietnamese / South-Asian / Haitian / Middle-Eastern-Arabic). Arabic also carries its
      structural traps (`al-`/`el-` prefixes, particle compounds, multiple transliterations of the
      same name as distinct surfaces). No real names; no minors' names.
- [ ] Every gold span carries an `origin`; `score.py` and `results.md` report **per-origin
      recall** as a distinct axis from the hardness buckets, with the `arabic` group called out
      explicitly as highest-stakes.
- [ ] All three runners produce `predictions.<model>.jsonl` mapped to person spans; GLiNER
      sweeps the label set and the winning label is recorded.
- [ ] `score.py` reports per-model, per-bucket recall (overlap primary, exact secondary) and
      the `hyphenated` boundary-leak gap.
- [ ] `results.md` contains the numbers and a clear model recommendation.
- [ ] `results.md` documents that **real-corpus FP measurement remains a gate** before
      deployment.
- [ ] No change to any of the 7 packages; nothing added to the `npm i -g` distribution.
