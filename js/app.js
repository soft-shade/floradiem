/* Floradiem — daily plant identification game.
 *
 * Scoring (Daily and Unlimited alike): a run always goes from Kingdom down to
 * Species. Every correct answer scores 1 point until the first miss. A miss
 * doesn't end the run or reveal the answer: that option turns red with notes
 * on why it isn't the one, and you pick again at the same rank. After one miss
 * each correct answer is worth 1/2, after two 1/3, then 1/4 and so on. Scores
 * are rounded to three decimals; 7 is perfect.
 *
 * The daily puzzle only counts on its own date. Puzzles from the past week can
 * be replayed as practice, which never touches the score or stats.
 *
 * Unlimited draws its species live from iNaturalist: by default from research-
 * grade observations worldwide (weighted toward often-observed species), or
 * narrowed to a place, an observer or a project. Every solved puzzle is added
 * to the player's species tree (tree.html); see common.js.
 */
(function () {
  'use strict';

  const C = window.PDC;
  const { RANKS, STATS_KEY, cap, esc, round3, fmtScore, shortName } = C;
  const VER = window.PD_VER || '';
  const WINDOW_DAYS = 7;          // how long a daily stays in the picker (for practice)
  const TZ = 'America/Vancouver';
  const SITE = 'https://soft-shade.github.io/floradiem/';
  const FILTER_KEY = 'plantdiem_unl_filter';
  const API = 'https://api.inaturalist.org/v1/';
  const POOL_TAXA = '47126,47170,48222,47686';   // Plantae, Fungi (incl. lichens), Chromista, Protozoa
  const PHOTO_MIN = 10;           // Unlimited: a species needs at least this many photos
  const PHOTO_MAX = 16;
  const PAGE = 500;               // species_counts page size
  const WORLD_CAP = 100000;       // worldwide pool: the most-observed species, this many deep
  const KINGDOMS = [
    { id: 47126, name: 'Plantae', common: 'Plants' },
    { id: 48222, name: 'Chromista', common: 'kelp, diatoms, and allies' },
    { id: 47170, name: 'Fungi', common: 'Fungi Including Lichens' },
    { id: 47686, name: 'Protozoa', common: 'protozoans' },
  ];

  const $ = (id) => document.getElementById(id);
  const track = (name, params) => { try { window.gtag && gtag('event', name, params); } catch (e) {} };

  // ---------------------------------------------------------------- dates
  function todayISO() {
    const forced = new URLSearchParams(location.search).get('date');   // testing aid
    if (forced && /^\d{4}-\d{2}-\d{2}$/.test(forced)) return forced;
    return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  }
  function addDays(iso, n) {
    const d = new Date(iso + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  const daysBetween = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);
  const prettyDate = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

  // Seeded shuffle so a run's option order survives a reload.
  function seededShuffle(arr, seedStr) {
    let h = 2166136261;
    for (const c of seedStr) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    const rnd = () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0) / 4294967296;
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  async function getJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(url + ' ' + r.status);
    return r.json();
  }

  // ---------------------------------------------------------------- scoring
  const pointLabel = (misses) => (misses ? `1/${misses + 1} pt` : '1 pt');

  // Walk a run's guesses in order. A correct guess scores 1/(misses so far + 1)
  // and moves down a rank; a wrong one adds a miss and stays at the same rank.
  function walkRun(guesses, ranks) {
    let level = 0, misses = 0, score = 0;
    const marks = [];                                   // per guess: correct?
    const wrongHere = [];                               // wrong ids at the current rank
    const wrongsAt = ranks.map(() => 0);                // misses per rank
    for (const id of guesses || []) {
      if (level >= ranks.length) break;
      const ok = id === ranks[level].answer;
      marks.push(ok);
      if (ok) { score += 1 / (misses + 1); level++; wrongHere.length = 0; }
      else { misses++; wrongsAt[level]++; wrongHere.push(id); }
    }
    return {
      level, misses, score: round3(score), marks, wrongHere, wrongsAt,
      done: level === ranks.length,
      last: marks.length ? marks[marks.length - 1] : null,
    };
  }
  const runEmoji = (run) => run.marks.map((m) => (m ? '🌿' : '🍂')).join('');

  // ---------------------------------------------------------------- stats
  let stats = C.loadStats();
  let authUser = null;

  // Another tab (or an old one left open) may have saved newer results, so
  // merge what's on disk before writing; a stale tab can only add, never erase.
  function saveStats(now) {
    try {
      const disk = JSON.parse(localStorage.getItem(STATS_KEY));
      if (disk && disk.daily) C.mergeInto(stats, disk);
      localStorage.setItem(STATS_KEY, JSON.stringify(stats));
    } catch (e) {}
    saveStatsRemote(now);
  }

  // Keep open tabs in step: pick up whatever another tab just saved.
  addEventListener('storage', (e) => {
    if (e.key !== STATS_KEY || !e.newValue) return;
    try {
      const other = JSON.parse(e.newValue);
      if (other && other.daily) C.mergeInto(stats, other);
      if (game.mode === 'daily' && game.index) renderPicker(todayISO());
      refreshModal();
    } catch (err) {}
  });

  // While signed in, every change is also written to Firestore. Writes are
  // debounced, except `now` (a finished run), which goes out right away, and
  // anything pending is flushed when the page is hidden or closed.
  let remoteTimer = null, lastRemote = 0, warnedSync = false;
  function saveStatsRemote(now) {
    if (!authUser || !window.PD_AUTH) return;
    clearTimeout(remoteTimer);
    remoteTimer = setTimeout(writeRemote, now ? Math.max(0, 1100 - (Date.now() - lastRemote)) : 1200);
  }
  // Read-merge-write, so a device or tab with an older copy can't erase
  // results another one already saved to Firestore.
  async function writeRemote() {
    clearTimeout(remoteTimer);
    remoteTimer = null;
    const A = window.PD_AUTH;
    if (!authUser || !A) return;
    lastRemote = Date.now();
    const ref = A.doc(A.db, 'plantdiem_stats', authUser.uid);
    try {
      const snap = await A.getDoc(ref);
      const remote = snap.exists() ? snap.data() : null;
      if (remote && remote.daily) {
        delete remote.last_write;
        C.mergeInto(stats, remote);
        try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch (e) {}
      }
      await A.setDoc(ref, Object.assign({}, stats, { last_write: A.serverTimestamp() }));
    } catch (e) {
      console.warn('stats write failed', e);
      if (!warnedSync) { warnedSync = true; toast("Couldn't sync your stats; they're still saved on this device"); }
    }
  }
  addEventListener('pagehide', () => { if (remoteTimer) writeRemote(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && remoteTimer) writeRemote(); });

  function initAuth() {
    const A = window.PD_AUTH;
    if (!A) return;
    A.onAuthStateChanged(A.auth, async (user) => {
      const was = authUser;
      authUser = user || null;
      if (user && (!was || was.uid !== user.uid)) {
        try {
          const snap = await A.getDoc(A.doc(A.db, 'plantdiem_stats', user.uid));
          const remote = snap.exists() ? snap.data() : null;
          if (remote && remote.daily) {
            delete remote.last_write;
            const before = JSON.stringify(remote);
            C.mergeInto(stats, remote);
            if (JSON.stringify(stats) !== before) saveStatsRemote(true);   // push back what only this device had
          } else {
            saveStatsRemote(true);   // first sign-in: seed the doc with local progress
          }
          try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch (e) {}
          if (game.mode === 'daily') openDaily(game.puzzle && game.puzzle.date);
          backfillDailyTree();
        } catch (e) { console.warn('remote stats fetch failed', e); }
      } else if (!user && was) {
        stats = C.loadStats();
      }
      refreshModal();
    });
  }
  if (window.PD_AUTH) initAuth(); else window.addEventListener('pd-auth-ready', initAuth, { once: true });

  function record(date) {
    const h = stats.daily.history;
    return h[date] || (h[date] = { guesses: [], done: false });
  }

  function bumpStreak(today) {
    const d = stats.daily;
    if (d.last_play_date === today) return;
    d.streak = d.last_play_date === addDays(today, -1) ? d.streak + 1 : 1;
    d.best_streak = Math.max(d.best_streak, d.streak);
    d.last_play_date = today;
  }

  // World stats: how players' scores spread, bucketed by whole point (7 = perfect).
  async function contributeAggregate(puzzle, bucket) {
    const A = window.PD_AUTH;
    const rec = record(puzzle.date);
    if (!authUser || !A || rec.aggregate_contributed) return;
    try {
      await A.setDoc(A.doc(A.db, 'plantdiem_aggregates', puzzle.date), {
        date: puzzle.date, puzzle_number: puzzle.number,
        distribution: { [String(bucket)]: A.increment(1) },
        total_plays: A.increment(1), last_updated: A.serverTimestamp(),
      }, { merge: true });
      rec.aggregate_contributed = true;
      saveStats(true);
    } catch (e) { console.warn('aggregate write failed', e); }
  }

  // ---------------------------------------------------------------- species trees
  // The answer at each rank of the current run, kingdom first.
  const answerLine = () => game.ranks.map((r) => r.options.find((o) => o.id === r.answer) || { id: r.answer, name: '', common: '' });

  function addDailyEntry(puzzle, score) {
    const line = puzzle.ranks.map((r) => r.options.find((o) => o.id === r.answer) || { id: r.answer, name: '', common: '' });
    return C.addEntry(stats, 'daily', { t: Date.parse(puzzle.date + 'T12:00:00Z'), id: puzzle.species.id, score, line, date: puzzle.date });
  }

  // Dailies solved before trees existed (or on another device that hasn't
  // caught up) are added from their puzzle files.
  let backfilled = false;
  async function backfillDailyTree() {
    if (backfilled) return;
    try { await loadIndex(); } catch (e) { return; }
    backfilled = true;
    const have = new Set(stats.trees.daily.map(C.entryKey));
    const h = stats.daily.history;
    const missing = Object.keys(h).filter((d) => h[d].done && h[d].score != null && !have.has(d) && game.index.days.includes(d)).sort();
    let added = false;
    for (const d of missing) {
      try {
        const p = await getJSON(`data/daily/${d}.json?v=${VER}`);
        if (addDailyEntry(p, h[d].score)) added = true;
      } catch (e) {}
    }
    if (added) { saveStats(); refreshModal(); }
  }

  // ---------------------------------------------------------------- state
  const game = {
    mode: 'daily',
    index: null,          // daily_index.json
    puzzle: null,         // current daily puzzle
    explain: null,        // its explanations file (or null)
    replay: false,        // practice run: nothing is saved
    replayN: 0,           // reshuffles options on each replay
    ranks: [],            // [{rank, answer, options:[{id,name,common}]}]
    guesses: [],          // every pick of the run, in order
    conflicts: null,      // curated pairs that never share a question
    filter: loadFilter(), // Unlimited: {place, user, project} or nulls
    pools: {},            // Unlimited: cached species_counts pages per filter
    siblings: {},         // Unlimited: cached taxa?taxon_id=..&rank=.. results
    uSerial: 0,           // bumps on every new Unlimited puzzle (stale fetches bail out)
  };
  const currentRun = () => walkRun(game.guesses, game.ranks);

  // ---------------------------------------------------------------- carousel
  function setPhotos(photos, revealLinks) {
    const car = $('carousel');
    car.innerHTML = photos.length ? photos.map((p, i) =>
      `<figure><img src="${esc(p.src)}" alt="Photo ${i + 1} of the mystery organism" loading="${i ? 'lazy' : 'eager'}" draggable="false"></figure>`).join('')
      : '<div class="loading">Loading photos…</div>';
    car.scrollLeft = 0;
    car._photos = photos;
    car._reveal = revealLinks;
    updateCarouselMeta();
  }
  function carouselIndex() {
    const car = $('carousel');
    return Math.round(car.scrollLeft / Math.max(1, car.clientWidth));
  }
  function updateCarouselMeta() {
    const car = $('carousel');
    const photos = car._photos || [];
    const i = Math.min(carouselIndex(), photos.length - 1);
    $('car-prev').hidden = $('car-next').hidden = photos.length < 2;
    $('car-count').textContent = photos.length ? `${i + 1} / ${photos.length}` : '';
    const p = photos[i];
    // Observation links name the species, so they only appear once revealed.
    $('car-attr').innerHTML = !p ? '' : car._reveal && p.obs
      ? `<a href="${esc(p.obs)}" target="_blank" rel="noopener">${esc(p.attribution)}</a>` : esc(p.attribution);
    $('car-hint').hidden = !photos.length;
    updateZoomUI();
  }

  // Zoom: the mouse wheel over a photo zooms around the pointer (instead of
  // scrolling the page), dragging pans while zoomed in, double-click resets.
  // A badge and shaded edges show when part of the photo is out of view.
  const ZOOM_MAX = 6;
  const zoomOf = (fig) => fig._z || (fig._z = { k: 1, x: 0, y: 0 });
  function currentFigure() {
    const car = $('carousel');
    const figs = car.querySelectorAll('figure');
    return figs[Math.min(carouselIndex(), figs.length - 1)] || null;
  }
  function applyZoom(fig) {
    const z = zoomOf(fig), img = fig.querySelector('img');
    const W = fig.clientWidth, H = fig.clientHeight;
    z.k = Math.min(ZOOM_MAX, Math.max(1, z.k));
    z.x = Math.min(0, Math.max(W - W * z.k, z.x));
    z.y = Math.min(0, Math.max(H - H * z.k, z.y));
    if (img) img.style.transform = z.k === 1 ? '' : `translate(${z.x}px, ${z.y}px) scale(${z.k})`;
    fig.classList.toggle('zoomed', z.k > 1);
    updateZoomUI();
  }
  function updateZoomUI() {
    const fig = currentFigure();
    const z = fig ? zoomOf(fig) : { k: 1, x: 0, y: 0 };
    const card = document.querySelector('.photo-card');
    const W = fig ? fig.clientWidth : 0, H = fig ? fig.clientHeight : 0;
    $('zoom-badge').hidden = z.k === 1;
    $('zoom-badge').textContent = `${z.k.toFixed(1)}× · drag to pan · double-click to reset`;
    card.classList.toggle('more-l', z.x < -1);
    card.classList.toggle('more-r', z.x > W - W * z.k + 1);
    card.classList.toggle('more-t', z.y < -1);
    card.classList.toggle('more-b', z.y > H - H * z.k + 1);
  }
  $('carousel').addEventListener('wheel', (e) => {
    const fig = e.target.closest('figure');
    if (!fig) return;
    e.preventDefault();
    const z = zoomOf(fig);
    const r = fig.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const k2 = Math.min(ZOOM_MAX, Math.max(1, z.k * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
    const s = k2 / z.k;
    z.x = px - (px - z.x) * s;
    z.y = py - (py - z.y) * s;
    z.k = k2;
    applyZoom(fig);
  }, { passive: false });
  let drag = null;
  $('carousel').addEventListener('pointerdown', (e) => {
    const fig = e.target.closest('figure');
    if (!fig || e.pointerType !== 'mouse' || e.button !== 0 || zoomOf(fig).k === 1) return;
    drag = { fig, x: e.clientX, y: e.clientY };
    fig.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  $('carousel').addEventListener('pointermove', (e) => {
    if (!drag) return;
    const z = zoomOf(drag.fig);
    z.x += e.clientX - drag.x; z.y += e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    applyZoom(drag.fig);
  });
  $('carousel').addEventListener('pointerup', () => { drag = null; });
  $('carousel').addEventListener('pointercancel', () => { drag = null; });
  $('carousel').addEventListener('dblclick', (e) => {
    const fig = e.target.closest('figure');
    if (!fig) return;
    fig._z = { k: 1, x: 0, y: 0 };
    applyZoom(fig);
  });
  function stepCarousel(dir) {
    const car = $('carousel');
    const n = (car._photos || []).length;
    if (n < 2) return;
    const i = (carouselIndex() + dir + n) % n;
    car.scrollTo({ left: i * car.clientWidth, behavior: 'smooth' });
  }
  $('car-prev').onclick = () => stepCarousel(-1);
  $('car-next').onclick = () => stepCarousel(1);
  $('carousel').addEventListener('scroll', () => requestAnimationFrame(updateCarouselMeta), { passive: true });
  $('carousel').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') stepCarousel(-1);
    if (e.key === 'ArrowRight') stepCarousel(1);
  });

  // ---------------------------------------------------------------- ladder + question
  // `closed`: the run is over even though it didn't reach Species (old records).
  function renderLadder(closed) {
    const run = currentRun();
    $('ladder').innerHTML = RANKS.map((r, i) => {
      let cls = '', label = '·';
      const ans = game.ranks[i] && game.ranks[i].options.find((o) => o.id === game.ranks[i].answer);
      if (i < run.level) {
        cls = run.wrongsAt[i] ? 'ok retry' : 'ok';
        label = ans ? shortName(ans.name, RANKS[i]) : '';
      } else if (i === run.level && !run.done) {
        if (closed) { cls = 'miss'; label = ans ? shortName(ans.name, RANKS[i]) : ''; }
        else cls = 'current';
      }
      const tip = cap(r) + (i < run.level && run.wrongsAt[i] ? ` · ${run.wrongsAt[i]} miss${run.wrongsAt[i] > 1 ? 'es' : ''}` : '');
      return `<li class="${cls}" title="${esc(tip)}"><b>${cap(r)}</b>${esc(label)}</li>`;
    }).join('');
  }

  function optionHTML(o, i, stateCls, rank) {
    const tip = o.common ? cap(o.common) : '';
    const locked = /locked/.test(stateCls);
    return `<div class="opt ${stateCls}">
      <button class="opt-main" data-i="${i}" ${locked ? 'disabled' : ''}>${esc(shortName(o.name, rank))}${tip ? `<span class="common">${esc(tip)}</span>` : ''}</button>
    </div>`;
  }

  const modeNote = () => game.mode === 'daily' ? (game.replay ? 'Practice' : 'Daily') : 'Unlimited · ' + filterSummary();

  // The question for the current rank. Options already guessed wrong stay
  // red and disabled, with their notes below, and the player picks again.
  async function renderQuestion() {
    renderLadder();
    const run = currentRun();
    const level = run.level;
    const r = game.ranks[level];
    const opts = currentOptions(level);
    const wrong = new Set(run.wrongHere);
    const note = `${modeNote()} · ${pointLabel(run.misses)} per correct answer`;
    $('stage').innerHTML = `
      <div class="prompt">${cap(r.rank)}?<small>${esc(note)}</small></div>
      <div class="options">${opts.map((o, i) => optionHTML(o, i, wrong.has(o.id) ? 'locked chosen-wrong' : '', r.rank)).join('')}</div>
      ${wrong.size ? `<div class="verdict miss">✗ Not quite — pick again. Correct answers are now worth ${pointLabel(run.misses)}.</div>
      <div class="explain" id="explain"><p class="note">Loading notes…</p></div>` : ''}`;
    $('stage').querySelectorAll('.opt-main:not([disabled])').forEach((b) => { b.onclick = () => choose(opts[+b.dataset.i]); });
    if (!wrong.size) return;

    const ex = game.mode === 'daily' ? dailyExplanation(level) : await unlimitedExplanation(level, true);
    if (currentRun().level !== level || game.guesses.length !== run.marks.length || !$('explain')) return;
    const order = run.wrongHere.map((id) => r.options.find((o) => o.id === id)).filter(Boolean);
    $('explain').innerHTML = `<ul>${order.map((o) => explainItem(ex, o, 'is-chosen')).join('')}</ul>`;
  }

  function currentOptions(level) {
    const r = game.ranks[level];
    if (game.mode === 'daily') return seededShuffle(r.options, `${game.puzzle.date}:${game.replay ? 'r' + game.replayN : 's'}:${level}`);
    return r.options;   // already shuffled when built
  }

  function choose(opt) {
    const level = currentRun().level;
    game.guesses.push(opt.id);
    const ok = opt.id === game.ranks[level].answer;
    if (game.mode === 'daily' && !game.replay) persistDaily();
    track('pd_pick', { mode: game.mode, rank: game.ranks[level].rank, correct: ok, replay: game.replay });
    if (ok) renderExplanation(level, opt.id); else renderQuestion();
  }

  // ---------------------------------------------------------------- explanation
  function explainItem(ex, o, cls) {
    const note = ex.options[o.id] || ex.options[String(o.id)];
    const extra = (ex.extra && ex.extra[o.id]) || '';   // pre-escaped HTML
    const nm = ex.link
      ? `<a class="nm" href="https://www.inaturalist.org/taxa/${o.id}" target="_blank" rel="noopener">${esc(o.name)}</a>`
      : `<span class="nm">${esc(o.name)}</span>`;
    return `<li class="${cls}">${nm}${o.common ? ` · ${esc(o.common)}` : ''}${note ? `<br>${esc(note)}` : ''}${extra}</li>`;
  }

  // Shown once the rank is answered correctly: every option locked, the
  // answer in green, any wrong guesses in red, and the notes for all of them.
  async function renderExplanation(level, chosenId) {
    renderLadder();
    const r = game.ranks[level];
    const opts = currentOptions(level);
    const answer = r.options.find((o) => o.id === r.answer);
    const run = currentRun();
    const over = run.done;
    const wrongs = run.wrongsAt[level];
    // Which options were guessed wrong at this rank, in order.
    const tried = [];
    { let lv = 0; for (const id of game.guesses) { if (id === game.ranks[lv].answer) lv++; else if (lv === level) tried.push(id); if (lv > level) break; } }
    const wrongSet = new Set(tried);

    $('stage').innerHTML = `
      <div class="prompt">${cap(r.rank)}?</div>
      <div class="options">${opts.map((o, i) => optionHTML(o, i,
        'locked ' + (o.id === r.answer ? 'correct' : wrongSet.has(o.id) ? 'chosen-wrong' : ''), r.rank)).join('')}</div>
      <div class="verdict ok">✓ Correct${wrongs ? ` after ${wrongs} miss${wrongs > 1 ? 'es' : ''}` : ''} — the ${r.rank} is
        <i>${esc(answer.name)}</i>${answer.common ? ` (${esc(answer.common)})` : ''}.</div>
      <div class="actions"><button class="btn" id="btn-next">${over ? 'See results' : 'Next: ' + cap(RANKS[level + 1]) + ' →'}</button></div>
      <div class="explain" id="explain"><p class="note">Loading notes…</p></div>`;
    $('btn-next').onclick = () => (over ? finishRun() : renderQuestion());

    const ex = game.mode === 'daily' ? dailyExplanation(level) : await unlimitedExplanation(level);
    // The player may have moved on while the notes were loading.
    if (game.guesses.length !== run.marks.length || !$('explain')) return;
    const order = [answer, ...tried.map((id) => r.options.find((o) => o.id === id)), ...opts.filter((o) => o.id !== r.answer && !wrongSet.has(o.id))].filter(Boolean);
    $('explain').innerHTML = (ex.summary ? `<p>${esc(ex.summary)}</p>` : '') +
      `<ul>${order.map((o) => explainItem(ex, o, o.id === r.answer ? 'is-answer' : wrongSet.has(o.id) ? 'is-chosen' : '')).join('')}</ul>` + (ex.footer || '');
  }

  function dailyExplanation(level) {
    const e = game.explain && game.explain.ranks && game.explain.ranks[game.ranks[level].rank];
    if (!e) return { summary: '', options: {}, footer: '<p class="note">Notes for this puzzle are still being written.</p>' };
    const srcs = level === RANKS.length - 1 ? game.explain.sources || [] : [];
    return {
      summary: e.summary, options: e.options || {},
      footer: srcs.length ? `<p class="src">Sources: ${srcs.map((s) =>
        `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`).join(' · ')}</p>` : '',
    };
  }

  // ---------------------------------------------------------------- daily mode
  let indexLoading = null;
  async function loadIndex() {
    if (game.index) return game.index;
    indexLoading = indexLoading || getJSON('data/daily_index.json?v=' + VER).catch((e) => { indexLoading = null; throw e; });
    return (game.index = await indexLoading);
  }

  function availableDailies(today) {
    return game.index.days.filter((d) => d <= today && daysBetween(d, today) < WINDOW_DAYS).sort().reverse();
  }

  function renderPicker(today) {
    const days = availableDailies(today);
    const epoch = game.index.epoch;
    $('daily-picker').innerHTML = days.map((d) => {
      const rec = stats.daily.history[d];
      const isToday = d === today;
      let sub, ready = false;
      if (rec && rec.done) sub = `${fmtScore(rec.score)} pts${isToday ? '' : ' · Replay'}`;
      else if (isToday) { sub = rec && rec.guesses.length ? 'In progress' : 'Play'; ready = true; }
      else sub = 'Practice';
      return `<button class="pick ${ready ? 'ready' : ''} ${game.puzzle && game.puzzle.date === d ? 'active' : ''}" data-date="${d}">
        <div class="p-title">#${daysBetween(epoch, d) + 1} · ${isToday ? 'Today' : prettyDate(d)}</div>
        <div class="p-sub">${sub}</div></button>`;
    }).join('');
    $('daily-picker').querySelectorAll('.pick').forEach((b) => { b.onclick = () => openDaily(b.dataset.date); });
  }

  async function openDaily(date) {
    game.mode = 'daily';
    game.uSerial++;
    $('unl-filter').hidden = true;
    const today = todayISO();
    try { await loadIndex(); } catch (e) { $('stage').innerHTML = '<p>Could not load puzzles.</p>'; return; }
    const days = availableDailies(today);
    if (!days.length) {
      $('daily-picker').innerHTML = '';
      setPhotos([], false);
      $('ladder').innerHTML = '';
      $('stage').innerHTML = '<p>No daily puzzle is scheduled for today — try Unlimited mode!</p>';
      return;
    }
    if (!date || !days.includes(date)) date = days[0];
    const [puzzle, explain] = await Promise.all([
      getJSON(`data/daily/${date}.json?v=${VER}`),
      getJSON(`data/explanations/${date}.json?v=${VER}`).catch(() => null),
    ]);
    if (game.mode !== 'daily') return;
    game.puzzle = puzzle;
    game.explain = explain;
    game.ranks = puzzle.ranks;
    // Only the puzzle's own day counts; earlier puzzles are practice.
    game.replay = date !== today;
    game.replayN = 0;
    const rec = game.replay ? null : record(date);
    game.guesses = rec ? rec.guesses.slice() : [];
    renderPicker(today);

    const run = currentRun();
    const finished = run.done || !!(rec && rec.done);
    setPhotos(puzzle.photos, finished);
    if (finished) return finishRun(true);
    if (run.last === true) return renderExplanation(run.level - 1, game.guesses[game.guesses.length - 1]);
    renderQuestion();
  }

  function persistDaily() {
    const rec = record(game.puzzle.date);
    rec.guesses = game.guesses.slice();
    rec.done = false;
    saveStats();
  }

  // Start a fresh practice run of the current daily; nothing is recorded.
  function startReplay() {
    game.replay = true;
    game.replayN += 1;
    game.guesses = [];
    setPhotos(game.puzzle.photos, false);
    renderPicker(todayISO());
    renderQuestion();
  }

  // ---------------------------------------------------------------- results
  function finishRun(alreadySaved) {
    if (game.mode === 'unlimited') return finishUnlimited();
    const run = currentRun();
    const today = todayISO();
    const p = game.puzzle;
    let rec = null;
    if (!game.replay) {
      rec = record(p.date);
      if (!rec.done) {
        rec.guesses = game.guesses.slice();
        rec.done = true;
        rec.score = run.score;
        bumpStreak(today);
        addDailyEntry(p, run.score);
        saveStats(true);
        track('pd_daily', { puzzle: p.number, score: run.score, misses: run.misses });
        contributeAggregate(p, Math.floor(run.score));
      } else if (rec.score !== run.score) {
        rec.score = run.score;   // old records cache their score once the puzzle is loaded
        saveStats();
      } else if (rec.score != null && addDailyEntry(p, rec.score)) {
        saveStats();             // solved before trees existed
      }
    }
    renderLadder(true);
    setPhotos(p.photos, true);
    renderPicker(today);

    const sp = p.species;
    const missNote = run.misses ? `${run.misses} miss${run.misses > 1 ? 'es' : ''}` : 'No misses — perfect!';
    const foot = game.replay ? "Practice run — it doesn't count toward your score or stats."
      : 'New puzzle at midnight Pacific time.';
    const n = stats.trees.daily.length;
    $('stage').innerHTML = `
      <div class="result">
        <div class="note">Floradiem #${p.number} · ${game.replay ? 'practice' : 'your score'}</div>
        <div class="big">${fmtScore(run.score)}</div>
        <div class="emoji">${runEmoji(run)}</div>
        <p class="note">${esc(missNote)}</p>
        <p class="species">It was <i>${esc(sp.name)}</i>${sp.common ? ` — ${esc(cap(sp.common))}` : ''}.</p>
        ${game.replay ? '' : `<p class="note">${treeLine('daily', n)}</p>`}
        <p class="note">${esc(foot)}</p>
        <div class="actions" style="justify-content:center">
          <button class="btn" id="btn-share">Share</button>
          <button class="btn ghost" id="btn-review">Review answers</button>
          <button class="btn ghost" id="btn-replay">Replay (practice)</button>
          <button class="btn ghost" id="btn-unl">Play Unlimited</button>
        </div>
      </div>`;
    $('btn-share').onclick = () => share(shareDaily(p, run));
    $('btn-review').onclick = () => review();
    $('btn-replay').onclick = startReplay;
    $('btn-unl').onclick = () => switchMode('unlimited');
  }

  // "Added to your Daily tree (12 / 250)" with a link to it.
  function treeLine(mode, n) {
    const k = C.treeCount(stats.trees[mode]);
    const inTree = n - (k - 1) * C.TREE_CAP;
    return `<a href="tree.html?mode=${mode}&n=${k}">Your ${cap(mode)} tree</a>${k > 1 ? ` #${k}` : ''}: ${inTree} / ${C.TREE_CAP} species`;
  }

  // Re-show the explanations for every rank answered in this run.
  function review() {
    const run = currentRun();
    const n = Math.min(RANKS.length, run.level + (run.done ? 0 : 1));
    const html = RANKS.slice(0, n).map((_, level) => {
      const r = game.ranks[level];
      const ans = r.options.find((o) => o.id === r.answer);
      const ex = dailyExplanation(level);
      return `<h3>${cap(r.rank)}: <i>${esc(ans.name)}</i></h3>${ex.summary ? `<p>${esc(ex.summary)}</p>` : ''}`;
    }).join('');
    openModal(() => `<h2>Your run</h2><div class="explain">${html}${dailyExplanation(RANKS.length - 1).footer}</div>`);
  }

  function shareDaily(p, run) {
    return `Floradiem #${p.number} — ${fmtScore(run.score)}${game.replay ? ' (practice)' : ''}\n${runEmoji(run)}\n${SITE}`;
  }
  async function share(text) {
    try {
      if (navigator.share && matchMedia('(hover: none)').matches) { await navigator.share({ text }); return; }
      await navigator.clipboard.writeText(text);
      toast('Copied to clipboard');
    } catch (e) { toast('Could not share'); }
  }
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(t._h); t._h = setTimeout(() => { t.hidden = true; }, 1800);
  }

  // ---------------------------------------------------------------- unlimited: species filter
  // {place: {id, name}, user: {id, login}, project: {id, title}} — any subset.
  function loadFilter() {
    try {
      const f = JSON.parse(localStorage.getItem(FILTER_KEY)) || {};
      return { place: f.place || null, user: f.user || null, project: f.project || null };
    } catch (e) { return { place: null, user: null, project: null }; }
  }
  function saveFilter() { try { localStorage.setItem(FILTER_KEY, JSON.stringify(game.filter)); } catch (e) {} }
  const filterActive = () => !!(game.filter.place || game.filter.user || game.filter.project);
  const filterLabel = (kind) => {
    const f = game.filter[kind];
    return !f ? '' : kind === 'place' ? f.name : kind === 'user' ? f.login : f.title;
  };
  function filterSummary() {
    const parts = ['user', 'place', 'project'].map(filterLabel).filter(Boolean);
    return parts.length ? parts.join(' · ') : 'worldwide';
  }
  // Query-string parameters that narrow iNaturalist searches to the filter.
  function filterParams() {
    const p = {};
    if (game.filter.user) p.user_id = game.filter.user.id;
    if (game.filter.place) p.place_id = game.filter.place.id;
    if (game.filter.project) p.project_id = game.filter.project.id;
    return p;
  }
  const qs = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

  let pending = null;   // the form's unsaved choices
  function renderFilterBar() {
    const box = $('unl-filter');
    box.hidden = false;
    const chips = ['user', 'place', 'project'].filter((k) => game.filter[k]).map((k) =>
      `<span class="chip" title="${esc(cap(k))}">${k === 'user' ? '@' : ''}${esc(filterLabel(k))}<button class="chip-x" data-kind="${k}" aria-label="Remove ${k} filter">×</button></span>`).join('');
    box.innerHTML = `
      <div class="filter-row">
        <span class="filter-label">Species from</span>
        ${chips || '<span class="chip plain">anywhere on iNaturalist</span>'}
        <button class="btn ghost small" id="filter-edit">${filterActive() ? 'Change' : 'Narrow down'}</button>
      </div>
      <form class="filter-form" id="filter-form" hidden>
        ${['place', 'user', 'project'].map((k) => `
        <label class="ac">
          <span>${{ place: 'Place', user: 'iNaturalist user', project: 'Project' }[k]}</span>
          <input type="search" autocomplete="off" data-kind="${k}" placeholder="${{ place: 'e.g. Serbia, Stanley Park', user: 'e.g. softshade', project: 'e.g. City Nature Challenge' }[k]}">
          <ul class="sugg" hidden></ul>
        </label>`).join('')}
        <p class="note">Species come from research-grade observations matching every field you fill in. A chosen user's photos come first, then the place's or project's, then everyone's.</p>
        <div class="actions">
          <button type="submit" class="btn">Apply</button>
          <button type="button" class="btn ghost" id="filter-clear">Anywhere</button>
          <button type="button" class="btn ghost" id="filter-cancel">Cancel</button>
        </div>
      </form>`;
    box.querySelectorAll('.chip-x').forEach((b) => { b.onclick = () => { game.filter[b.dataset.kind] = null; applyFilter(); }; });
    $('filter-edit').onclick = () => openFilterForm();
    $('filter-clear').onclick = () => { game.filter = { place: null, user: null, project: null }; applyFilter(); };
    $('filter-cancel').onclick = () => { $('filter-form').hidden = true; };
    $('filter-form').onsubmit = (e) => { e.preventDefault(); game.filter = pending; applyFilter(); };
    box.querySelectorAll('input[data-kind]').forEach(wireAutocomplete);
  }
  function openFilterForm() {
    pending = Object.assign({}, game.filter);
    const form = $('filter-form');
    form.hidden = false;
    form.querySelectorAll('input[data-kind]').forEach((inp) => { inp.value = filterLabel(inp.dataset.kind); inp.classList.toggle('chosen', !!pending[inp.dataset.kind]); });
    form.querySelector('input').focus();
  }
  function applyFilter() {
    saveFilter();
    track('pd_filter', { place: !!game.filter.place, user: !!game.filter.user, project: !!game.filter.project });
    newUnlimited();
  }

  // Suggestions from iNaturalist's autocomplete endpoints while typing.
  function wireAutocomplete(inp) {
    const kind = inp.dataset.kind;
    const list = inp.parentNode.querySelector('.sugg');
    let timer = null, seq = 0;
    const choose = (item) => {
      pending[kind] = item;
      inp.value = kind === 'user' ? item.login : item.name || item.title;
      inp.classList.add('chosen');
      list.hidden = true;
    };
    inp.oninput = () => {
      pending[kind] = null;
      inp.classList.remove('chosen');
      clearTimeout(timer);
      const q = inp.value.trim();
      if (q.length < 2) { list.hidden = true; return; }
      timer = setTimeout(async () => {
        const my = ++seq;
        let items = [];
        try {
          const d = await getJSON(`${API}${kind}s/autocomplete?q=${encodeURIComponent(q)}&per_page=6`);
          items = d.results.map((r) => kind === 'place' ? { id: r.id, name: r.display_name || r.name }
            : kind === 'user' ? { id: r.id, login: r.login, name: r.name || '', count: r.observations_count || 0 }
            : { id: r.id, title: r.title });
        } catch (e) {}
        if (my !== seq) return;
        list.innerHTML = items.length ? items.map((it, i) => `<li data-i="${i}">${
          kind === 'user' ? `<b>${esc(it.login)}</b>${it.name ? ` · ${esc(it.name)}` : ''}<small>${it.count.toLocaleString()} observations</small>`
          : esc(it.name || it.title)}</li>`).join('') : '<li class="none">No matches</li>';
        list.hidden = false;
        list.querySelectorAll('li[data-i]').forEach((li) => { li.onmousedown = (e) => { e.preventDefault(); choose(items[+li.dataset.i]); }; });
      }, 250);
    };
    inp.onblur = () => setTimeout(() => { list.hidden = true; }, 150);
    inp.onkeydown = (e) => {
      if (e.key === 'Enter' && !list.hidden) { const li = list.querySelector('li[data-i]'); if (li) { e.preventDefault(); li.onmousedown(e); } }
    };
  }

  // ---------------------------------------------------------------- unlimited: picking a species
  // The species pool is iNaturalist's species_counts for the filter (research
  // grade, plants/fungi/chromists/protozoa), most-observed first. A draw is
  // weighted toward the top: index = N · u³ for uniform u, so a tenth of
  // draws come from the 1% most-observed species and about half from the
  // commonest 10%, while the long tail still turns up.
  async function poolPage(page) {
    const key = JSON.stringify(filterParams());
    const pool = game.pools[key] = game.pools[key] || { pages: {} };
    if (!pool.pages[page]) {
      pool.pages[page] = getJSON(`${API}observations/species_counts?${qs(Object.assign({
        taxon_id: POOL_TAXA, quality_grade: 'research', per_page: PAGE, page }, filterParams()))}`);
      pool.pages[page].catch(() => { delete pool.pages[page]; });
    }
    const d = await pool.pages[page];
    pool.total = Math.min(d.total_results, WORLD_CAP);
    return d.results;
  }
  // Species already on the player's current Unlimited tree (the one still
  // filling toward TREE_CAP) are not served again until the filter's pool
  // has nothing else left.
  function onCurrentTree() {
    const list = stats.trees.unlimited;
    return new Set(C.treeSlice(list, C.treeCount(list)).map((e) => e.id));
  }
  async function drawSpecies() {
    const first = await poolPage(1);
    const total = game.pools[JSON.stringify(filterParams())].total;
    if (!total) return null;
    const seen = onCurrentTree();
    const weighted = async () => {
      const idx = Math.min(total - 1, Math.floor(total * Math.pow(Math.random(), 3)));
      const page = Math.floor(idx / PAGE) + 1;
      const results = page === 1 ? first : await poolPage(page);
      const r = results[idx % PAGE] || results[Math.floor(Math.random() * results.length)];
      return r ? r.taxon : null;
    };
    for (let i = 0; i < 15; i++) {
      const t = await weighted();
      if (t && !seen.has(t.id)) return { taxon: t, exhausted: false };
    }
    // Nearly everything drawn is on the tree: look through the pool for what isn't.
    const pages = Math.ceil(total / PAGE);
    if (pages <= 20) {
      for (let p = 1; p <= pages; p++) {
        const fresh = (await poolPage(p)).filter((r) => !seen.has(r.taxon.id));
        if (fresh.length) return { taxon: fresh[Math.floor(Math.random() * fresh.length)].taxon, exhausted: false };
      }
    }
    return { taxon: await weighted(), exhausted: true };   // the whole pool is on the tree: repeats allowed
  }

  // Full main-rank lineage of a taxon from iNaturalist, kingdom first, or null
  // when a rank is missing or the leaf is below species (a subspecies turns
  // into its species).
  async function fetchLineage(id) {
    const d = await getJSON(`${API}taxa/${id}`);
    let t = d.results[0];
    if (!t) return null;
    if (t.rank !== 'species') {
      const sp = (t.ancestors || []).find((a) => a.rank === 'species');
      if (!sp || t.rank_level >= 10) return null;
      return fetchLineage(sp.id);
    }
    game.uWiki[t.id] = t;
    const by = {};
    for (const a of t.ancestors || []) by[a.rank] = a;
    by.species = t;
    const line = RANKS.map((rk) => by[rk]);
    if (line.some((x) => !x)) return null;
    return line.map((x) => ({ id: x.id, name: x.name, common: x.preferred_common_name || '' }));
  }

  // Photos for a species. With a user selected, every photo from that user's
  // observations of it comes first; then photos from the place's or
  // project's observations; then everyone's (two per observation, best-voted
  // first) until there are at least PHOTO_MIN. Fewer and the species is skipped.
  // Credits read "username · licence" whatever the licence (iNaturalist's own
  // attribution string drops the name for CC0 photos).
  const licenseLabel = (code) => (code ? code.toUpperCase().replace(/^CC-/, 'CC ') : 'all rights reserved');
  async function fetchPhotos(sid) {
    const photos = [], seen = new Set();
    const add = (obs, perObs) => {
      for (const o of obs.results) for (const ph of o.photos.slice(0, perObs)) {
        if (seen.has(ph.id) || photos.length >= PHOTO_MAX) continue;
        seen.add(ph.id);
        photos.push({ src: ph.url.replace('/square.', '/large.'), obs: o.uri,
          attribution: `${(o.user && o.user.login) || 'iNaturalist'} · ${licenseLabel(ph.license_code)}` });
      }
    };
    const base = { taxon_id: sid, quality_grade: 'research', photos: 'true', per_page: 12, order_by: 'votes' };
    const fp = filterParams();
    if (fp.user_id) {
      try { add(await getJSON(`${API}observations?${qs(Object.assign({}, base, { user_id: fp.user_id }))}`), 99); } catch (e) {}
    }
    if (photos.length < PHOTO_MIN && (fp.place_id || fp.project_id)) {
      const scope = Object.assign({}, base);
      if (fp.place_id) scope.place_id = fp.place_id;
      if (fp.project_id) scope.project_id = fp.project_id;
      try { add(await getJSON(`${API}observations?${qs(scope)}`), 2); } catch (e) {}
    }
    if (photos.length < PHOTO_MIN) add(await getJSON(`${API}observations?${qs(base)}`), 2);
    return photos.length >= PHOTO_MIN ? photos : null;
  }

  async function loadConflicts() {
    if (game.conflicts) return;
    const pairs = await getJSON('data/conflicts.json?v=' + VER).catch(() => []);
    game.conflicts = new Set(pairs.map((p) => [p.a, p.b].sort().join('|')));
  }
  const pickRandom = (arr, n) => seededShuffle(arr, String(Math.random())).slice(0, n);

  async function buildUnlimitedRanks(line) {
    const ranks = [];
    for (let i = 0; i < line.length; i++) {
      const answer = i === 0 ? KINGDOMS.find((k) => k.id === line[i].id) || line[i] : line[i];
      const wrong = i === 0 ? KINGDOMS.filter((k) => k.id !== answer.id) : await wrongOptions(line, i);
      ranks.push({ rank: RANKS[i], answer: answer.id, options: pickRandom([answer, ...wrong], 4) });
    }
    return ranks;
  }

  // Wrong answers: other members of the same group worldwide, drawn at random
  // from the dozen most observed; when the group has too few, cousins from
  // the next group up. Arguable duplicates (shared common name, or a curated
  // pair where a regional flora lumps what iNaturalist splits) never appear in
  // the same question.
  const commonKey = (s) => (s || '').toLowerCase().replace(/[^a-z]/g, '');
  function clash(a, b) {
    if (game.conflicts.has([a.id, b.id].sort().join('|'))) return true;
    const ca = commonKey(a.common);
    return !!ca && ca === commonKey(b.common);
  }
  async function wrongOptions(line, rankI) {
    const answer = line[rankI];
    const taken = new Set([answer.id]);
    const out = [];
    const ok = (o) => !taken.has(o.id) && ![answer, ...out].some((x) => clash(o, x));
    for (let k = rankI - 1; k >= 0 && out.length < 3; k--) {
      const members = await groupMembers(line[k].id, rankI);
      const cands = [...pickRandom(members.slice(0, 12), 12), ...members.slice(12)];
      for (const o of cands) if (out.length < 3 && ok(o)) { out.push(o); taken.add(o.id); }
    }
    return out;
  }
  async function groupMembers(anc, rankI) {
    const key = `${anc}:${rankI}`;
    if (!game.siblings[key]) {
      game.siblings[key] = getJSON(`${API}taxa?taxon_id=${anc}&rank=${RANKS[rankI]}&is_active=true&order_by=observations_count&per_page=30`)
        .then((d) => d.results.filter((t) => t.rank === RANKS[rankI]).map((t) => ({ id: t.id, name: t.name, common: t.preferred_common_name || '' })))
        .catch(() => { delete game.siblings[key]; return []; });
    }
    return game.siblings[key];
  }

  async function newUnlimited() {
    game.mode = 'unlimited';
    game.replay = false;
    const serial = ++game.uSerial;
    $('daily-picker').innerHTML = '';
    $('ladder').innerHTML = '';
    setPhotos([], false);
    renderFilterBar();
    $('stage').innerHTML = `<p class="note">Finding a species (${esc(filterSummary())})…</p>`;
    try { await loadConflicts(); } catch (e) {}
    let empty = false;
    const seen = onCurrentTree();
    for (let tries = 0; tries < 10 && serial === game.uSerial; tries++) {
      try {
        game.uWiki = {};
        const drawn = await drawSpecies();
        if (!drawn || !drawn.taxon) { empty = true; break; }
        const line = await fetchLineage(drawn.taxon.id);
        if (!line) continue;
        if (!drawn.exhausted && seen.has(line[6].id)) continue;   // a subspecies of a species already on the tree
        const photos = await fetchPhotos(line[6].id);
        if (!photos) continue;
        const ranks = await buildUnlimitedRanks(line);
        if (serial !== game.uSerial) return;
        game.uLine = line;
        game.uPhotos = photos;
        game.ranks = ranks;
        game.guesses = [];
        setPhotos(game.uPhotos, false);
        return renderQuestion();
      } catch (e) { console.warn('unlimited draw failed', e); }
    }
    if (serial !== game.uSerial) return;
    $('stage').innerHTML = (empty
      ? `<p>No research-grade plants, fungi, seaweeds or slime molds found for <b>${esc(filterSummary())}</b>. Try another filter.</p>`
      : '<p>iNaturalist did not answer — check your connection and try again.</p>') +
      '<div class="actions"><button class="btn" id="btn-again">Try again</button></div>';
    $('btn-again').onclick = newUnlimited;
  }

  // Unlimited explanations: iNaturalist's Wikipedia summaries, with deeper
  // answers blanked out so a summary can't spoil the next question. While the
  // rank is still open (`hideAnswer`), this rank's answer is blanked too.
  async function unlimitedExplanation(level, hideAnswer) {
    const r = game.ranks[level];
    const ids = r.options.map((o) => o.id).filter((id) => !(id in game.uWiki));
    if (ids.length) {
      try {
        const d = await getJSON(`${API}taxa/${ids.join(',')}`);
        for (const t of d.results) game.uWiki[t.id] = t;
      } catch (e) {}
    }
    const deeper = [];
    for (const dr of game.ranks.slice(hideAnswer ? level : level + 1)) {
      const a = dr.options.find((o) => o.id === dr.answer);
      deeper.push(a.name, a.common, a.name.split(' ').pop());
    }
    const redact = (html) => {
      let s = (html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      for (const w of deeper) if (w && w.length > 3) s = s.split(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')).join('…');
      return s.length > 320 ? s.slice(0, 317).replace(/\s\S*$/, '') + '…' : s;
    };
    const options = {}, extra = {};
    for (const o of r.options) {
      const t = game.uWiki[o.id] || {};
      const summary = redact(t.wikipedia_summary);
      options[o.id] = summary;
      if (!summary) extra[o.id] = noSummaryLine(o.id);
    }
    return { summary: '', options, extra, link: true, footer: '' };
  }

  // The option name already links to iNaturalist, so just say why the text is missing.
  const noSummaryLine = () => '<div class="facts"><em>No Wikipedia summary yet.</em></div>';

  function finishUnlimited() {
    const run = currentRun();
    const u = stats.unlimited;
    u.games += 1;
    u.total_score = round3((u.total_score || 0) + run.score);
    if (run.misses === 0) u.perfect += 1;
    const bucket = Math.floor(run.score);
    u.distribution[bucket] = (u.distribution[bucket] || 0) + 1;
    const sp = game.uLine[6];
    C.addEntry(stats, 'unlimited', { t: Date.now(), id: sp.id, score: run.score, line: answerLine() });
    saveStats(true);
    track('pd_unlimited', { score: run.score, misses: run.misses, filtered: filterActive() });
    renderLadder();
    setPhotos(game.uPhotos, true);
    const missNote = run.misses ? `${run.misses} miss${run.misses > 1 ? 'es' : ''}` : 'No misses — perfect!';
    $('stage').innerHTML = `
      <div class="result">
        <div class="note">Unlimited · your score</div>
        <div class="big">${fmtScore(run.score)}</div>
        <div class="emoji">${runEmoji(run)}</div>
        <p class="note">${esc(missNote)}</p>
        <p class="species">It was <i>${esc(sp.name)}</i>${sp.common ? ` — ${esc(cap(sp.common))}` : ''}.
          <a href="https://www.inaturalist.org/taxa/${sp.id}" target="_blank" rel="noopener">About this species ↗</a></p>
        <p class="note">${treeLine('unlimited', stats.trees.unlimited.length)}</p>
        <div class="actions" style="justify-content:center">
          <button class="btn" id="btn-again">Next species</button>
          <button class="btn ghost" id="btn-share">Share</button>
        </div>
      </div>`;
    $('btn-again').onclick = newUnlimited;
    $('btn-share').onclick = () => share(`Floradiem Unlimited — ${fmtScore(run.score)}\n${runEmoji(run)}\n${SITE}`);
  }

  // ---------------------------------------------------------------- modal: stats / help
  let modalView = null;
  function openModal(view) {
    modalView = view;
    $('modal-body').innerHTML = view();
    $('modal').hidden = false;
    wireModal();
  }
  function refreshModal() { if (modalView && !$('modal').hidden) { $('modal-body').innerHTML = modalView(); wireModal(); } }
  function closeModal() { $('modal').hidden = true; modalView = null; }
  $('modal-close').onclick = closeModal;
  $('modal').onclick = (e) => { if (e.target === $('modal')) closeModal(); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  let statsTab = 'daily';
  let world = null;
  function wireModal() {
    document.querySelectorAll('#modal-body [data-tab]').forEach((b) => {
      b.onclick = () => { statsTab = b.dataset.tab; refreshModal(); if (statsTab === 'world') loadWorld(); };
    });
    const si = $('btn-signin');
    if (si) si.onclick = async () => {
      const A = window.PD_AUTH;
      try { authUser ? await A.signOut(A.auth) : await A.signInWithPopup(A.auth, A.provider); } catch (e) {
        console.warn('sign-in failed', e);
        const why = {
          'auth/unauthorized-domain': `Sign-in isn't enabled for ${location.hostname}`,
          'auth/popup-blocked': 'Allow pop-ups for this site to sign in',
          'auth/network-request-failed': 'Network error, please try again',
        }[e.code];
        if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') {
          toast(why || `Sign-in failed (${e.code || e.message})`);
        }
      }
    };
  }

  // Score distribution by whole point: "6.x" is 6 up to 6.999, "7" is perfect.
  function bars(dist, mine) {
    const max = Math.max(1, ...Object.values(dist));
    return '<div class="bars">' + RANKS.map((r, i) => i).concat(7).map((d) => {
      const n = dist[d] || 0;
      const label = d === 7 ? 'Perfect 7' : `${d}.x`;
      return `<div class="bar ${mine === d ? 'me' : ''}"><span>${label}</span>
        <div class="fill" style="width:${Math.max(6, (n / max) * 100)}%">${n}</div></div>`;
    }).join('') + '</div>';
  }

  // The species-tree card in the stats modal: how full the current tree is,
  // with links to it and to any earlier, completed trees.
  function treeCard(mode) {
    const list = stats.trees[mode];
    const k = C.treeCount(list);
    const inTree = list.length - (k - 1) * C.TREE_CAP;
    const past = [];
    for (let i = 1; i < k; i++) past.push(`<a href="tree.html?mode=${mode}&n=${i}">#${i}</a>`);
    return `<div class="treecard">
      <div><b>Your ${cap(mode)} species tree</b>${k > 1 ? ` #${k}` : ''}<br>
        <span class="note">${inTree} / ${C.TREE_CAP} species${list.length ? '' : ' — solve a puzzle to plant it'}</span></div>
      <div class="treelinks"><a class="btn small" href="tree.html?mode=${mode}&n=${k}">View tree</a>
        ${past.length ? `<span class="note">Earlier: ${past.join(' ')}</span>` : ''}</div>
    </div>`;
  }

  function statsView() {
    const tabs = ['daily', 'unlimited', 'world'].map((t) =>
      `<button data-tab="${t}" class="${statsTab === t ? 'active' : ''}">${cap(t)}</button>`).join('');
    let body = '';
    const today = todayISO();
    if (statsTab === 'daily') {
      const h = stats.daily.history;
      const dates = Object.keys(h).filter((d) => h[d].done).sort().reverse();
      const dist = {};
      const scores = [];
      const rows = [];
      for (const d of dates) {
        const s = h[d].score;
        if (s != null) { scores.push(s); dist[Math.floor(s)] = (dist[Math.floor(s)] || 0) + 1; }
        rows.push(`<tr><td>${prettyDate(d)}</td><td>#${game.index ? daysBetween(game.index.epoch, d) + 1 : ''}</td><td>${s == null ? '…' : fmtScore(s)}</td></tr>`);
      }
      const avg = scores.length ? fmtScore(scores.reduce((a, b) => a + b, 0) / scores.length) : '—';
      body = `<div class="statgrid">
          <div><b>${dates.length}</b><span>Played</span></div>
          <div><b>${avg}</b><span>Avg score</span></div>
          <div><b>${stats.daily.last_play_date && daysBetween(stats.daily.last_play_date, today) <= 1 ? stats.daily.streak : 0}</b><span>Streak</span></div>
          <div><b>${stats.daily.best_streak}</b><span>Best streak</span></div>
        </div>
        ${treeCard('daily')}
        <h3>Scores</h3>${bars(dist)}
        ${rows.length ? `<table class="history"><tr><th>Date</th><th>#</th><th>Score</th></tr>${rows.slice(0, 14).join('')}</table>` : ''}`;
    } else if (statsTab === 'unlimited') {
      const u = stats.unlimited;
      body = `<div class="statgrid">
          <div><b>${u.games}</b><span>Played</span></div>
          <div><b>${u.games ? fmtScore((u.total_score || 0) / u.games) : '—'}</b><span>Avg score</span></div>
          <div><b>${u.perfect}</b><span>Perfect</span></div>
          <div><b>${u.games ? Math.round((100 * u.perfect) / u.games) + '%' : '—'}</b><span>Perfect %</span></div>
        </div>${treeCard('unlimited')}<h3>Scores</h3>${bars(u.distribution)}`;
    } else {
      const mine = stats.daily.history[today];
      body = !world ? '<p class="note">Loading…</p>'
        : world.error ? `<p class="note">${esc(world.error)}</p>`
        : `<p>Today's puzzle: <b>${world.total_plays || 0}</b> players</p>${bars(world.distribution || {}, mine && mine.done && mine.score != null ? Math.floor(mine.score) : undefined)}
           <p class="note">Only signed-in players are counted.</p>`;
    }
    const signin = window.PD_AUTH
      ? `<div class="signin">${authUser ? `Signed in as ${esc(authUser.displayName || authUser.email)} — stats sync across devices.` : 'Sign in to keep your stats across devices and count toward World totals.'}
         <div class="actions"><button class="btn ${authUser ? 'ghost' : ''}" id="btn-signin">${authUser ? 'Sign out' : 'Sign in with Google'}</button></div></div>` : '';
    return `<h2>Statistics</h2><div class="tabs">${tabs}</div>${body}${signin}`;
  }

  async function loadWorld() {
    const A = window.PD_AUTH;
    if (!A) { world = { error: 'World stats are unavailable right now.' }; return refreshModal(); }
    try {
      const snap = await A.getDoc(A.doc(A.db, 'plantdiem_aggregates', todayISO()));
      world = snap.exists() ? snap.data() : { total_plays: 0, distribution: {} };
    } catch (e) { world = { error: 'World stats are unavailable right now.' }; }
    refreshModal();
  }

  function helpView() {
    return `<h2>How to play</h2>
      <p>Each day Floradiem shows photos of one plant, fungus, lichen, seaweed or slime mold from British Columbia, photographed by
         <a href="https://www.inaturalist.org/people/softshade" target="_blank" rel="noopener">softshade</a> on iNaturalist.
         Swipe or use the arrows to see every photo.</p>
      <p>Work down the tree of life — <b>Kingdom, Phylum, Class, Order, Family, Genus, Species</b> — choosing from four options each time.
         After each correct pick you'll learn what sets the right group apart.</p>
      <p>A wrong pick doesn't end the run or give the answer away: that option turns red with notes on why it isn't the one, and you pick again.</p>
      <h3>Scoring</h3>
      <p>Every correct answer is worth <b>1 point</b> until your first miss. From then on each correct answer is worth <b>½</b> —
         including the rank you missed on. After a second miss they're worth <b>⅓</b>, then <b>¼</b>, and so on.
         Scores are rounded to three decimals; a run with no misses scores a perfect <b>7</b>.</p>
      <p>The daily puzzle counts on its own day only. Puzzles from the past week stay available to <b>replay as practice</b>,
         which never changes your score or stats.</p>
      <h3>Unlimited</h3>
      <p>Random plants, fungi, lichens, seaweeds and slime molds from research-grade iNaturalist observations anywhere in the
         world, as many as you like, scored the same way. Often-observed species come up more. Narrow the pool to a
         <b>place</b>, an <b>iNaturalist user</b> or a <b>project</b> — their own photos are shown first.</p>
      <h3>Your species trees</h3>
      <p>Every puzzle you solve is added to your personal tree of life — one tree for Daily, one for Unlimited — with the
         points you earned beside each species. A tree holds ${C.TREE_CAP} species; after that a new one starts and the old
         ones stay on your <a href="tree.html">tree page</a>.</p>
      <p class="note">New daily puzzle at midnight Pacific time.</p>`;
  }
  $('btn-help').onclick = () => openModal(helpView);
  $('btn-stats').onclick = () => { world = null; openModal(statsView); if (statsTab === 'world') loadWorld(); };

  // ---------------------------------------------------------------- mode switching
  function switchMode(mode) {
    document.querySelectorAll('.mode-tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
    if (mode === 'daily') openDaily(game.puzzle && game.puzzle.date);
    else newUnlimited();
  }
  document.querySelectorAll('.mode-tab').forEach((t) => { t.onclick = () => switchMode(t.dataset.mode); });

  // First visit (or first visit since the rules changed): show them once.
  try {
    if (localStorage.getItem('plantdiem_seen_help') !== '2') { localStorage.setItem('plantdiem_seen_help', '2'); openModal(helpView); }
  } catch (e) {}
  // ?mode=unlimited opens straight into Unlimited (links from the tree page).
  switchMode(new URLSearchParams(location.search).get('mode') === 'unlimited' ? 'unlimited' : 'daily');
  backfillDailyTree();
  window.PD_DEBUG = { game, stats: () => stats };   // console / test harness access
})();
