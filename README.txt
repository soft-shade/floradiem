Floradiem — a daily plant identification game by Softshade
https://soft-shade.github.io/floradiem/

Each day: photos of one plant (or red/brown alga) that softshade has a
research-grade iNaturalist observation of in British Columbia. Pick the
kingdom, phylum, class, order, family, genus and species from four options;
each answer comes with notes on what sets the group apart.

Scoring (Daily and Unlimited): a run always goes down to species. Each
correct answer is worth 1 point until the first miss. A miss doesn't end the
run or reveal the answer: that option turns red with its notes and you pick
again. After one miss every correct answer (including the rank missed on) is
worth 1/2, after two 1/3, then 1/4 ... Rounded to 3 decimals; 7 is perfect.
The daily only counts on its own date; the past week's puzzles can be
replayed as practice without touching the score.

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
      plantdiem_stats/{uid}          per-player stats (version 2: a guess
                                     list per daily; v1 attempt records are
                                     upgraded on load, day-0 run = score)
      plantdiem_aggregates/{date}    score distribution, bucketed by floor
    These collections need Firestore rules, e.g.

      match /plantdiem_stats/{uid} {
        allow read, write: if request.auth != null && request.auth.uid == uid;
      }
      match /plantdiem_aggregates/{date} {
        allow read: if true;
        allow write: if request.auth != null;
      }
