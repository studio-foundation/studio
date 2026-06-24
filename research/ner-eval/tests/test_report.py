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
