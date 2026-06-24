"""The 11 canonical hardness buckets. Single source of truth (DRY)."""

BUCKETS = frozenset({
    "lowercase",          # name not capitalized
    "word_like",          # first name colliding with a common word (rose, pierre, olive)
    "surname_collision",  # surname that is also a common word (côté, roy, boucher)
    "hyphenated",         # compound hyphenated name (marie-pier)
    "diminutif",          # familiar/diminutive form (jeff, max, ben)
    "no_salutation",      # name in free text, no "Bonjour X" cue
    "multi_token",        # two+ space-separated tokens (first + last)
    "possessive",         # relational structure ("la mère de X")
    "typo_adjacent",      # roughened/typo'd context around the name
    "english_mixed",      # FR text with English fragments
    "name_origin_diverse",# non-old-stock-franco names (multiethnic Québec youth-sport population)
})
