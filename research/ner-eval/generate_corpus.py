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
