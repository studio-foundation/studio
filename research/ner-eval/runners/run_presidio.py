"""Presidio runner (spaCy FR backend). Run from research/ner-eval/:
    python runners/run_presidio.py"""
from presidio_analyzer import AnalyzerEngine
from presidio_analyzer.nlp_engine import NlpEngineProvider

from corpus_io import read_corpus, write_predictions
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
