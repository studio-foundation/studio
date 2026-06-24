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
