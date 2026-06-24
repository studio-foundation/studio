"""spaCy FR runner. Run from research/ner-eval/:
    python runners/run_spacy.py"""
import spacy

from corpus_io import read_corpus, write_predictions
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
