"""Recall scorer. Overlap-lenient primary, exact secondary; per-bucket; plus the
hyphenated boundary-leak gap (overlap - exact). Pure, stdlib-only."""
import json


def overlaps(g: dict, p: dict) -> bool:
    return g["start"] < p["end"] and p["start"] < g["end"]


def exact(g: dict, p: dict) -> bool:
    return g["start"] == p["start"] and g["end"] == p["end"]


def load_jsonl(path: str) -> dict[str, dict]:
    out: dict[str, dict] = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rec = json.loads(line)
                out[rec["id"]] = rec
    return out


def _hit(gold_span: dict, preds: list[dict], match) -> bool:
    return any(match(gold_span, p) for p in preds)


def _agg(table: dict, key: str, ov: bool, ex: bool) -> None:
    slot = table.setdefault(key, {"ov": 0, "ex": 0, "n": 0})
    slot["ov"] += ov
    slot["ex"] += ex
    slot["n"] += 1


def recall(gold_cases: dict, pred_cases: dict, _unused=None) -> dict:
    g_ov = g_ex = total = 0
    buckets: dict[str, dict] = {}
    origins: dict[str, dict] = {}
    for cid, gcase in gold_cases.items():
        preds = pred_cases.get(cid, {}).get("spans", [])
        for gs in gcase["spans"]:
            total += 1
            ov = _hit(gs, preds, overlaps)
            ex = _hit(gs, preds, exact)
            g_ov += ov
            g_ex += ex
            for b in gs.get("buckets", []):
                _agg(buckets, b, ov, ex)
            if gs.get("origin"):
                _agg(origins, gs["origin"], ov, ex)

    def ratio(hit, n):
        return round(hit / n, 4) if n else 0.0

    def summarize(table):
        return {
            k: {"overlap": ratio(s["ov"], s["n"]), "exact": ratio(s["ex"], s["n"]), "n": s["n"]}
            for k, s in sorted(table.items())
        }

    per_bucket = summarize(buckets)
    hyph = per_bucket.get("hyphenated", {"overlap": 0.0, "exact": 0.0})
    return {
        "global": {"overlap": ratio(g_ov, total), "exact": ratio(g_ex, total)},
        "per_bucket": per_bucket,
        "per_origin": summarize(origins),
        "boundary_leak_hyphenated": round(hyph["overlap"] - hyph["exact"], 4),
    }
