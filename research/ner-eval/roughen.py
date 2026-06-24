"""Seeded roughener. Operates ONLY on free segments between protected name
spans, so a name's surface and the gold offsets stay exact. Deterministic
given the rng. Fail-loud: asserts every span round-trips after reassembly."""
import random
from corpus_types import Span

# oral Québécois rewrites applied to whole free segments (deterministic order)
_ORAL = [("puis ", "pis "), ("ne sera pas", "sera pas"), ("aujourd'hui", "ajd")]


def _roughen_segment(seg: str, rng: random.Random) -> str:
    out = seg
    for a, b in _ORAL:
        if a in out and rng.random() < 0.5:
            out = out.replace(a, b, 1)
    # single seeded typo: drop one accent-free interior char on a long-enough word
    if len(out) > 6 and rng.random() < 0.4:
        i = rng.randrange(1, len(out) - 1)
        if out[i].isalpha() and out[i] not in "éèêàùçô":
            out = out[:i] + out[i + 1:]
    return out


def roughen(text: str, spans: list[Span], rng: random.Random) -> tuple[str, list[Span]]:
    ordered = sorted(spans, key=lambda s: s.start)
    surfaces = [text[s.start:s.end] for s in ordered]

    # split into alternating free / protected segments
    pieces: list[tuple[str, bool]] = []   # (segment, is_protected)
    cursor = 0
    for s in ordered:
        pieces.append((text[cursor:s.start], False))
        pieces.append((text[s.start:s.end], True))
        cursor = s.end
    pieces.append((text[cursor:], False))

    # roughen free pieces; remember which changed
    new_pieces: list[str] = []
    changed: list[bool] = []
    for seg, protected in pieces:
        if protected:
            new_pieces.append(seg)
            changed.append(False)
        else:
            r = _roughen_segment(seg, rng)
            new_pieces.append(r)
            changed.append(r != seg)

    new_text = "".join(new_pieces)

    # recompute span offsets from new piece lengths; add typo_adjacent if a
    # neighbouring free piece changed
    new_spans: list[Span] = []
    offset = 0
    span_idx = 0
    for i, (_seg, protected) in enumerate(pieces):
        if protected:
            start = offset
            end = offset + len(new_pieces[i])
            left_changed = i > 0 and changed[i - 1]
            right_changed = i + 1 < len(pieces) and changed[i + 1]
            buckets = ordered[span_idx].buckets
            if (left_changed or right_changed) and "typo_adjacent" not in buckets:
                buckets = buckets + ("typo_adjacent",)
            assert new_text[start:end] == surfaces[span_idx], "name surface drifted"
            new_spans.append(Span(start=start, end=end, buckets=buckets))
            span_idx += 1
        offset += len(new_pieces[i])

    return new_text, new_spans
