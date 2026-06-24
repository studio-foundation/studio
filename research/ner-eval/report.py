"""Render results.md from gold + per-model predictions. Pure (stdlib)."""
import sys
from score import recall, load_jsonl

MODELS = ["presidio", "spacy", "gliner"]
FP_GATE = (
    "## FP measurement remains a deployment gate\n\n"
    "These numbers are **recall only**. False-positive rate is NOT measured here and "
    "cannot be honestly measured on synthetic data. Before any live deployment on real "
    "mail, run the chosen model in **observation mode** over a real sample, count "
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
    out.append("> `arabic` is the highest-stakes row (a major, sensitive group in this context — "
               "minors). A model weak here is rejected regardless of global recall.\n")
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
