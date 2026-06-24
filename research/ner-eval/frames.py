"""Free-text sentence frames with {name} slots. Buckets are frame-intrinsic
(no_salutation, possessive, english_mixed) — name-intrinsic buckets are added
by the name, casing/typos by the pipeline."""
from dataclasses import dataclass


@dataclass(frozen=True)
class Frame:
    template: str
    buckets: tuple[str, ...]


def _f(template: str, *buckets: str) -> Frame:
    return Frame(template=template, buckets=tuple(buckets))


FRAME_BANK: list[Frame] = [
    _f("je vous écris pour dire que {name} ne sera pas au cours aujourd'hui", "no_salutation"),
    _f("{name} sera pas là demain, elle est malade", "no_salutation"),
    _f("la mère de {name} vous remercie pour la saison", "no_salutation", "possessive"),
    _f("le père de {name} va venir le chercher après la pratique", "no_salutation", "possessive"),
    _f("mon fils {name} a oublié son chandail au gymnase", "no_salutation", "possessive"),
    _f("ma fille {name} adore son sport cette année", "no_salutation", "possessive"),
    _f("est-ce que {name} peut manquer le tournoi de samedi", "no_salutation"),
    _f("{name} et son équipe ont bien joué en fin de semaine", "no_salutation"),
    _f("merci de prévenir {name} pour le changement d'horaire", "no_salutation"),
    _f("just so you know, {name} will miss practice tonight", "no_salutation", "english_mixed"),
    _f("{name} is feeling sick, elle reste à la maison aujourd'hui", "no_salutation", "english_mixed"),
    _f("on va inscrire {name} au camp d'été cette année", "no_salutation"),
    _f("pouvez-vous confirmer la place de {name} dans l'équipe", "no_salutation", "possessive"),
    _f("l'entraîneur a parlé à {name} après le match", "no_salutation"),
]
