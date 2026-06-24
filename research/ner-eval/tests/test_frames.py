from buckets import BUCKETS
from frames import FRAME_BANK, Frame


def test_every_frame_well_formed():
    assert FRAME_BANK
    for f in FRAME_BANK:
        assert isinstance(f, Frame)
        assert "{name}" in f.template, f"frame missing slot: {f.template!r}"
        assert set(f.buckets) <= BUCKETS
        # frame-intrinsic buckets only — never name-intrinsic ones
        assert not (set(f.buckets) & {"word_like", "hyphenated", "diminutif",
                                      "surname_collision", "name_origin_diverse"})


def _has(bucket):
    return any(bucket in f.buckets for f in FRAME_BANK)


def test_key_structures_present():
    assert _has("possessive")      # "la mère de {name}"
    assert _has("english_mixed")
    # most free-text frames carry no_salutation
    assert sum(1 for f in FRAME_BANK if "no_salutation" in f.buckets) >= 5
    assert len(FRAME_BANK) >= 12   # enough variety so the corpus isn't robotic
