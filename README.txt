Floradiem — a daily plant identification game by Softshade
https://soft-shade.github.io/floradiem/

Each day: photos of one plant, fungus, lichen, seaweed or slime mold that
softshade has a research-grade iNaturalist observation of in British
Columbia (topped up to at least 10 photos with other observers' BC photos,
linked from iNaturalist). Pick the kingdom, phylum, class, order, family,
genus and species from four options; each answer comes with notes on what
sets the group apart.

Unlimited: species drawn live from iNaturalist's research-grade
observations (plants, fungi, chromists, protozoa). With no filter the pool
is worldwide, the 100,000 most-observed species, drawn with index = N·u³ so
often-observed species come up more but the long tail still appears. The
player can narrow it to a place, an iNaturalist user and/or a project
(iNat autocomplete endpoints); photos from those observations are shown
first, topped up from everyone's. A species needs at least 10 photos, and
species already on the player's current Unlimited tree are skipped until
the pool has nothing else.
Wrong answers are the most-observed worldwide members of the same group.

Species trees (tree.html): every solved Daily and Unlimited puzzle is added
to the player's circular tree of life (ete3 poster style, drawn as SVG),
one tree per mode, with the points earned beside each species. A tree holds
250 species; the 251st starts a new one and earlier trees stay linked.

Scoring (Daily and Unlimited): a run always goes down to species. Each
correct answer is worth 1 point until the first miss. A miss doesn't end the
run or reveal the answer: that option turns red with its notes and you pick
again. After one miss every correct answer (including the rank missed on) is
worth 1/2, after two 1/3, then 1/4 ... Kept to 3 decimals, shown to 2; 7 is
perfect.
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
                                download photos to assets/daily/, top up to
                                10 photos from other observers (hotlinked)
    utils/build_dailies.py --photos
                                top up existing days with < 10 photos
    utils/check_explanations.py validate data/explanations/ (shape, every
                                option covered, no deeper-rank spoilers)
    API responses are cached in utils/.cache (delete to refresh).

Explanations
    data/explanations/YYYY-MM-DD.json are researched by hand (with sources)
    a month ahead. Run check_explanations.py before committing new ones.

Deploy
    GitHub Pages from main. Run utils/bump_version.py before each deploy:
    it stamps PD_VER in index.html and tree.html and data/version.json.
    CSS, JS and data load with ?v=PD_VER; common.js fetches version.json
    uncached (on load and when the tab regains focus) and reloads once if
    a newer build is live, so a cached page can't stay stale.

Testing without Node
    Headless Chromium (snap) can't write outside $HOME, and headless Firefox
    needs an absolute --screenshot= path and its own --profile. Throwaway
    pages that seed localStorage and then load the real scripts work for
    both; window.PD_DEBUG exposes the game state.

Stats
    (Keys and collections still use the original name, plantdiem.)
    localStorage key plantdiem_stats (js/common.js holds the schema, the
    merge rules and the tree helpers shared with tree.html). When signed in
    with Google, synced to Firebase project worm-game-bdd29 (shared with
    worm-game):
      plantdiem_stats/{uid}          per-player stats (version 3: a guess
                                     list per daily, plus trees.daily /
                                     trees.unlimited entry lists and a
                                     shared taxa name table; older records
                                     are upgraded on load)
      plantdiem_aggregates/{date}    score distribution, bucketed by floor
    These collections need Firestore rules, e.g.

      match /plantdiem_stats/{uid} {
        allow read, write: if request.auth != null && request.auth.uid == uid;
      }
      match /plantdiem_aggregates/{date} {
        allow read: if true;
        allow write: if request.auth != null;
      }
