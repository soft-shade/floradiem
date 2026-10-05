"""Build data/bc_tree.json: every plant, fungus (incl. lichens), chromist and protozoan species with
research-grade observations in British Columbia, with its main-rank lineage.

The game uses it to pick plausible wrong answers (siblings that also grow in
BC) and as the species pool for Unlimited mode.

    taxa: {id: [scientific name, common name, rank index, parent id, BC obs count]}

rank index follows inat.MAIN_RANKS; parent id is the nearest main-rank ancestor
(0 for kingdoms). Counts at higher ranks are summed from their species.
"""
import json
import os

from inat import BC_PLACE, MAIN_RANKS, POOL_TAXA, get_all, taxa_by_id

OUT = os.path.join(os.path.dirname(__file__), "..", "data", "bc_tree.json")


def main():
    leaves = get_all("observations/species_counts", per_page=500, place_id=BC_PLACE,
                     quality_grade="research", taxon_id=POOL_TAXA)
    print(len(leaves), "leaf taxa")
    ancestry = {t["taxon"]["id"]: t["taxon"]["ancestor_ids"] for t in leaves}
    info = taxa_by_id({a for anc in ancestry.values() for a in anc})
    print(len(info), "taxa fetched")

    taxa = {}
    for r in leaves:
        lineage = [info[a] for a in r["taxon"]["ancestor_ids"] if a in info]
        main = [t for t in lineage if t["rank"] in MAIN_RANKS]
        if not main or main[-1]["rank"] != "species":
            continue   # leaf above species (e.g. genus-only) or odd lineage
        parent = 0
        for t in main:
            if t["id"] not in taxa:
                taxa[t["id"]] = [t["name"], t.get("preferred_common_name") or "",
                                 MAIN_RANKS.index(t["rank"]), parent, 0]
            taxa[t["id"]][4] += r["count"]
            parent = t["id"]

    n_species = sum(1 for t in taxa.values() if t[2] == 6)
    print(n_species, "species,", len(taxa), "taxa in tree")
    with open(OUT, "w") as f:
        json.dump({"ranks": MAIN_RANKS, "taxa": taxa}, f, separators=(",", ":"), ensure_ascii=False)
    print("wrote", OUT, os.path.getsize(OUT) // 1024, "KB")


if __name__ == "__main__":
    main()
