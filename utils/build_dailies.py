"""Pick daily puzzles from softshade's research-grade BC plant observations.

    python build_dailies.py START_DATE N_DAYS
    python build_dailies.py --fill      # top up ranks with < 4 options

writes data/daily/YYYY-MM-DD.json (species, answer options at each rank,
photo list) and downloads that day's photos to assets/daily/YYYY-MM-DD/.
Species already used by an existing daily file are never picked again.
Explanations are researched separately into data/explanations/.
"""
import datetime as dt
import glob
import io
import json
import os
import random
import sys

import requests
from PIL import Image

from inat import BC_PLACE, HEADERS, MAIN_RANKS, PLANTS_AND_ALGAE, get, get_all

ROOT = os.path.join(os.path.dirname(__file__), "..")
USER = "softshade"
EPOCH = dt.date(2026, 10, 5)       # puzzle #1
KINGDOMS = {47126: ("Plantae", "Plants"), 48222: ("Chromista", "kelp, diatoms, and allies"),
            47170: ("Fungi", "Fungi Including Lichens"), 47686: ("Protozoa", "protozoans")}
PHOTO_MAX = 1280

tree = json.load(open(os.path.join(ROOT, "data", "bc_tree.json")))["taxa"]
tree = {int(k): v for k, v in tree.items()}


def opt(tid, name=None, common=None):
    if tid in tree and name is None:
        name, common = tree[tid][0], tree[tid][1]
    return {"id": tid, "name": name, "common": common or ""}


def lineage(sid):
    out = []
    while sid:
        out.append(sid)
        sid = tree[sid][3]
    return out[::-1]


def distractors(answer, rank_i, rng, have=()):
    """Wrong answers until there are three: siblings that also occur in BC
    (weighted toward common ones), then worldwide siblings; if the group has
    no other members, cousins from the next group up (BC first, then world),
    climbing until three are found."""
    out = [opt(t) if isinstance(t, int) else t for t in have]
    taken = {answer} | {o["id"] for o in out}
    rank = MAIN_RANKS[rank_i]
    for anc in lineage(answer)[-2::-1]:          # parent, grandparent, ...
        if len(out) >= 3:
            break
        bc = sorted((t for t, v in tree.items()
                     if v[2] == rank_i and t not in taken and anc in lineage(t)), key=lambda t: -tree[t][4])
        for t in rng.sample(bc[:8], min(3 - len(out), len(bc[:8]))):
            out.append(opt(t)); taken.add(t)
        if len(out) < 3:
            world = get("taxa", taxon_id=anc, rank=rank, is_active="true",
                        order_by="observations_count", per_page=12)["results"]
            for t in world:
                if len(out) < 3 and t["id"] not in taken and t["rank"] == rank:
                    out.append(opt(t["id"], t["name"], t.get("preferred_common_name"))); taken.add(t["id"])
    return out


def fill_short_ranks():
    """Top up existing puzzles whose ranks have fewer than 4 options, keeping
    the options already there (explanations may already cover them)."""
    for f in sorted(glob.glob(os.path.join(ROOT, "data", "daily", "*.json"))):
        p = json.load(open(f))
        changed = False
        for i, r in enumerate(p["ranks"]):
            if len(r["options"]) < 4 and i > 0:
                wrong = [o for o in r["options"] if o["id"] != r["answer"]]
                new = distractors(r["answer"], i, random.Random(f"fill-{p['date']}-{i}"), wrong)
                added = [o for o in new if o not in wrong]
                r["options"] += added
                changed = True
                print(p["date"], r["rank"], "+", [o["name"] for o in added])
        if changed:
            with open(f, "w") as fh:
                json.dump(p, fh, indent=1, ensure_ascii=False)


def credit(attribution):
    # CC0 photos come back as just "no rights reserved"; name the photographer anyway.
    return attribution if USER in attribution else f"Photo: {USER}, {attribution} (CC0)"


def download_photos(sid, day):
    obs = get_all("observations", user_id=USER, taxon_id=sid, quality_grade="research",
                  place_id=BC_PLACE, photos="true", order_by="observed_on")
    folder = os.path.join(ROOT, "assets", "daily", day)
    os.makedirs(folder, exist_ok=True)
    photos = []
    for o in obs:
        for p in o["photos"]:
            n = len(photos) + 1
            path = os.path.join(folder, f"{n:02d}.jpg")
            if not os.path.exists(path):
                url = p["url"].replace("/square.", "/original.")
                img = Image.open(io.BytesIO(requests.get(url, headers=HEADERS, timeout=60).content))
                img = img.convert("RGB")
                img.thumbnail((PHOTO_MAX, PHOTO_MAX), Image.LANCZOS)
                img.save(path, quality=82, optimize=True, progressive=True)
            photos.append({"src": f"assets/daily/{day}/{n:02d}.jpg",
                           "obs": o["uri"], "attribution": credit(p["attribution"]),
                           "observed": o.get("observed_on")})
    return photos


def main(start, n_days):
    used = set()
    for f in glob.glob(os.path.join(ROOT, "data", "daily", "*.json")):
        used.add(json.load(open(f))["species"]["id"])
    pool = get_all("observations/species_counts", per_page=500, user_id=USER, place_id=BC_PLACE,
                   quality_grade="research", taxon_id=PLANTS_AND_ALGAE)
    # Only species whose full 7-rank lineage is known.
    candidates = sorted({r["taxon"]["id"] for r in pool
                         if r["taxon"]["id"] in tree and tree[r["taxon"]["id"]][2] == 6
                         and len(lineage(r["taxon"]["id"])) == 7} - used)
    rng = random.Random(f"plantdiem-{start}")
    rng.shuffle(candidates)
    print(len(candidates), "unused candidate species")

    for i in range(n_days):
        day = (start + dt.timedelta(days=i)).isoformat()
        out = os.path.join(ROOT, "data", "daily", day + ".json")
        if os.path.exists(out):
            print(day, "exists, skipped")
            continue
        sid = candidates.pop()
        ranks = []
        for rank_i, tid in enumerate(lineage(sid)):
            wrong = [opt(k, *v) for k, v in KINGDOMS.items() if k != tid] if rank_i == 0 else distractors(tid, rank_i, rng)
            options = [opt(tid)] + wrong
            rng.shuffle(options)
            ranks.append({"rank": MAIN_RANKS[rank_i], "answer": tid, "options": options})
        puzzle = {"date": day, "number": (start + dt.timedelta(days=i) - EPOCH).days + 1,
                  "species": opt(sid), "ranks": ranks, "photos": download_photos(sid, day)}
        with open(out, "w") as f:
            json.dump(puzzle, f, indent=1, ensure_ascii=False)
        print(day, puzzle["species"]["name"], "-", puzzle["species"]["common"],
              len(puzzle["photos"]), "photos")

    days = sorted(os.path.basename(f)[:-5] for f in glob.glob(os.path.join(ROOT, "data", "daily", "*.json")))
    with open(os.path.join(ROOT, "data", "daily_index.json"), "w") as f:
        json.dump({"epoch": EPOCH.isoformat(), "days": days}, f)


if __name__ == "__main__":
    if sys.argv[1] == "--fill":
        fill_short_ranks()
    else:
        main(dt.date.fromisoformat(sys.argv[1]), int(sys.argv[2]))
