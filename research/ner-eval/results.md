# NER recall bake-off — results (STU-401)

## Global recall

| model | overlap | exact |
|---|---|---|
| presidio | 0.5086 | 0.4114 |
| spacy | 0.5086 | 0.4114 |
| gliner | 0.9486 | 0.8257 |

## Per-bucket recall (overlap)

| bucket | presidio | spacy | gliner |
|---|---|---|---|
| diminutif | 0.6 | 0.6 | 1.0 |
| english_mixed | 0.3617 | 0.3617 | 0.9574 |
| hyphenated | 0.4483 | 0.4483 | 0.8966 |
| lowercase | 0.3397 | 0.3397 | 0.933 |
| multi_token | 1.0 | 1.0 | 1.0 |
| name_origin_diverse | 0.5085 | 0.5085 | 0.9492 |
| no_salutation | 0.5086 | 0.5086 | 0.9486 |
| possessive | 0.6 | 0.6 | 0.976 |
| surname_collision | 0.4167 | 0.4167 | 0.75 |
| typo_adjacent | 0.5495 | 0.5495 | 0.9505 |
| word_like | 0.25 | 0.25 | 1.0 |

## Per-origin recall (overlap) — distinct axis from hardness

> `arabic` is the highest-stakes row (a major, sensitive group in this context — minors). A model weak here is rejected regardless of global recall.

| origin | presidio | spacy | gliner |
|---|---|---|---|
| african_anglo | 0.3667 | 0.3667 | 0.9667 |
| african_franco | 0.4667 | 0.4667 | 0.9667 |
| **arabic** | 0.5455 | 0.5455 | 0.9636 |
| east_asian | 0.6333 | 0.6333 | 0.9333 |
| franco | 0.5091 | 0.5091 | 0.9455 |
| haitian | 0.5667 | 0.5667 | 0.8667 |
| hispanic | 0.5667 | 0.5667 | 0.9 |
| romanian | 0.6 | 0.6 | 0.9667 |
| south_asian | 0.3667 | 0.3667 | 1.0 |
| vietnamese | 0.4333 | 0.4333 | 0.9667 |

## Boundary-leak risk (hyphenated: overlap − exact)

| model | gap |
|---|---|
| presidio | 0.0862 |
| spacy | 0.0862 |
| gliner | 0.1035 |

**Winning GLiNER label:** `personne`

## Recommendation

_Fill in after reviewing the tables: which model, and why._

## FP measurement remains a deployment gate

These numbers are **recall only**. False-positive rate is NOT measured here and cannot be honestly measured on synthetic data. Before any live deployment on real mail, run the chosen model in **observation mode** over a real sample, count false positives on real sport/venue/place vocabulary, and deploy nothing until that rate is acceptable. 'Recall looks great' is not 'safe to deploy'.

## Recommendation

**GLiNER, label `personne`.** Unambiguous across every axis.

Global overlap recall 0.95 vs 0.51 for both presidio and spacy. The win holds per-bucket and per-origin: GLiNER is above 0.86 nearly everywhere, while presidio/spacy plateau at 0.5–0.6 and collapse on the hard cases (word_like 0.25, lowercase 0.34).

Note: presidio and spacy score identically because presidio uses spaCy-FR as its name-detection backend — the bake-off was effectively spaCy-FR vs GLiNER, and GLiNER wins decisively. Only two independent engines were compared, not three.

Decisive criterion met: arabic recall (the highest-stakes group in this context) is 0.96 for GLiNER. Other origins are solid too (vietnamese 0.97, south_asian 1.0, african 0.97, romanian 0.97). Onomastic diversity is covered — the requirement that mattered most for deployability.

GLiNER is a local, open-source, discriminative NER model (encoder-based, ~hundreds of millions of params), not an LLM and not a remote service. Weights are pulled once from the Hugging Face hub then run locally; no data leaves the machine. This is consistent with the anonymizer's purpose: PII detection must run locally, before any text reaches an external LLM. A detector that itself called a remote LLM would be circular.

Caveats carried to the provider implementation (STU-40x):
- Recall-only on synthetic data. FP rate unmeasured (see gate below). High zero-shot recall with a broad `personne` label can be partly bought by over-tagging — the FP gate is not optional.
- Boundary-leak on hyphenated names: GLiNER's overlap−exact gap is 0.10 (vs 0.086 for the others). It detects compound names but sometimes mis-delimits ("Marie" caught, "-Pier" dropped). At anonymization time a partially-tokenized compound leaks half in cleartext. Watch in the provider.
- GLiNER is a transformer requiring PyTorch — the open question for deployment is whether it runs acceptably on the Pi secondary, or must be primary-node-only. Decided at provider implementation, model now in hand.