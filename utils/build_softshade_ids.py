"""Build data/softshade_ids.json: species softshade has identified at least once
in BC (on their own or anyone's observation, any quality grade) that are also
in data/bc_tree.json, so they have photos and a full lineage.

Unlimited mode draws from this list 80% of the time.
"""
import json
import os

from inat import BC_PLACE, POOL_TAXA, get_all

ROOT = os.path.join(os.path.dirname(__file__), "..")


def main():
    tree = json.load(open(os.path.join(ROOT, "data", "bc_tree.json")))["taxa"]
    rows = get_all("identifications/species_counts", per_page=500, user_id="softshade",
                   place_id=BC_PLACE, taxon_id=POOL_TAXA)
    ids = sorted({r["taxon"]["id"] for r in rows if str(r["taxon"]["id"]) in tree
                  and tree[str(r["taxon"]["id"])][2] == 6})
    print(len(rows), "identified taxa,", len(ids), "usable species")
    with open(os.path.join(ROOT, "data", "softshade_ids.json"), "w") as f:
        json.dump(ids, f, separators=(",", ":"))


if __name__ == "__main__":
    main()
