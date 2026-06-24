import pytest
from inject import inject, Filler


def test_single_slot_exact_offsets():
    text, spans = inject("{name} sera pas là", [Filler("rose", ("word_like", "lowercase"))])
    assert text == "rose sera pas là"
    assert len(spans) == 1
    s = spans[0]
    assert text[s.start:s.end] == "rose"
    assert s.start == 0 and s.end == 4
    assert set(s.buckets) == {"word_like", "lowercase"}


def test_multi_slot_offsets_independent():
    text, spans = inject(
        "{name} et {name} jouent",
        [Filler("marie", ("lowercase",)), Filler("Côté", ("surname_collision",))],
    )
    assert text == "marie et Côté jouent"
    assert [text[s.start:s.end] for s in spans] == ["marie", "Côté"]


def test_mismatched_placeholders_raise():
    with pytest.raises(ValueError):
        inject("{name} and {name}", [Filler("x", ())])
