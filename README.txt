Floradiem — a daily plant identification game by Softshade
https://soft-shade.github.io/floradiem/

Each day: photos of one plant (or red/brown alga) that softshade has a
research-grade iNaturalist observation of in British Columbia. Pick the
kingdom, phylum, class, order, family, genus and species from four options;
each answer comes with notes on what sets the group apart.

Scoring: 1 point per rank on the puzzle's own day. The same puzzle can be
retried once a day for 7 days; day j's run (ranks right before the first miss)
becomes decimal digit j, e.g. 1 -> 1.2 -> 1.22. A perfect 7 locks the puzzle.

Run locally
    python3 -m http.server 8766        then open http://127.0.0.1:8766/
    Add ?date=YYYY-MM-DD to pretend it's another day (testing).

Data (Python 3 + requests + Pillow)
    utils/build_bc_tree.py      data/bc_tree.json: BC plant taxonomy from
                                iNaturalist (wrong answers + Unlimited pool)
    utils/build_dailies.py START N
                                pick N new daily species from softshade's
                                BC research-grade plants, write data/daily/,
                                download photos to assets/daily/
    utils/check_explanations.py validate data/explanations/ (shape, every
                                option covered, no deeper-rank spoilers)
    API responses are cached in utils/.cache (delete to refresh).

Explanations
    data/explanations/YYYY-MM-DD.json are researched by hand (with sources)
    a month ahead. Run check_explanations.py before committing new ones.

Deploy
    GitHub Pages from main. Bump PD_VER (and the ?v= on css/js) in
    index.html on each deploy to bust caches.

Stats
    (Keys and collections still use the original name, plantdiem.)
    localStorage key plantdiem_stats. When signed in with Google, synced to
    Firebase project worm-game-bdd29 (shared with worm-game):
      plantdiem_stats/{uid}          per-player stats
      plantdiem_aggregates/{date}    first-attempt depth distribution
    These collections need Firestore rules, e.g.

      match /plantdiem_stats/{uid} {
        allow read, write: if request.auth != null && request.auth.uid == uid;
      }
      match /plantdiem_aggregates/{date} {
        allow read: if true;
        allow write: if request.auth != null;
      }
