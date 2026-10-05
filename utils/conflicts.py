"""Arguable duplicates: options that must never appear together in a question.

Two options clash when
  - they share a common name (e.g. two species both called "White Hellebore"),
  - the GBIF backbone treats them as the same species or genus, or
  - the pair is listed in data/conflicts.json, the curated list for cases where
    a regional flora disagrees with iNaturalist, e.g. E-Flora BC treating
    Lamium hybridum as a variety of Lamium purpureum.

data/conflicts.json: [{"a": taxon id, "b": taxon id, "why": "..."}, ...]
The game reads the same file so Unlimited mode avoids these pairs too.
"""
import hashlib
import json
import os
import re
import time
import urllib.parse

import requests

ROOT = os.path.join(os.path.dirname(__file__), "..")
CONFLICTS = os.path.join(ROOT, "data", "conflicts.json")
CACHE = os.path.join(os.path.dirname(__file__), ".cache")


def load():
    if not os.path.exists(CONFLICTS):
        return []
    return json.load(open(CONFLICTS))


def add(a, b, why):
    pairs = load()
    if not any({p["a"], p["b"]} == {a, b} for p in pairs):
        pairs.append({"a": a, "b": b, "why": why})
        with open(CONFLICTS, "w") as f:
            json.dump(pairs, f, indent=1, ensure_ascii=False)


def _common_key(s):
    return re.sub(r"[^a-z]", "", (s or "").lower())


def _gbif(name, rank):
    url = "https://api.gbif.org/v1/species/match?" + urllib.parse.urlencode({"name": name, "rank": rank.upper()})
    key = os.path.join(CACHE, "gbif-" + hashlib.sha1(url.encode()).hexdigest() + ".json")
    if os.path.exists(key):
        return json.load(open(key))
    time.sleep(0.1)
    d = requests.get(url, timeout=30).json()
    os.makedirs(CACHE, exist_ok=True)
    json.dump(d, open(key, "w"))
    return d


def _gbif_key(opt, rank):
    if rank not in ("species", "genus"):
        return None
    d = _gbif(opt["name"], rank)
    if d.get("matchType") != "EXACT":
        return None
    return d.get("speciesKey" if rank == "species" else "genusKey")


def clash(x, y, rank, pairs=None):
    """True if options x and y ({id, name, common}) are arguably the same taxon."""
    pairs = load() if pairs is None else pairs
    if any({p["a"], p["b"]} == {x["id"], y["id"]} for p in pairs):
        return True
    cx, cy = _common_key(x.get("common")), _common_key(y.get("common"))
    if cx and cx == cy:
        return True
    kx, ky = _gbif_key(x, rank), _gbif_key(y, rank)
    return kx is not None and kx == ky
