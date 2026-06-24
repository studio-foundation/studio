from dataclasses import dataclass


@dataclass(frozen=True)
class Span:
    start: int
    end: int
    buckets: tuple[str, ...]
