# STU-401 — NER recall bake-off harness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic Python harness that measures person-name recall of Presidio, spaCy-FR, and GLiNER on a hard synthetic French corpus, and produces a model recommendation.

**Architecture:** A self-contained `research/ner-eval/` directory (outside the 7 npm packages, kernel-purity by location). A seeded slot-injection generator emits a committed corpus + exact gold spans. Three thin model runners emit predictions. A pure scorer computes per-model, per-bucket recall (overlap-lenient primary, exact secondary) plus a hyphenated boundary-leak gap. A renderer turns it into `results.md`.

**Tech Stack:** Python 3.11+, pytest. Generator + scorer + renderer are **stdlib-only**. Runners use presidio-analyzer, spaCy (`fr_core_news_lg`), GLiNER (heavy, dev-machine-only).

## Global Constraints

- **No change to any of the 7 packages**; nothing added to the `npm i -g` distribution. All work lives under `research/ner-eval/`.
- **Generator, scorer, renderer must be stdlib-only** (run offline, on the Pi, in CI). Only the three runners may import heavy ML libs.
- **The corpus is a committed artifact**: `corpus.jsonl` + `gold.jsonl` are committed; the generator reproduces them **byte-identically** under a fixed seed.
- **Gold spans are exact by construction**; the roughener never mutates a name slot; offsets are re-verified fail-loud after roughening.
- **Recall is reported per-bucket**, not only global. 11 buckets: `lowercase`, `word_like`, `surname_collision`, `hyphenated`, `diminutif`, `no_salutation`, `multi_token`, `possessive`, `typo_adjacent`, `english_mixed`, `name_origin_diverse`.
- **Primary metric: overlap-lenient recall (≥1 char).** Secondary: exact-match. Derived: `(overlap − exact)` recall gap on the `hyphenated` bucket = boundary-leak risk.
- **FP measurement is out of scope** — `results.md` carries a standing "real-corpus FP gate" section.
- Seed is fixed: `SEED = 401`.

---

### Task 1: Scaffold + shared buckets + name bank

**Files:**
- Create: `research/ner-eval/.gitignore`
- Create: `research/ner-eval/requirements.txt`
- Create: `research/ner-eval/requirements-dev.txt`
- Create: `research/ner-eval/README.md`
- Create: `research/ner-eval/buckets.py`
- Create: `research/ner-eval/names.py`
- Test: `research/ner-eval/tests/test_names.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `buckets.BUCKETS: frozenset[str]` — the 11 canonical bucket names.
  - `names.NameEntry` — `@dataclass(frozen=True)` with `surface: str`, `buckets: tuple[str, ...]`, `origin: str`.
  - `names.ORIGINS: frozenset[str]` — the onomastic-origin axis (distinct from hardness buckets).
  - `names.NAME_BANK: list[NameEntry]`.

- [ ] **Step 1: Create directory skeleton and config files**

`research/ner-eval/.gitignore`:
```
.venv/
__pycache__/
*.pyc
predictions.*.jsonl
.cache/
```

`research/ner-eval/requirements.txt`:
```
# Heavy, dev-machine-only (model runners). Pin exact versions after first install:
#   pip install -r requirements.txt && pip freeze > requirements.lock
presidio-analyzer==2.2.355
spacy==3.7.5
gliner==0.2.13
torch
# spaCy FR model is installed separately (not on PyPI as a normal dep):
#   python -m spacy download fr_core_news_lg
```

`research/ner-eval/requirements-dev.txt`:
```
pytest==8.2.0
```

`research/ner-eval/README.md`:
```markdown
# NER recall bake-off (STU-401)

Recall-only model selection for free-text French person-name detection.
External to the Studio kernel by location — nothing here ships in `npm i -g`.

## Setup
    python -m venv .venv && source .venv/bin/activate
    pip install -r requirements-dev.txt      # generator + scorer + tests (stdlib + pytest)
    pip install -r requirements.txt          # runners only (heavy)
    python -m spacy download fr_core_news_lg  # runners only

## Run
    python generate_corpus.py                 # writes corpus.jsonl + gold.jsonl (deterministic)
    python runners/run_presidio.py            # writes predictions.presidio.jsonl
    python runners/run_spacy.py               # writes predictions.spacy.jsonl
    python runners/run_gliner.py              # writes predictions.gliner.jsonl (+ sweeps labels)
    python report.py                          # writes results.md

## Tests
    pytest -q
```

- [ ] **Step 2: Write the failing test for buckets + name bank**

`research/ner-eval/tests/test_names.py`:
```python
from buckets import BUCKETS
from names import NAME_BANK, NameEntry, ORIGINS


def test_buckets_are_the_eleven_canonical():
    assert BUCKETS == frozenset({
        "lowercase", "word_like", "surname_collision", "hyphenated",
        "diminutif", "no_salutation", "multi_token", "possessive",
        "typo_adjacent", "english_mixed", "name_origin_diverse",
    })


def test_every_name_entry_is_well_formed():
    assert NAME_BANK, "name bank must not be empty"
    for e in NAME_BANK:
        assert isinstance(e, NameEntry)
        assert e.surface.strip() == e.surface and e.surface
        assert set(e.buckets) <= BUCKETS
        assert e.origin in ORIGINS
        # origin axis and hardness umbrella must agree: non-franco <=> name_origin_diverse
        if e.origin == "franco":
            assert "name_origin_diverse" not in e.buckets
        else:
            assert "name_origin_diverse" in e.buckets, f"{e.surface} non-franco must be diverse"
        if "-" in e.surface:
            assert "hyphenated" in e.buckets, f"{e.surface} should be hyphenated"
        if " " in e.surface:
            assert "multi_token" in e.buckets, f"{e.surface} should be multi_token"


def _count(bucket):
    return sum(1 for e in NAME_BANK if bucket in e.buckets)


def _origin_count(origin):
    return sum(1 for e in NAME_BANK if e.origin == origin)


def test_trap_and_diversity_buckets_generously_represented():
    assert _count("word_like") >= 5
    assert _count("surname_collision") >= 5
    assert _count("hyphenated") >= 5
    assert _count("diminutif") >= 4
    assert _count("name_origin_diverse") >= 20  # the population most at risk — generous


def test_origins_span_the_target_distribution():
    required = {"franco", "romanian", "hispanic", "african_franco", "african_anglo",
                "east_asian", "vietnamese", "south_asian", "haitian", "arabic"}
    assert required <= ORIGINS
    # broad coverage, measurable per group — proportions don't matter for a recall spike
    for o in required:
        assert _origin_count(o) >= 3, f"origin {o} under-represented to measure"


def test_arabic_is_most_heavily_loaded_with_its_traps():
    # Middle Eastern is a major group in this context — load it, not token it.
    assert _origin_count("arabic") >= 10
    arabic = [e for e in NAME_BANK if e.origin == "arabic"]
    # al-/el- prefix trap present (cross-tagged hyphenated)
    assert any(e.surface.lower().startswith(("al-", "el-")) for e in arabic)
    # multiple transliterations of the same name as DISTINCT surfaces
    surfaces = {e.surface.lower() for e in arabic}
    assert {"mohammed", "muhammad", "mohamed"} <= surfaces
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd research/ner-eval && python -m pytest tests/test_names.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'buckets'`.

- [ ] **Step 4: Implement `buckets.py`**

`research/ner-eval/buckets.py`:
```python
"""The 11 canonical hardness buckets. Single source of truth (DRY)."""

BUCKETS = frozenset({
    "lowercase",          # name not capitalized
    "word_like",          # first name colliding with a common word (rose, pierre, olive)
    "surname_collision",  # surname that is also a common word (côté, roy, boucher)
    "hyphenated",         # compound hyphenated name (marie-pier)
    "diminutif",          # familiar/diminutive form (jeff, max, ben)
    "no_salutation",      # name in free text, no "Bonjour X" cue
    "multi_token",        # two+ space-separated tokens (first + last)
    "possessive",         # relational structure ("la mère de X")
    "typo_adjacent",      # roughened/typo'd context around the name
    "english_mixed",      # FR text with English fragments
    "name_origin_diverse",# non-old-stock-franco names (multiethnic Québec youth-sport population)
})
```

- [ ] **Step 5: Implement `names.py`**

`research/ner-eval/names.py`:
```python
"""Hard Québécois + multiethnic name bank for the recall bake-off.

Two axes per entry:
  * buckets  — *name-intrinsic* hardness (word_like, surname_collision,
    hyphenated, diminutif, multi_token, name_origin_diverse). Frame- and
    injection-intrinsic buckets (lowercase, possessive, no_salutation,
    english_mixed, typo_adjacent) are added later in the pipeline.
  * origin   — onomastic origin group (franco, romanian, hispanic,
    african_franco, african_anglo, east_asian, vietnamese, south_asian,
    haitian, arabic). Reported as a SEPARATE axis: "weak on Arabic names" is a
    different failure than "weak on word-like names". Non-franco entries also
    carry the name_origin_diverse umbrella bucket.

All names are SYNTHETIC and invented. The origin mix reflects a generic
multiethnic Québec youth-sport context (Arabic is a major group; the rest are
plausible large Québec urban communities) — a names-based reading of the target
context, never appearance-based (the NER sees text, not people). Coverage is
DIRECTIONAL (broad) with a per-origin measurement floor — see generate_corpus.
Never a real name, never a minor's name.
"""
from dataclasses import dataclass

ORIGINS = frozenset({
    "franco", "romanian", "hispanic", "african_franco", "african_anglo",
    "east_asian", "vietnamese", "south_asian", "haitian", "arabic",
})


@dataclass(frozen=True)
class NameEntry:
    surface: str
    buckets: tuple[str, ...]
    origin: str


def _n(surface: str, *buckets: str, origin: str = "franco") -> NameEntry:
    # non-franco names automatically carry the name_origin_diverse umbrella bucket
    bset = set(buckets)
    if origin != "franco":
        bset.add("name_origin_diverse")
    return NameEntry(surface=surface, buckets=tuple(sorted(bset)), origin=origin)


NAME_BANK: list[NameEntry] = [
    # --- QC-franco hardness traps -------------------------------------------
    # word_like first names (collide with a common word)
    _n("Rose", "word_like"), _n("Pierre", "word_like"), _n("Olive", "word_like"),
    _n("Lys", "word_like"), _n("Claire", "word_like"), _n("Aurore", "word_like"),
    # surname collisions (name AND common word — "à côté")
    _n("Côté", "surname_collision"), _n("Roy", "surname_collision"),
    _n("Boucher", "surname_collision"), _n("Berger", "surname_collision"),
    _n("Lévesque", "surname_collision"), _n("Charron", "surname_collision"),
    # hyphenated compounds (ubiquitous in QC, esp. kids)
    _n("Marie-Pier", "hyphenated"), _n("Jean-François", "hyphenated"),
    _n("Pierre-Luc", "hyphenated"), _n("Anne-Sophie", "hyphenated"),
    _n("Marie-Ève", "hyphenated"), _n("Louis-Philippe", "hyphenated"),
    # diminutives / familiar forms (the register of a parent email)
    _n("Jeff", "diminutif"), _n("Max", "diminutif"),
    _n("Ben", "diminutif"), _n("Steph", "diminutif"), _n("Fred", "diminutif"),
    # plain old-stock first names (baseline)
    _n("Thomas"), _n("Jacqueline"), _n("Marie"), _n("Gabriel"),
    # multi_token (first + last)
    _n("Marie Tremblay", "multi_token"), _n("Luc Gagnon", "multi_token"),

    # --- Arabic / Middle Eastern — MOST HEAVILY LOADED (major group in this context) --
    # al-/el- prefix trap (cross-tagged hyphenated, the QC-compound problem aggravated)
    _n("Al-Rashid", "hyphenated", origin="arabic"),
    _n("El-Amin", "hyphenated", origin="arabic"),
    _n("Al-Sayed", "hyphenated", origin="arabic"),
    _n("El-Masri", "hyphenated", origin="arabic"),
    # multiple transliterations of the SAME name as distinct surfaces
    _n("Mohammed", origin="arabic"), _n("Muhammad", origin="arabic"),
    _n("Mohamed", origin="arabic"),
    _n("Yousef", origin="arabic"), _n("Youssef", origin="arabic"),
    _n("Yusuf", origin="arabic"),
    # particle compound (multi_token given + family)
    _n("Layla Haddad", "multi_token", origin="arabic"),
    _n("Karim Nasser", "multi_token", origin="arabic"),
    # common given names
    _n("Fatima", origin="arabic"), _n("Aisha", origin="arabic"),
    _n("Omar", origin="arabic"), _n("Nour", origin="arabic"),

    # --- other origins present in a multiethnic Québec context --------------
    # Romanian
    _n("Popescu", origin="romanian"), _n("Ionescu", origin="romanian"),
    _n("Andrei", origin="romanian"), _n("Ioana", origin="romanian"),
    # Hispanic
    _n("Gómez", origin="hispanic"), _n("Morales", origin="hispanic"),
    _n("Mateo", origin="hispanic"), _n("Valentina", origin="hispanic"),
    # francophone African
    _n("Traoré", origin="african_franco"), _n("Koné", origin="african_franco"),
    _n("Aminata", origin="african_franco"), _n("Mamadou", origin="african_franco"),
    # anglophone / West African
    _n("Okonkwo", origin="african_anglo"), _n("Adeyemi", origin="african_anglo"),
    _n("Mensah", origin="african_anglo"), _n("Boateng", origin="african_anglo"),
    # East Asian (Chinese / Korean forms)
    _n("Chen", origin="east_asian"), _n("Wang", origin="east_asian"),
    _n("Kim", origin="east_asian"), _n("Park", origin="east_asian"),
    # Vietnamese
    _n("Nguyen", origin="vietnamese"), _n("Tran", origin="vietnamese"),
    _n("Thanh", origin="vietnamese"),
    # South Asian
    _n("Patel", origin="south_asian"), _n("Singh", origin="south_asian"),
    _n("Ayesha", origin="south_asian"),
    # Haitian
    _n("Jean-Baptiste", "hyphenated", origin="haitian"),
    _n("Pierre-Louis", "hyphenated", origin="haitian"),
    _n("Saint-Fleur", "hyphenated", origin="haitian"),
]
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd research/ner-eval && python -m pytest tests/test_names.py -q`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
cd research/ner-eval
git add .gitignore requirements.txt requirements-dev.txt README.md buckets.py names.py tests/test_names.py
git commit -m "feat(ner-eval): scaffold + buckets + hard name bank (STU-401)"
```

---

### Task 2: Frame bank

**Files:**
- Create: `research/ner-eval/frames.py`
- Test: `research/ner-eval/tests/test_frames.py`

**Interfaces:**
- Consumes: `buckets.BUCKETS`.
- Produces:
  - `frames.Frame` — `@dataclass(frozen=True)` with `template: str`, `buckets: tuple[str, ...]`.
  - `frames.FRAME_BANK: list[Frame]`. Each `template` contains one or more `{name}` placeholders.

- [ ] **Step 1: Write the failing test**

`research/ner-eval/tests/test_frames.py`:
```python
from buckets import BUCKETS
from frames import FRAME_BANK, Frame


def test_every_frame_well_formed():
    assert FRAME_BANK
    for f in FRAME_BANK:
        assert isinstance(f, Frame)
        assert "{name}" in f.template, f"frame missing slot: {f.template!r}"
        assert set(f.buckets) <= BUCKETS
        # frame-intrinsic buckets only — never name-intrinsic ones
        assert not (set(f.buckets) & {"word_like", "hyphenated", "diminutif",
                                      "surname_collision", "name_origin_diverse"})


def _has(bucket):
    return any(bucket in f.buckets for f in FRAME_BANK)


def test_key_structures_present():
    assert _has("possessive")      # "la mère de {name}"
    assert _has("english_mixed")
    # most free-text frames carry no_salutation
    assert sum(1 for f in FRAME_BANK if "no_salutation" in f.buckets) >= 5
    assert len(FRAME_BANK) >= 12   # enough variety so the corpus isn't robotic
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd research/ner-eval && python -m pytest tests/test_frames.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'frames'`.

- [ ] **Step 3: Implement `frames.py`**

`research/ner-eval/frames.py`:
```python
"""Free-text sentence frames with {name} slots. Buckets are frame-intrinsic
(no_salutation, possessive, english_mixed) — name-intrinsic buckets are added
by the name, casing/typos by the pipeline."""
from dataclasses import dataclass


@dataclass(frozen=True)
class Frame:
    template: str
    buckets: tuple[str, ...]


def _f(template: str, *buckets: str) -> Frame:
    return Frame(template=template, buckets=tuple(buckets))


FRAME_BANK: list[Frame] = [
    _f("je vous écris pour dire que {name} ne sera pas au cours aujourd'hui", "no_salutation"),
    _f("{name} sera pas là demain, elle est malade", "no_salutation"),
    _f("la mère de {name} vous remercie pour la saison", "no_salutation", "possessive"),
    _f("le père de {name} va venir le chercher après la pratique", "no_salutation", "possessive"),
    _f("mon fils {name} a oublié son chandail au gymnase", "no_salutation", "possessive"),
    _f("ma fille {name} adore son sport cette année", "no_salutation", "possessive"),
    _f("est-ce que {name} peut manquer le tournoi de samedi", "no_salutation"),
    _f("{name} et son équipe ont bien joué en fin de semaine", "no_salutation"),
    _f("merci de prévenir {name} pour le changement d'horaire", "no_salutation"),
    _f("just so you know, {name} will miss practice tonight", "no_salutation", "english_mixed"),
    _f("{name} is feeling sick, elle reste à la maison aujourd'hui", "no_salutation", "english_mixed"),
    _f("on va inscrire {name} au camp d'été cette année", "no_salutation"),
    _f("pouvez-vous confirmer la place de {name} dans l'équipe", "no_salutation", "possessive"),
    _f("l'entraîneur a parlé à {name} après le match", "no_salutation"),
]
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd research/ner-eval && python -m pytest tests/test_frames.py -q`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd research/ner-eval
git add frames.py tests/test_frames.py
git commit -m "feat(ner-eval): free-text frame bank with slot placeholders"
```

---

### Task 3: Slot-injection core (exact offsets)

**Files:**
- Create: `research/ner-eval/corpus_types.py`
- Create: `research/ner-eval/inject.py`
- Test: `research/ner-eval/tests/test_inject.py`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `corpus_types.Span` — `@dataclass(frozen=True)` `start: int`, `end: int`, `buckets: tuple[str, ...]`.
  - `inject.Filler` — `@dataclass(frozen=True)` `surface: str`, `buckets: tuple[str, ...]`.
  - `inject.inject(template: str, fillers: list[Filler]) -> tuple[str, list[Span]]`.
    Replaces each successive `{name}` in `template` with the next filler's surface,
    returning the filled text and one `Span` per filler with exact `[start, end)` offsets
    such that `text[start:end] == filler.surface`. Span buckets = the filler's buckets.
    Raises `ValueError` if placeholder count != filler count.

- [ ] **Step 1: Write the failing test**

`research/ner-eval/tests/test_inject.py`:
```python
import pytest
from inject import inject, Filler


def test_single_slot_exact_offsets():
    text, spans = inject("{name} sera pas là", [Filler("rose", ("word_like", "lowercase"))])
    assert text == "rose sera pas là"
    assert len(spans) == 1
    s = spans[0]
    assert text[s.start:s.end] == "rose"
    assert s.start == 0 and s.end == 4
    assert set(s.buckets) == {"word_like", "lowercase"}


def test_multi_slot_offsets_independent():
    text, spans = inject(
        "{name} et {name} jouent",
        [Filler("marie", ("lowercase",)), Filler("Côté", ("surname_collision",))],
    )
    assert text == "marie et Côté jouent"
    assert [text[s.start:s.end] for s in spans] == ["marie", "Côté"]


def test_mismatched_placeholders_raise():
    with pytest.raises(ValueError):
        inject("{name} and {name}", [Filler("x", ())])
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd research/ner-eval && python -m pytest tests/test_inject.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'inject'`.

- [ ] **Step 3: Implement `corpus_types.py` and `inject.py`**

`research/ner-eval/corpus_types.py`:
```python
from dataclasses import dataclass


@dataclass(frozen=True)
class Span:
    start: int
    end: int
    buckets: tuple[str, ...]
```

`research/ner-eval/inject.py`:
```python
"""Slot-injection: fill {name} placeholders, compute exact gold offsets."""
from dataclasses import dataclass
from corpus_types import Span

PLACEHOLDER = "{name}"


@dataclass(frozen=True)
class Filler:
    surface: str
    buckets: tuple[str, ...]


def inject(template: str, fillers: list[Filler]) -> tuple[str, list[Span]]:
    if template.count(PLACEHOLDER) != len(fillers):
        raise ValueError(
            f"placeholder count {template.count(PLACEHOLDER)} != fillers {len(fillers)}"
        )
    out: list[str] = []
    spans: list[Span] = []
    cursor = 0          # length of text built so far (== next char offset)
    rest = template
    for filler in fillers:
        head, rest = rest.split(PLACEHOLDER, 1)
        out.append(head)
        cursor += len(head)
        start = cursor
        out.append(filler.surface)
        cursor += len(filler.surface)
        spans.append(Span(start=start, end=cursor, buckets=filler.buckets))
    out.append(rest)
    return "".join(out), spans
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd research/ner-eval && python -m pytest tests/test_inject.py -q`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd research/ner-eval
git add corpus_types.py inject.py tests/test_inject.py
git commit -m "feat(ner-eval): slot-injection with exact gold offsets"
```

---

### Task 4: Seeded roughener (segment-based, fail-loud)

**Files:**
- Create: `research/ner-eval/roughen.py`
- Test: `research/ner-eval/tests/test_roughen.py`

**Interfaces:**
- Consumes: `corpus_types.Span`.
- Produces:
  - `roughen.roughen(text: str, spans: list[Span], rng: random.Random) -> tuple[str, list[Span]]`.
    Mutates only the *free* segments between protected name spans (seeded typos + oral
    Québécois contractions); never alters a span's surface. Returns roughened text and spans
    with recomputed offsets such that `new_text[s.start:s.end]` equals the original surface for
    every span. Adds `"typo_adjacent"` to a span's buckets when an adjacent free segment was
    modified. Raises `AssertionError` if any span surface fails to round-trip (fail-loud).

- [ ] **Step 1: Write the failing test**

`research/ner-eval/tests/test_roughen.py`:
```python
import random
from corpus_types import Span
from roughen import roughen


def _names(text, spans):
    return [text[s.start:s.end] for s in spans]


def test_determinism_same_seed_identical():
    text = "je vous écris pour dire que rose ne sera pas la aujourd'hui"
    spans = [Span(28, 32, ("word_like",))]
    a = roughen(text, list(spans), random.Random(401))
    b = roughen(text, list(spans), random.Random(401))
    assert a == b


def test_name_surface_never_mutated_and_offsets_exact():
    text = "la mere de marie-pier vous remercie beaucoup pour la belle saison"
    # "marie-pier" starts at index 11
    assert text[11:21] == "marie-pier"
    spans = [Span(11, 21, ("hyphenated",))]
    new_text, new_spans = roughen(text, spans, random.Random(7))
    assert _names(new_text, new_spans) == ["marie-pier"]  # surface intact, offsets exact


def test_typo_adjacent_bucket_added_when_context_changes():
    text = "je vous ecris pour dire que rose ne sera pas la"
    spans = [Span(28, 32, ("word_like",))]
    # use a seed known to mutate; loop a few seeds to find one that changes text
    for seed in range(50):
        new_text, new_spans = roughen(text, list(spans), random.Random(seed))
        if new_text != text:
            assert "typo_adjacent" in new_spans[0].buckets
            return
    raise AssertionError("no seed mutated the text; roughener too inert")
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd research/ner-eval && python -m pytest tests/test_roughen.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'roughen'`.

- [ ] **Step 3: Implement `roughen.py`**

`research/ner-eval/roughen.py`:
```python
"""Seeded roughener. Operates ONLY on free segments between protected name
spans, so a name's surface and the gold offsets stay exact. Deterministic
given the rng. Fail-loud: asserts every span round-trips after reassembly."""
import random
from corpus_types import Span

# oral Québécois rewrites applied to whole free segments (deterministic order)
_ORAL = [("puis ", "pis "), ("ne sera pas", "sera pas"), ("aujourd'hui", "ajd")]


def _roughen_segment(seg: str, rng: random.Random) -> str:
    out = seg
    for a, b in _ORAL:
        if a in out and rng.random() < 0.5:
            out = out.replace(a, b, 1)
    # single seeded typo: drop one accent-free interior char on a long-enough word
    if len(out) > 6 and rng.random() < 0.4:
        i = rng.randrange(1, len(out) - 1)
        if out[i].isalpha() and out[i] not in "éèêàùçô":
            out = out[:i] + out[i + 1:]
    return out


def roughen(text: str, spans: list[Span], rng: random.Random) -> tuple[str, list[Span]]:
    ordered = sorted(spans, key=lambda s: s.start)
    surfaces = [text[s.start:s.end] for s in ordered]

    # split into alternating free / protected segments
    pieces: list[tuple[str, bool]] = []   # (segment, is_protected)
    cursor = 0
    for s in ordered:
        pieces.append((text[cursor:s.start], False))
        pieces.append((text[s.start:s.end], True))
        cursor = s.end
    pieces.append((text[cursor:], False))

    # roughen free pieces; remember which changed
    new_pieces: list[str] = []
    changed: list[bool] = []
    for seg, protected in pieces:
        if protected:
            new_pieces.append(seg)
            changed.append(False)
        else:
            r = _roughen_segment(seg, rng)
            new_pieces.append(r)
            changed.append(r != seg)

    new_text = "".join(new_pieces)

    # recompute span offsets from new piece lengths; add typo_adjacent if a
    # neighbouring free piece changed
    new_spans: list[Span] = []
    offset = 0
    span_idx = 0
    for i, (seg, protected) in enumerate(pieces):
        if protected:
            start = offset
            end = offset + len(new_pieces[i])
            left_changed = i > 0 and changed[i - 1]
            right_changed = i + 1 < len(pieces) and changed[i + 1]
            buckets = ordered[span_idx].buckets
            if (left_changed or right_changed) and "typo_adjacent" not in buckets:
                buckets = buckets + ("typo_adjacent",)
            assert new_text[start:end] == surfaces[span_idx], "name surface drifted"
            new_spans.append(Span(start=start, end=end, buckets=buckets))
            span_idx += 1
        offset += len(new_pieces[i])

    return new_text, new_spans
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd research/ner-eval && python -m pytest tests/test_roughen.py -q`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd research/ner-eval
git add roughen.py tests/test_roughen.py
git commit -m "feat(ner-eval): seeded segment-based roughener with fail-loud offset check"
```

---

### Task 5: Corpus assembly CLI + committed artifacts

**Files:**
- Create: `research/ner-eval/generate_corpus.py`
- Create (generated, committed): `research/ner-eval/corpus.jsonl`, `research/ner-eval/gold.jsonl`
- Test: `research/ner-eval/tests/test_generate_corpus.py`

**Interfaces:**
- Consumes: `names.NAME_BANK`, `frames.FRAME_BANK`, `inject.inject/Filler`, `roughen.roughen`, `corpus_types.Span`, `buckets.BUCKETS`.
- Produces:
  - `generate_corpus.build_cases(seed: int) -> list[dict]` — deterministic list of
    `{"id": str, "text": str, "spans": [{"start","end","buckets","origin"}]}`.
  - `generate_corpus.SEED = 401`.
  - `generate_corpus.main()` — writes `corpus.jsonl` (`{id,text}`) and `gold.jsonl`
    (`{id,spans}`) with one JSON object per line, `ensure_ascii=False`, trailing newline.

- [ ] **Step 1: Write the failing test**

`research/ner-eval/tests/test_generate_corpus.py`:
```python
from buckets import BUCKETS
from generate_corpus import build_cases, SEED


def test_deterministic_byte_identical():
    a = build_cases(SEED)
    b = build_cases(SEED)
    assert a == b


def test_every_gold_span_exact_and_bucketed():
    for case in build_cases(SEED):
        for sp in case["spans"]:
            assert sp["end"] > sp["start"]
            surface = case["text"][sp["start"]:sp["end"]]
            assert surface.strip() == surface and surface
            assert sp["buckets"], "every span must carry >=1 bucket"
            assert set(sp["buckets"]) <= BUCKETS


def test_all_eleven_buckets_present():
    seen = set()
    for case in build_cases(SEED):
        for sp in case["spans"]:
            seen.update(sp["buckets"])
    assert seen == BUCKETS, f"missing buckets: {BUCKETS - seen}"


def test_diversity_generously_represented():
    n = sum(
        1 for c in build_cases(SEED) for sp in c["spans"]
        if "name_origin_diverse" in sp["buckets"]
    )
    assert n >= 20


def test_every_origin_meets_measurement_floor():
    origins = {}
    for c in build_cases(SEED):
        for sp in c["spans"]:
            assert sp.get("origin"), "every gold span must carry an origin"
            origins[sp["origin"]] = origins.get(sp["origin"], 0) + 1
    required = {"franco", "romanian", "hispanic", "african_franco", "african_anglo",
                "east_asian", "vietnamese", "south_asian", "haitian", "arabic"}
    assert required <= set(origins)
    # measurement floor: per-origin recall must be statistically readable for
    # EVERY origin, even rare groups — a rare name still leaks if missed. The
    # corpus measures the detector, it does not represent the target population.
    for o in required:
        assert origins[o] >= 30, f"origin {o} below the ~30-case measurement floor"
    # realistic hierarchy on top: franco & arabic dominate the target population,
    # and are the two largest groups in the corpus (shape correct, floor honored).
    assert origins["franco"] >= 50 and origins["arabic"] >= 50
    minorities = max(origins[o] for o in required if o not in ("franco", "arabic"))
    assert origins["franco"] >= minorities and origins["arabic"] >= minorities
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd research/ner-eval && python -m pytest tests/test_generate_corpus.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'generate_corpus'`.

- [ ] **Step 3: Implement `generate_corpus.py`**

`research/ner-eval/generate_corpus.py`:
```python
"""Deterministic hard-corpus generator. Generates a per-origin target number of
cases (name x frame x casing), applies seeded roughening, emits exact gold spans.

Corpus shape vs measurement power are two different goals. A test corpus is a
*measuring instrument*, not a representative sample: a name rare in the target
population still leaks to the LLM if the detector misses it, so per-origin recall
must be statistically readable for EVERY origin regardless of its rarity. Hence a
two-layer rule: a realistic hierarchy on top (franco & arabic dominate, matching
the target population) plus a measurement FLOOR underneath (every origin gets
>= FLOOR cases). Case count is therefore driven by a per-origin target, NOT by
how many names happen to be in each origin's name list.

A benchmark corpus is an artifact, not a process: same SEED -> byte-identical
output. Generator + scorer are stdlib-only (run anywhere, incl. the Pi)."""
import json
import random

from names import NAME_BANK
from frames import FRAME_BANK
from inject import inject, Filler
from roughen import roughen

SEED = 401
DOMINANT_ORIGINS = ("franco", "arabic")   # the target population's largest groups
DOMINANT_CASES = 55                        # realistic hierarchy on top
FLOOR_CASES = 30                           # measurement floor for every other origin


def _names_by_origin() -> dict[str, list]:
    by: dict[str, list] = {}
    for entry in NAME_BANK:
        by.setdefault(entry.origin, []).append(entry)
    return by


def build_cases(seed: int) -> list[dict]:
    rng = random.Random(seed)
    by_origin = _names_by_origin()
    cases: list[dict] = []
    cid = 0
    for origin in sorted(by_origin):                       # deterministic order
        names = by_origin[origin]
        target = DOMINANT_CASES if origin in DOMINANT_ORIGINS else FLOOR_CASES
        for i in range(target):
            entry = names[i % len(names)]                  # cycle: even name coverage
            frame = rng.choice(FRAME_BANK)
            # lowercase the name ~60% of the time (parent-email register)
            lower = rng.random() < 0.6
            surface = entry.surface.lower() if lower else entry.surface
            buckets = entry.buckets + frame.buckets + (("lowercase",) if lower else ())
            text, spans = inject(frame.template, [Filler(surface, buckets)])
            text, spans = roughen(text, spans, rng)
            # single-slot cases: the one span's origin is this entry's origin
            cases.append({
                "id": f"c{cid:04d}",
                "text": text,
                "spans": [
                    {"start": s.start, "end": s.end,
                     "buckets": sorted(set(s.buckets)), "origin": entry.origin}
                    for s in spans
                ],
            })
            cid += 1
    return cases


def main() -> None:
    cases = build_cases(SEED)
    with open("corpus.jsonl", "w", encoding="utf-8") as f:
        for c in cases:
            f.write(json.dumps({"id": c["id"], "text": c["text"]}, ensure_ascii=False) + "\n")
    with open("gold.jsonl", "w", encoding="utf-8") as f:
        for c in cases:
            f.write(json.dumps({"id": c["id"], "spans": c["spans"]}, ensure_ascii=False) + "\n")
    print(f"wrote {len(cases)} cases to corpus.jsonl + gold.jsonl")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd research/ner-eval && python -m pytest tests/test_generate_corpus.py -q`
Expected: PASS (4 tests). If `test_all_eleven_buckets_present` fails, add frames/names covering the missing bucket until it passes (the test is the spec's "every bucket present" guarantee).

- [ ] **Step 5: Generate and commit the artifacts**

Run: `cd research/ner-eval && python generate_corpus.py`
Expected output: `wrote N cases to corpus.jsonl + gold.jsonl`.

```bash
cd research/ner-eval
git add generate_corpus.py tests/test_generate_corpus.py corpus.jsonl gold.jsonl
git commit -m "feat(ner-eval): deterministic corpus generator + committed corpus/gold artifacts"
```

---

### Task 6: Scorer (overlap/exact, per-bucket, boundary-leak gap)

**Files:**
- Create: `research/ner-eval/score.py`
- Test: `research/ner-eval/tests/test_score.py`

**Interfaces:**
- Consumes: nothing (operates on plain dicts so it never imports model output types).
- Produces:
  - `score.overlaps(g: dict, p: dict) -> bool` — true iff `[g.start,g.end)` and `[p.start,p.end)` share ≥1 char.
  - `score.exact(g: dict, p: dict) -> bool` — true iff identical start and end.
  - `score.load_jsonl(path: str) -> dict[str, dict]` — id → record.
  - `score.recall(gold_cases, pred_cases, match) -> dict` — returns
    `{"global": {"overlap": float, "exact": float},`
    ` "per_bucket": {bucket: {"overlap": float, "exact": float, "n": int}},`
    ` "per_origin": {origin: {"overlap": float, "exact": float, "n": int}},`
    ` "boundary_leak_hyphenated": float}`.
    `gold_cases`: `{id: {"spans":[{start,end,buckets,origin}]}}`. `pred_cases`: `{id: {"spans":[{start,end}]}}`.

- [ ] **Step 1: Write the failing test**

`research/ner-eval/tests/test_score.py`:
```python
from score import overlaps, exact, recall


def test_overlap_vs_exact():
    g = {"start": 0, "end": 10}
    assert overlaps(g, {"start": 9, "end": 12})    # 1-char overlap
    assert not overlaps(g, {"start": 10, "end": 12})  # touching, no shared char
    assert exact(g, {"start": 0, "end": 10})
    assert not exact(g, {"start": 0, "end": 9})


def test_recall_global_per_bucket_and_per_origin():
    gold = {
        "c0": {"spans": [{"start": 0, "end": 4, "buckets": ["hyphenated"], "origin": "arabic"}]},
        "c1": {"spans": [{"start": 0, "end": 3, "buckets": ["lowercase"], "origin": "franco"}]},
    }
    pred = {
        "c0": {"spans": [{"start": 0, "end": 2}]},   # overlaps but not exact (boundary leak)
        "c1": {"spans": []},                          # missed entirely
    }
    r = recall(gold, pred, None)
    assert r["global"]["overlap"] == 0.5     # 1 of 2 names seen
    assert r["global"]["exact"] == 0.0       # neither exactly matched
    assert r["per_bucket"]["hyphenated"]["overlap"] == 1.0
    assert r["per_bucket"]["hyphenated"]["exact"] == 0.0
    assert r["boundary_leak_hyphenated"] == 1.0   # overlap(1.0) - exact(0.0)
    # per-origin axis: arabic name seen (overlap), franco name missed
    assert r["per_origin"]["arabic"]["overlap"] == 1.0
    assert r["per_origin"]["franco"]["overlap"] == 0.0
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd research/ner-eval && python -m pytest tests/test_score.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'score'`.

- [ ] **Step 3: Implement `score.py`**

`research/ner-eval/score.py`:
```python
"""Recall scorer. Overlap-lenient primary, exact secondary; per-bucket; plus the
hyphenated boundary-leak gap (overlap - exact). Pure, stdlib-only."""
import json


def overlaps(g: dict, p: dict) -> bool:
    return g["start"] < p["end"] and p["start"] < g["end"]


def exact(g: dict, p: dict) -> bool:
    return g["start"] == p["start"] and g["end"] == p["end"]


def load_jsonl(path: str) -> dict[str, dict]:
    out: dict[str, dict] = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rec = json.loads(line)
                out[rec["id"]] = rec
    return out


def _hit(gold_span: dict, preds: list[dict], match) -> bool:
    return any(match(gold_span, p) for p in preds)


def _agg(table: dict, key: str, ov: bool, ex: bool) -> None:
    slot = table.setdefault(key, {"ov": 0, "ex": 0, "n": 0})
    slot["ov"] += ov
    slot["ex"] += ex
    slot["n"] += 1


def recall(gold_cases: dict, pred_cases: dict, _unused=None) -> dict:
    g_ov = g_ex = total = 0
    buckets: dict[str, dict] = {}
    origins: dict[str, dict] = {}
    for cid, gcase in gold_cases.items():
        preds = pred_cases.get(cid, {}).get("spans", [])
        for gs in gcase["spans"]:
            total += 1
            ov = _hit(gs, preds, overlaps)
            ex = _hit(gs, preds, exact)
            g_ov += ov
            g_ex += ex
            for b in gs.get("buckets", []):
                _agg(buckets, b, ov, ex)
            if gs.get("origin"):
                _agg(origins, gs["origin"], ov, ex)

    def ratio(hit, n):
        return round(hit / n, 4) if n else 0.0

    def summarize(table):
        return {
            k: {"overlap": ratio(s["ov"], s["n"]), "exact": ratio(s["ex"], s["n"]), "n": s["n"]}
            for k, s in sorted(table.items())
        }

    per_bucket = summarize(buckets)
    hyph = per_bucket.get("hyphenated", {"overlap": 0.0, "exact": 0.0})
    return {
        "global": {"overlap": ratio(g_ov, total), "exact": ratio(g_ex, total)},
        "per_bucket": per_bucket,
        "per_origin": summarize(origins),
        "boundary_leak_hyphenated": round(hyph["overlap"] - hyph["exact"], 4),
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd research/ner-eval && python -m pytest tests/test_score.py -q`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd research/ner-eval
git add score.py tests/test_score.py
git commit -m "feat(ner-eval): recall scorer with per-bucket + boundary-leak gap"
```

---

### Task 7: Runner mapping helpers + GLiNER label selection (pure)

**Files:**
- Create: `research/ner-eval/runners/__init__.py`
- Create: `research/ner-eval/runners/mapping.py`
- Test: `research/ner-eval/tests/test_mapping.py`

**Interfaces:**
- Consumes: `score.recall` (for label selection).
- Produces:
  - `runners.mapping.map_presidio(results: list) -> list[dict]` — keep `entity_type == "PERSON"`, return `{start,end}` (presidio result objects expose `.entity_type`, `.start`, `.end`).
  - `runners.mapping.map_spacy(ents: list) -> list[dict]` — keep `label_ == "PER"`, return `{start,end}` (spaCy ents expose `.label_`, `.start_char`, `.end_char`).
  - `runners.mapping.map_gliner(entities: list[dict]) -> list[dict]` — GLiNER returns dicts with `start`/`end`; pass through as `{start,end}`.
  - `runners.mapping.select_best_label(gold_cases: dict, preds_by_label: dict[str, dict]) -> tuple[str, float]` — returns the label whose predictions maximize **global overlap recall**, and that recall.

- [ ] **Step 1: Write the failing test**

`research/ner-eval/tests/test_mapping.py`:
```python
from runners.mapping import map_presidio, map_spacy, map_gliner, select_best_label


class _Obj:
    def __init__(self, **kw):
        self.__dict__.update(kw)


def test_map_presidio_keeps_person_only():
    res = [_Obj(entity_type="PERSON", start=0, end=4),
           _Obj(entity_type="LOCATION", start=5, end=9)]
    assert map_presidio(res) == [{"start": 0, "end": 4}]


def test_map_spacy_keeps_per_only():
    ents = [_Obj(label_="PER", start_char=2, end_char=7),
            _Obj(label_="MISC", start_char=8, end_char=10)]
    assert map_spacy(ents) == [{"start": 2, "end": 7}]


def test_map_gliner_passthrough():
    ents = [{"start": 1, "end": 5, "label": "personne", "text": "rose"}]
    assert map_gliner(ents) == [{"start": 1, "end": 5}]


def test_select_best_label_picks_higher_recall():
    gold = {"c0": {"spans": [{"start": 0, "end": 4, "buckets": ["x"]}]}}
    preds_by_label = {
        "prénom": {"c0": {"spans": []}},                       # recall 0
        "personne": {"c0": {"spans": [{"start": 0, "end": 4}]}},# recall 1
    }
    label, rec = select_best_label(gold, preds_by_label)
    assert label == "personne" and rec == 1.0
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd research/ner-eval && python -m pytest tests/test_mapping.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'runners'`.

- [ ] **Step 3: Implement the package files**

`research/ner-eval/runners/__init__.py`:
```python
```

`research/ner-eval/runners/mapping.py`:
```python
"""Pure native-output -> person-span mappers, plus GLiNER label selection.
Kept import-free of heavy ML libs so it is unit-testable with fakes."""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from score import recall  # noqa: E402


def map_presidio(results: list) -> list[dict]:
    return [{"start": r.start, "end": r.end} for r in results if r.entity_type == "PERSON"]


def map_spacy(ents: list) -> list[dict]:
    return [{"start": e.start_char, "end": e.end_char} for e in ents if e.label_ == "PER"]


def map_gliner(entities: list[dict]) -> list[dict]:
    return [{"start": e["start"], "end": e["end"]} for e in entities]


def select_best_label(gold_cases: dict, preds_by_label: dict[str, dict]) -> tuple[str, float]:
    best_label, best_rec = "", -1.0
    for label, preds in preds_by_label.items():
        rec = recall(gold_cases, preds)["global"]["overlap"]
        if rec > best_rec:
            best_label, best_rec = label, rec
    return best_label, best_rec
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd research/ner-eval && python -m pytest tests/test_mapping.py -q`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd research/ner-eval
git add runners/__init__.py runners/mapping.py tests/test_mapping.py
git commit -m "feat(ner-eval): pure native->person mappers + GLiNER label selection"
```

---

### Task 8: Concrete model runners (integration wrappers)

**Files:**
- Create: `research/ner-eval/runners/_io.py`
- Create: `research/ner-eval/runners/run_presidio.py`
- Create: `research/ner-eval/runners/run_spacy.py`
- Create: `research/ner-eval/runners/run_gliner.py`

**Interfaces:**
- Consumes: `score.load_jsonl`, `runners.mapping.*`.
- Produces: each script reads `corpus.jsonl`, writes `predictions.<model>.jsonl`
  (`{"id": str, "spans": [{"start","end"}]}`). `run_gliner.py` additionally selects the best
  label via `select_best_label` and prints it.
- `runners._io.read_corpus(path="corpus.jsonl") -> list[dict]` and
  `runners._io.write_predictions(path, records: list[dict]) -> None`.

> These call heavy models and download weights — they are **not** unit-tested (a CamemBERT
> download is not a unit test). They are validated by running them (Task 9). Their *mapping*
> logic was already tested in Task 7.

- [ ] **Step 1: Implement the shared IO helper**

`research/ner-eval/runners/_io.py`:
```python
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def read_corpus(path: str = "corpus.jsonl") -> list[dict]:
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def write_predictions(path: str, records: list[dict]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"wrote {len(records)} predictions to {path}")
```

- [ ] **Step 2: Implement `run_presidio.py`**

`research/ner-eval/runners/run_presidio.py`:
```python
"""Presidio runner (spaCy FR backend). Run from research/ner-eval/:
    python runners/run_presidio.py"""
from presidio_analyzer import AnalyzerEngine
from presidio_analyzer.nlp_engine import NlpEngineProvider

from _io import read_corpus, write_predictions
from mapping import map_presidio


def build_analyzer() -> AnalyzerEngine:
    provider = NlpEngineProvider(nlp_configuration={
        "nlp_engine_name": "spacy",
        "models": [{"lang_code": "fr", "model_name": "fr_core_news_lg"}],
    })
    return AnalyzerEngine(nlp_engine=provider.create_engine(), supported_languages=["fr"])


def main() -> None:
    analyzer = build_analyzer()
    records = []
    for case in read_corpus():
        results = analyzer.analyze(text=case["text"], language="fr", entities=["PERSON"])
        records.append({"id": case["id"], "spans": map_presidio(results)})
    write_predictions("predictions.presidio.jsonl", records)


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Implement `run_spacy.py`**

`research/ner-eval/runners/run_spacy.py`:
```python
"""spaCy FR runner. Run from research/ner-eval/:
    python runners/run_spacy.py"""
import spacy

from _io import read_corpus, write_predictions
from mapping import map_spacy


def main() -> None:
    nlp = spacy.load("fr_core_news_lg")
    records = []
    for case in read_corpus():
        doc = nlp(case["text"])
        records.append({"id": case["id"], "spans": map_spacy(list(doc.ents))})
    write_predictions("predictions.spacy.jsonl", records)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Implement `run_gliner.py` (with label sweep)**

`research/ner-eval/runners/run_gliner.py`:
```python
"""GLiNER runner with label sweep. Run from research/ner-eval/:
    python runners/run_gliner.py
Writes predictions.gliner.jsonl for the best-performing FR label."""
from gliner import GLiNER

from _io import read_corpus, write_predictions
from mapping import map_gliner, select_best_label
from score import load_jsonl

CANDIDATE_LABELS = ["personne", "nom de personne", "prénom"]
THRESHOLD = 0.5


def predict_for_label(model, corpus, label) -> dict:
    out = {}
    for case in corpus:
        ents = model.predict_entities(case["text"], [label], threshold=THRESHOLD)
        out[case["id"]] = {"id": case["id"], "spans": map_gliner(ents)}
    return out


def main() -> None:
    model = GLiNER.from_pretrained("urchade/gliner_multi-v2.1")
    corpus = read_corpus()
    preds_by_label = {lbl: predict_for_label(model, corpus, lbl) for lbl in CANDIDATE_LABELS}

    gold = load_jsonl("gold.jsonl")
    best_label, best_rec = select_best_label(gold, preds_by_label)
    print(f"best GLiNER label: {best_label!r} (overlap recall {best_rec})")

    records = list(preds_by_label[best_label].values())
    write_predictions("predictions.gliner.jsonl", records)
    with open("gliner_best_label.txt", "w", encoding="utf-8") as f:
        f.write(best_label + "\n")


if __name__ == "__main__":
    main()
```

- [ ] **Step 5: Commit**

```bash
cd research/ner-eval
git add runners/_io.py runners/run_presidio.py runners/run_spacy.py runners/run_gliner.py
git commit -m "feat(ner-eval): Presidio / spaCy-FR / GLiNER runners (GLiNER label sweep)"
```

---

### Task 9: Report renderer + run the bake-off

**Files:**
- Create: `research/ner-eval/report.py`
- Test: `research/ner-eval/tests/test_report.py`
- Create (deliverable, committed after run): `research/ner-eval/results.md`

**Interfaces:**
- Consumes: `score.load_jsonl`, `score.recall`.
- Produces:
  - `report.render(gold_cases: dict, preds_by_model: dict[str, dict], gliner_label: str | None) -> str` — markdown with: global recall table (overlap + exact per model), the per-bucket overlap table (models × buckets), the **per-origin overlap table (models × origins) with the `arabic` row called out as highest-stakes**, the hyphenated boundary-leak gap per model, the winning GLiNER label, and the standing FP-gate section.

- [ ] **Step 1: Write the failing test**

`research/ner-eval/tests/test_report.py`:
```python
from report import render


def test_render_contains_key_sections():
    gold = {"c0": {"spans": [{"start": 0, "end": 4, "buckets": ["hyphenated"], "origin": "arabic"}]}}
    preds = {"modelA": {"c0": {"spans": [{"start": 0, "end": 2}]}}}
    md = render(gold, preds, gliner_label="personne")
    assert "# NER recall bake-off" in md
    assert "modelA" in md
    assert "Per-origin recall" in md
    assert "arabic" in md                      # highest-stakes origin row present
    assert "Boundary-leak" in md
    assert "personne" in md
    assert "FP measurement remains a deployment gate" in md
    # boundary-leak gap = overlap(1.0) - exact(0.0) = 1.0 shown
    assert "1.0" in md
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd research/ner-eval && python -m pytest tests/test_report.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'report'`.

- [ ] **Step 3: Implement `report.py`**

`research/ner-eval/report.py`:
```python
"""Render results.md from gold + per-model predictions. Pure (stdlib)."""
import sys
from score import recall, load_jsonl

MODELS = ["presidio", "spacy", "gliner"]
FP_GATE = (
    "## FP measurement remains a deployment gate\n\n"
    "These numbers are **recall only**. False-positive rate is NOT measured here and "
    "cannot be honestly measured on synthetic data. Before any live deployment on real "
    "real mail, run the chosen model in **observation mode** over a real sample, count "
    "false positives on real sport/venue/place vocabulary, and deploy nothing until "
    "that rate is acceptable. 'Recall looks great' is not 'safe to deploy'.\n"
)


def render(gold_cases: dict, preds_by_model: dict, gliner_label: str | None) -> str:
    scored = {m: recall(gold_cases, p) for m, p in preds_by_model.items()}
    models = list(preds_by_model.keys())
    all_buckets = sorted({b for s in scored.values() for b in s["per_bucket"]})

    out = ["# NER recall bake-off — results (STU-401)\n"]

    out.append("## Global recall\n")
    out.append("| model | overlap | exact |")
    out.append("|---|---|---|")
    for m in models:
        g = scored[m]["global"]
        out.append(f"| {m} | {g['overlap']} | {g['exact']} |")
    out.append("")

    out.append("## Per-bucket recall (overlap)\n")
    out.append("| bucket | " + " | ".join(models) + " |")
    out.append("|---|" + "---|" * len(models))
    for b in all_buckets:
        row = [b]
        for m in models:
            pb = scored[m]["per_bucket"].get(b)
            row.append(str(pb["overlap"]) if pb else "—")
        out.append("| " + " | ".join(row) + " |")
    out.append("")

    all_origins = sorted({o for s in scored.values() for o in s["per_origin"]})
    out.append("## Per-origin recall (overlap) — distinct axis from hardness\n")
    out.append("> `arabic` is the highest-stakes row (a major, sensitive group in this context — minors). "
               "A model weak here is rejected regardless of global recall.\n")
    out.append("| origin | " + " | ".join(models) + " |")
    out.append("|---|" + "---|" * len(models))
    for o in all_origins:
        label = f"**{o}**" if o == "arabic" else o
        row = [label]
        for m in models:
            po = scored[m]["per_origin"].get(o)
            row.append(str(po["overlap"]) if po else "—")
        out.append("| " + " | ".join(row) + " |")
    out.append("")

    out.append("## Boundary-leak risk (hyphenated: overlap − exact)\n")
    out.append("| model | gap |")
    out.append("|---|---|")
    for m in models:
        out.append(f"| {m} | {scored[m]['boundary_leak_hyphenated']} |")
    out.append("")

    if gliner_label:
        out.append(f"**Winning GLiNER label:** `{gliner_label}`\n")

    out.append("## Recommendation\n")
    out.append("_Fill in after reviewing the tables: which model, and why._\n")

    out.append(FP_GATE)
    return "\n".join(out)


def main() -> None:
    gold = load_jsonl("gold.jsonl")
    preds = {}
    for m in MODELS:
        try:
            preds[m] = load_jsonl(f"predictions.{m}.jsonl")
        except FileNotFoundError:
            print(f"skipping {m}: predictions.{m}.jsonl not found", file=sys.stderr)
    label = None
    try:
        with open("gliner_best_label.txt", encoding="utf-8") as f:
            label = f.read().strip()
    except FileNotFoundError:
        pass
    with open("results.md", "w", encoding="utf-8") as f:
        f.write(render(gold, preds, label))
    print("wrote results.md")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd research/ner-eval && python -m pytest tests/test_report.py -q`
Expected: PASS (1 test).

- [ ] **Step 5: Run the full pipeline on the dev machine**

```bash
cd research/ner-eval
source .venv/bin/activate
pip install -r requirements.txt && python -m spacy download fr_core_news_lg
python generate_corpus.py
python runners/run_presidio.py
python runners/run_spacy.py
python runners/run_gliner.py
python report.py
```
Expected: each runner prints `wrote N predictions ...`; `report.py` prints `wrote results.md`.

- [ ] **Step 6: Write the recommendation and commit**

Edit `results.md`: replace the "Recommendation" placeholder with the actual call — which
model, justified by global recall, the weakest-bucket performance (esp. `word_like`,
`surname_collision`), the **per-origin recall (a model weak on `arabic` is rejected regardless
of global recall)**, and the hyphenated boundary-leak gap.

```bash
cd research/ner-eval
git add report.py tests/test_report.py results.md
git commit -m "feat(ner-eval): results renderer + recorded bake-off recommendation (STU-401)"
```

---

## Self-Review

**Spec coverage:**
- Recall-only bake-off, 3 models → Tasks 7–9. ✓
- Hard synthetic corpus, slot-injection, exact gold → Tasks 3, 5. ✓
- Deterministic + committed artifact → Task 5 (`test_deterministic_byte_identical`, committed `corpus.jsonl`/`gold.jsonl`). ✓
- Seeded roughener, prose-only, fail-loud offsets → Task 4. ✓
- 11 buckets incl. `name_origin_diverse`, generous diversity → Tasks 1, 5. ✓
- Origin axis (franco/romanian/hispanic/african_franco/african_anglo/east_asian/vietnamese/
  south_asian/haitian/arabic), broad-not-proportional coverage (each group measurable), Arabic
  generously loaded with its traps (al-/el-, particle compounds, transliterations), synthetic-only,
  origin-not-from-appearance → Task 1. ✓
- Per-origin recall reported, `arabic` called out → Tasks 6, 9. ✓
- GLiNER label sweep → Tasks 7, 8. ✓
- Overlap-primary/exact-secondary + hyphenated boundary-leak gap → Task 6. ✓
- `results.md` with recommendation + standing FP gate → Task 9. ✓
- Kernel-purity by location, stdlib-only generator/scorer → Global Constraints, Task 1. ✓

**Placeholder scan:** The only intentional fill-in is the human-authored recommendation prose in `results.md` (Task 9, Step 6) — it cannot be pre-written because it depends on the experiment's real numbers. All code steps contain complete code.

**Type consistency:** `Span(start,end,buckets)` consistent across `corpus_types`/`inject`/`roughen`. Prediction records `{id, spans:[{start,end}]}` consistent across runners, scorer, report. `recall()` signature (third arg unused) matches its callers (`select_best_label`, `report.render`). Bucket name `name_origin_diverse` consistent across names, buckets, tests.
