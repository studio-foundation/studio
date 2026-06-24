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
