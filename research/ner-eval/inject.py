"""Slot-injection: fill {name} placeholders, compute exact gold offsets."""
from dataclasses import dataclass
from corpus_types import Span

PLACEHOLDER = "{name}"


@dataclass(frozen=True)
class Filler:
    surface: str
    buckets: tuple[str, ...]


def inject(template: str, fillers: list[Filler]) -> tuple[str, list[Span]]:
    if template.count(PLACEHOLDER) != len(fillers):
        raise ValueError(
            f"placeholder count {template.count(PLACEHOLDER)} != fillers {len(fillers)}"
        )
    out: list[str] = []
    spans: list[Span] = []
    cursor = 0          # length of text built so far (== next char offset)
    rest = template
    for filler in fillers:
        head, rest = rest.split(PLACEHOLDER, 1)
        out.append(head)
        cursor += len(head)
        start = cursor
        out.append(filler.surface)
        cursor += len(filler.surface)
        spans.append(Span(start=start, end=cursor, buckets=filler.buckets))
    out.append(rest)
    return "".join(out), spans
