from buckets import BUCKETS
from names import NAME_BANK, NameEntry, ORIGINS


def test_buckets_are_the_eleven_canonical():
    assert BUCKETS == frozenset({
        "lowercase", "word_like", "surname_collision", "hyphenated",
        "diminutif", "no_salutation", "multi_token", "possessive",
        "typo_adjacent", "english_mixed", "name_origin_diverse",
    })


def test_every_name_entry_is_well_formed():
    assert NAME_BANK, "name bank must not be empty"
    for e in NAME_BANK:
        assert isinstance(e, NameEntry)
        assert e.surface.strip() == e.surface and e.surface
        assert set(e.buckets) <= BUCKETS
        assert e.origin in ORIGINS
        # origin axis and hardness umbrella must agree: non-franco <=> name_origin_diverse
        if e.origin == "franco":
            assert "name_origin_diverse" not in e.buckets
        else:
            assert "name_origin_diverse" in e.buckets, f"{e.surface} non-franco must be diverse"
        if "-" in e.surface:
            assert "hyphenated" in e.buckets, f"{e.surface} should be hyphenated"
        if " " in e.surface:
            assert "multi_token" in e.buckets, f"{e.surface} should be multi_token"


def _count(bucket):
    return sum(1 for e in NAME_BANK if bucket in e.buckets)


def _origin_count(origin):
    return sum(1 for e in NAME_BANK if e.origin == origin)


def test_trap_and_diversity_buckets_generously_represented():
    assert _count("word_like") >= 5
    assert _count("surname_collision") >= 5
    assert _count("hyphenated") >= 5
    assert _count("diminutif") >= 4
    assert _count("name_origin_diverse") >= 20  # the population most at risk — generous


def test_origins_span_the_target_distribution():
    required = {"franco", "romanian", "hispanic", "african_franco", "african_anglo",
                "east_asian", "vietnamese", "south_asian", "haitian", "arabic"}
    assert required <= ORIGINS
    # broad coverage, measurable per group — proportions don't matter for a recall spike
    for o in required:
        assert _origin_count(o) >= 3, f"origin {o} under-represented to measure"


def test_arabic_is_most_heavily_loaded_with_its_traps():
    # Middle Eastern is a major group in this context — load it, not token it.
    assert _origin_count("arabic") >= 10
    arabic = [e for e in NAME_BANK if e.origin == "arabic"]
    # al-/el- prefix trap present (cross-tagged hyphenated)
    assert any(e.surface.lower().startswith(("al-", "el-")) for e in arabic)
    # multiple transliterations of the same name as DISTINCT surfaces
    surfaces = {e.surface.lower() for e in arabic}
    assert {"mohammed", "muhammad", "mohamed"} <= surfaces
