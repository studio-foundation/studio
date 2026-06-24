from runners.mapping import map_presidio, map_spacy, map_gliner, select_best_label


class _Obj:
    def __init__(self, **kw):
        self.__dict__.update(kw)


def test_map_presidio_keeps_person_only():
    res = [_Obj(entity_type="PERSON", start=0, end=4),
           _Obj(entity_type="LOCATION", start=5, end=9)]
    assert map_presidio(res) == [{"start": 0, "end": 4}]


def test_map_spacy_keeps_per_only():
    ents = [_Obj(label_="PER", start_char=2, end_char=7),
            _Obj(label_="MISC", start_char=8, end_char=10)]
    assert map_spacy(ents) == [{"start": 2, "end": 7}]


def test_map_gliner_passthrough():
    ents = [{"start": 1, "end": 5, "label": "personne", "text": "rose"}]
    assert map_gliner(ents) == [{"start": 1, "end": 5}]


def test_select_best_label_picks_higher_recall():
    gold = {"c0": {"spans": [{"start": 0, "end": 4, "buckets": ["x"]}]}}
    preds_by_label = {
        "prénom": {"c0": {"spans": []}},                       # recall 0
        "personne": {"c0": {"spans": [{"start": 0, "end": 4}]}},# recall 1
    }
    label, rec = select_best_label(gold, preds_by_label)
    assert label == "personne" and rec == 1.0
