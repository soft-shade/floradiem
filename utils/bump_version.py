"""Stamp a new build version into every place that needs it.

    python utils/bump_version.py            # today's date + next letter
    python utils/bump_version.py 20261101a  # explicit

Rewrites window.PD_VER in index.html and tree.html and data/version.json.
Pages fetch their CSS/JS/data with ?v=PD_VER, and common.js reloads a stale
cached page when data/version.json names a newer build, so bump on every
deploy.
"""
import datetime as dt
import json
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(__file__), "..")
PAGES = ["index.html", "tree.html"]
VERSION_FILE = os.path.join(ROOT, "data", "version.json")


def current():
    return json.load(open(VERSION_FILE))["v"]


def next_version(cur):
    """Versions must sort upward (common.js reloads only for a greater one),
    so if the current stamp is dated later than today, keep its date."""
    today = dt.datetime.now().strftime("%Y%m%d")
    base = max(today, cur[:8])
    if cur.startswith(base) and cur[-1].isalpha() and cur[-1] < "z":
        return base + chr(ord(cur[-1]) + 1)
    return base + "a"


def main():
    cur = current()
    new = sys.argv[1] if len(sys.argv) > 1 else next_version(cur)
    for page in PAGES:
        path = os.path.join(ROOT, page)
        s = open(path).read()
        s2, n = re.subn(r"window\.PD_VER = '[^']*'", f"window.PD_VER = '{new}'", s)
        assert n == 1, f"{page}: expected one PD_VER line, found {n}"
        with open(path, "w") as f:
            f.write(s2)
    with open(VERSION_FILE, "w") as f:
        f.write(json.dumps({"v": new}) + "\n")
    print(cur, "->", new)


if __name__ == "__main__":
    main()
