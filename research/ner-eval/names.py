"""Hard Québécois + multiethnic name bank for the recall bake-off.

Two axes per entry:
  * buckets  — *name-intrinsic* hardness (word_like, surname_collision,
    hyphenated, diminutif, multi_token, name_origin_diverse). Frame- and
    injection-intrinsic buckets (lowercase, possessive, no_salutation,
    english_mixed, typo_adjacent) are added later in the pipeline.
  * origin   — onomastic origin group (franco, romanian, hispanic,
    african_franco, african_anglo, east_asian, vietnamese, south_asian,
    haitian, arabic). Reported as a SEPARATE axis: "weak on Arabic names" is a
    different failure than "weak on word-like names". Non-franco entries also
    carry the name_origin_diverse umbrella bucket.

All names are SYNTHETIC and invented. The origin mix reflects a generic
multiethnic Québec youth-sport context (Arabic is a major group; the rest are
plausible large Québec urban communities) — a names-based reading of the target
context, never appearance-based (the NER sees text, not people). Coverage is
DIRECTIONAL (broad) with a per-origin measurement floor — see generate_corpus.
Never a real name, never a minor's name.
"""
from dataclasses import dataclass

ORIGINS = frozenset({
    "franco", "romanian", "hispanic", "african_franco", "african_anglo",
    "east_asian", "vietnamese", "south_asian", "haitian", "arabic",
})


@dataclass(frozen=True)
class NameEntry:
    surface: str
    buckets: tuple[str, ...]
    origin: str


def _n(surface: str, *buckets: str, origin: str = "franco") -> NameEntry:
    # non-franco names automatically carry the name_origin_diverse umbrella bucket
    bset = set(buckets)
    if origin != "franco":
        bset.add("name_origin_diverse")
    return NameEntry(surface=surface, buckets=tuple(sorted(bset)), origin=origin)


NAME_BANK: list[NameEntry] = [
    # --- QC-franco hardness traps -------------------------------------------
    # word_like first names (collide with a common word)
    _n("Rose", "word_like"), _n("Pierre", "word_like"), _n("Olive", "word_like"),
    _n("Lys", "word_like"), _n("Claire", "word_like"), _n("Aurore", "word_like"),
    # surname collisions (name AND common word — "à côté")
    _n("Côté", "surname_collision"), _n("Roy", "surname_collision"),
    _n("Boucher", "surname_collision"), _n("Berger", "surname_collision"),
    _n("Lévesque", "surname_collision"), _n("Charron", "surname_collision"),
    # hyphenated compounds (ubiquitous in QC, esp. kids)
    _n("Marie-Pier", "hyphenated"), _n("Jean-François", "hyphenated"),
    _n("Pierre-Luc", "hyphenated"), _n("Anne-Sophie", "hyphenated"),
    _n("Marie-Ève", "hyphenated"), _n("Louis-Philippe", "hyphenated"),
    # diminutives / familiar forms (the register of a parent email)
    _n("Jeff", "diminutif"), _n("Max", "diminutif"),
    _n("Ben", "diminutif"), _n("Steph", "diminutif"), _n("Fred", "diminutif"),
    # plain old-stock first names (baseline)
    _n("Thomas"), _n("Jacqueline"), _n("Marie"), _n("Gabriel"),
    # multi_token (first + last)
    _n("Marie Tremblay", "multi_token"), _n("Luc Gagnon", "multi_token"),

    # --- Arabic / Middle Eastern — MOST HEAVILY LOADED (major group in this context) --
    # al-/el- prefix trap (cross-tagged hyphenated, the QC-compound problem aggravated)
    _n("Al-Rashid", "hyphenated", origin="arabic"),
    _n("El-Amin", "hyphenated", origin="arabic"),
    _n("Al-Sayed", "hyphenated", origin="arabic"),
    _n("El-Masri", "hyphenated", origin="arabic"),
    # multiple transliterations of the SAME name as distinct surfaces
    _n("Mohammed", origin="arabic"), _n("Muhammad", origin="arabic"),
    _n("Mohamed", origin="arabic"),
    _n("Yousef", origin="arabic"), _n("Youssef", origin="arabic"),
    _n("Yusuf", origin="arabic"),
    # particle compound (multi_token given + family)
    _n("Layla Haddad", "multi_token", origin="arabic"),
    _n("Karim Nasser", "multi_token", origin="arabic"),
    # common given names
    _n("Fatima", origin="arabic"), _n("Aisha", origin="arabic"),
    _n("Omar", origin="arabic"), _n("Nour", origin="arabic"),

    # --- other origins present in a multiethnic Québec context --------------
    # Romanian
    _n("Popescu", origin="romanian"), _n("Ionescu", origin="romanian"),
    _n("Andrei", origin="romanian"), _n("Ioana", origin="romanian"),
    # Hispanic
    _n("Gómez", origin="hispanic"), _n("Morales", origin="hispanic"),
    _n("Mateo", origin="hispanic"), _n("Valentina", origin="hispanic"),
    # francophone African
    _n("Traoré", origin="african_franco"), _n("Koné", origin="african_franco"),
    _n("Aminata", origin="african_franco"), _n("Mamadou", origin="african_franco"),
    # anglophone / West African
    _n("Okonkwo", origin="african_anglo"), _n("Adeyemi", origin="african_anglo"),
    _n("Mensah", origin="african_anglo"), _n("Boateng", origin="african_anglo"),
    # East Asian (Chinese / Korean forms)
    _n("Chen", origin="east_asian"), _n("Wang", origin="east_asian"),
    _n("Kim", origin="east_asian"), _n("Park", origin="east_asian"),
    # Vietnamese
    _n("Nguyen", origin="vietnamese"), _n("Tran", origin="vietnamese"),
    _n("Thanh", origin="vietnamese"),
    # South Asian
    _n("Patel", origin="south_asian"), _n("Singh", origin="south_asian"),
    _n("Ayesha", origin="south_asian"),
    # Haitian
    _n("Jean-Baptiste", "hyphenated", origin="haitian"),
    _n("Pierre-Louis", "hyphenated", origin="haitian"),
    _n("Saint-Fleur", "hyphenated", origin="haitian"),
]
