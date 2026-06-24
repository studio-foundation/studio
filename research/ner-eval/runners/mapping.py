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
