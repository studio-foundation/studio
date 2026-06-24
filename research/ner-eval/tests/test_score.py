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
