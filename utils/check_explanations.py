"""Validate data/explanations/*.json against the daily puzzles.

    python check_explanations.py [DATE ...]

Each explanations file must look like
    {"date": "YYYY-MM-DD",
     "ranks": {"kingdom": {"summary": str, "options": {"<taxon id>": str, ...}}, ...},
     "sources": [{"title": str, "url": str}, ...]}
with an entry for every rank and every option id in the daily file, and no
text at one rank may give away the answer at a deeper rank.
"""
import glob
import json
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(__file__), "..")


def words(s):
    return re.findall(r"[a-z]+", s.lower())


def check(date):
    errs = []
    daily = json.load(open(os.path.join(ROOT, "data", "daily", date + ".json")))
    path = os.path.join(ROOT, "data", "explanations", date + ".json")
    if not os.path.exists(path):
        return ["missing file"]
    ex = json.load(open(path))
    if ex.get("date") != date:
        errs.append("date field mismatch")
    if not ex.get("sources"):
        errs.append("no sources")
    for i, r in enumerate(daily["ranks"]):
        e = ex.get("ranks", {}).get(r["rank"])
        if not e:
            errs.append(f"{r['rank']}: missing")
            continue
        if len(e.get("summary", "")) < 40:
            errs.append(f"{r['rank']}: summary too short")
        want = {str(o["id"]) for o in r["options"]}
        have = set(e.get("options", {}))
        if want != have:
            errs.append(f"{r['rank']}: option ids {sorted(have)} != {sorted(want)}")
        for k, v in e.get("options", {}).items():
            if len(v) < 20:
                errs.append(f"{r['rank']}: option {k} text too short")

        # Spoilers: names of the answer at deeper ranks must not appear here.
        text = " ".join([e.get("summary", "")] + list(e.get("options", {}).values()))
        tw = " " + " ".join(words(text)) + " "
        for deeper in daily["ranks"][i + 1:]:
            ans = next(o for o in deeper["options"] if o["id"] == deeper["answer"])
            sci = ans["name"]
            if deeper["rank"] == "species":
                sci = sci.split()[-1]          # epithet; the genus is checked at its own rank
            for name in (sci, ans["common"]):
                w = " ".join(words(name))
                # Shared everyday words (e.g. 'clover') are only flagged as the full name.
                if w and len(w) > 3 and f" {w} " in tw:
                    errs.append(f"{r['rank']}: mentions deeper answer '{name}' ({deeper['rank']})")
    return errs


def main(dates):
    if not dates:
        dates = sorted(os.path.basename(f)[:-5] for f in glob.glob(os.path.join(ROOT, "data", "daily", "*.json")))
    bad = 0
    for d in dates:
        errs = check(d)
        print(d, "OK" if not errs else "")
        for e in errs:
            print("   ", e)
        bad += bool(errs)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main(sys.argv[1:])
