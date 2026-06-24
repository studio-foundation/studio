from buckets import BUCKETS
from generate_corpus import build_cases, SEED


def test_deterministic_byte_identical():
    a = build_cases(SEED)
    b = build_cases(SEED)
    assert a == b


def test_every_gold_span_exact_and_bucketed():
    for case in build_cases(SEED):
        for sp in case["spans"]:
            assert sp["end"] > sp["start"]
            surface = case["text"][sp["start"]:sp["end"]]
            assert surface.strip() == surface and surface
            assert sp["buckets"], "every span must carry >=1 bucket"
            assert set(sp["buckets"]) <= BUCKETS


def test_all_eleven_buckets_present():
    seen = set()
    for case in build_cases(SEED):
        for sp in case["spans"]:
            seen.update(sp["buckets"])
    assert seen == BUCKETS, f"missing buckets: {BUCKETS - seen}"


def test_diversity_generously_represented():
    n = sum(
        1 for c in build_cases(SEED) for sp in c["spans"]
        if "name_origin_diverse" in sp["buckets"]
    )
    assert n >= 20


def test_every_origin_meets_measurement_floor():
    origins = {}
    for c in build_cases(SEED):
        for sp in c["spans"]:
            assert sp.get("origin"), "every gold span must carry an origin"
            origins[sp["origin"]] = origins.get(sp["origin"], 0) + 1
    required = {"franco", "romanian", "hispanic", "african_franco", "african_anglo",
                "east_asian", "vietnamese", "south_asian", "haitian", "arabic"}
    assert required <= set(origins)
    # measurement floor: per-origin recall must be statistically readable for
    # EVERY origin, even rare groups — a rare name still leaks if missed. The
    # corpus measures the detector, it does not represent the target population.
    for o in required:
        assert origins[o] >= 30, f"origin {o} below the ~30-case measurement floor"
    # realistic hierarchy on top: franco & arabic dominate the target population,
    # and are the two largest groups in the corpus (shape correct, floor honored).
    assert origins["franco"] >= 50 and origins["arabic"] >= 50
    minorities = max(origins[o] for o in required if o not in ("franco", "arabic"))
    assert origins["franco"] >= minorities and origins["arabic"] >= minorities
