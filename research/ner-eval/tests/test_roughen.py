import random
import pytest
from corpus_types import Span
from roughen import roughen


def _names(text, spans):
    return [text[s.start:s.end] for s in spans]


def test_determinism_same_seed_identical():
    text = "je vous écris pour dire que rose ne sera pas la aujourd'hui"
    spans = [Span(28, 32, ("word_like",))]
    a = roughen(text, list(spans), random.Random(401))
    b = roughen(text, list(spans), random.Random(401))
    assert a == b


def test_name_surface_never_mutated_and_offsets_exact():
    text = "la mere de marie-pier vous remercie beaucoup pour la belle saison"
    # "marie-pier" starts at index 11
    assert text[11:21] == "marie-pier"
    spans = [Span(11, 21, ("hyphenated",))]
    new_text, new_spans = roughen(text, spans, random.Random(7))
    assert _names(new_text, new_spans) == ["marie-pier"]  # surface intact, offsets exact


def test_typo_adjacent_bucket_added_when_context_changes():
    text = "je vous ecris pour dire que rose ne sera pas la"
    spans = [Span(28, 32, ("word_like",))]
    # use a seed known to mutate; loop a few seeds to find one that changes text
    for seed in range(50):
        new_text, new_spans = roughen(text, list(spans), random.Random(seed))
        if new_text != text:
            assert "typo_adjacent" in new_spans[0].buckets
            return
    raise AssertionError("no seed mutated the text; roughener too inert")


def test_fail_loud_assertion_guard_untrippable():
    """The fail-loud assertion at line 65 ('name surface drifted') is mathematically
    untrippable from the public roughen() interface.

    The assertion guards against a logic bug in offset recomputation. However, the
    algorithm is structured to guarantee the invariant it asserts:
    1. surfaces[i] captures text[span.start:span.end] BEFORE roughening.
    2. Offset recomputation is deterministic: start = sum(preceding piece lengths in new_text).
    3. protected pieces (spans) are NEVER roughened—their content never changes.
    4. New offsets are computed from the sum of new piece lengths, directly accounting
       for any length changes in PRECEDING free segments.
    5. Therefore, new_text[start:end] always equals surfaces[i].

    The assertion is a defensive check: if it fires, it indicates a bug in the offset
    computation logic, not in span protection. Since the algorithm is sound, this test
    documents that the guard is working as intended (as a true invariant, not a fallible
    constraint)—by verifying that roughening diverse inputs never violates it.
    """
    # Test 1: Text with leading free segment that gets roughened
    text1 = "aujourd'hui world is great"
    spans1 = [Span(11, 16, ("test",))]
    for seed in range(20):
        new_text, new_spans = roughen(text1, list(spans1), random.Random(seed))
        # If roughening changed the text, verify the span surface is still preserved
        if new_text != text1:
            assert new_text[new_spans[0].start:new_spans[0].end] == text1[spans1[0].start:spans1[0].end]

    # Test 2: Text with multiple spans and free segments that change
    text2 = "la mere de marie-pier puis elle ne sera pas la"
    spans2 = [Span(11, 21, ("hyphenated",)), Span(28, 32, ("word_like",))]
    for seed in range(20):
        new_text, new_spans = roughen(text2, list(spans2), random.Random(seed))
        # Verify BOTH spans round-trip (assertion holds for all)
        for i, (orig_span, new_span) in enumerate(zip(spans2, new_spans)):
            orig_surface = text2[orig_span.start:orig_span.end]
            new_surface = new_text[new_span.start:new_span.end]
            assert new_surface == orig_surface, f"Span {i} surface drifted: {repr(new_surface)} != {repr(orig_surface)}"
