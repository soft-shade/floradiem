"""Small iNaturalist API client: polite rate limit + on-disk response cache."""
import hashlib
import json
import os
import time
import urllib.parse

import requests

API = "https://api.inaturalist.org/v1/"
CACHE = os.path.join(os.path.dirname(__file__), ".cache")
HEADERS = {"User-Agent": "Plantdiem data builder (github.com/soft-shade/plantdiem)"}

BC_PLACE = 7085
PLANTS_AND_ALGAE = "47126,48220"   # Plantae (incl. red algae) + Phaeophyceae (brown algae)
MAIN_RANKS = ["kingdom", "phylum", "class", "order", "family", "genus", "species"]

_last = 0.0


def get(path, **params):
    """GET an API path, cached forever on disk (delete utils/.cache to refresh)."""
    global _last
    url = API + path + ("?" + urllib.parse.urlencode(params) if params else "")
    key = os.path.join(CACHE, hashlib.sha1(url.encode()).hexdigest() + ".json")
    if os.path.exists(key):
        with open(key) as f:
            return json.load(f)
    for attempt in range(5):
        wait = 1.1 - (time.time() - _last)   # iNat asks for <= ~60 requests/minute
        if wait > 0:
            time.sleep(wait)
        _last = time.time()
        r = requests.get(url, headers=HEADERS, timeout=60)
        if r.status_code == 429 or r.status_code >= 500:
            time.sleep(10 * (attempt + 1))
            continue
        r.raise_for_status()
        data = r.json()
        os.makedirs(CACHE, exist_ok=True)
        with open(key, "w") as f:
            json.dump(data, f)
        return data
    raise RuntimeError(f"iNat API kept failing: {url}")


def get_all(path, per_page=200, **params):
    """All results of a paged endpoint."""
    out, page = [], 1
    while True:
        data = get(path, per_page=per_page, page=page, **params)
        out += data["results"]
        if not data["results"] or len(out) >= data["total_results"]:
            return out
        page += 1


def taxa_by_id(ids):
    """{id: taxon} for many ids, 30 per request."""
    ids = sorted(set(ids))
    out = {}
    for i in range(0, len(ids), 30):
        for t in get("taxa/" + ",".join(map(str, ids[i:i + 30])))["results"]:
            out[t["id"]] = t
    return out
