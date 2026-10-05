/* Plantdiem — daily plant identification game.
 *
 * Daily scoring: a puzzle can be attempted once per day for 7 days, starting
 * on its own date. Attempt j (0 = puzzle day) is a full run from Kingdom; the
 * number of ranks answered correctly before the first miss becomes decimal
 * digit j of the score, so 1 then 2 then 2 ... reads 1.22... A perfect 7 ends
 * the puzzle. The score is final once solved or after the 7th day.
 */
(function () {
  'use strict';

  const VER = window.PD_VER || '';
  const RANKS = ['kingdom', 'phylum', 'class', 'order', 'family', 'genus', 'species'];
  const MAX_ATTEMPTS = 7;
  const TZ = 'America/Vancouver';
  const SITE = 'https://soft-shade.github.io/plantdiem/';
  const STATS_KEY = 'plantdiem_stats';
  const BC_PLACE = 7085;
  const API = 'https://api.inaturalist.org/v1/';
  const KINGDOMS = [
    { id: 47126, name: 'Plantae', common: 'Plants' },
    { id: 48222, name: 'Chromista', common: 'kelp, diatoms, and allies' },
    { id: 47170, name: 'Fungi', common: 'Fungi Including Lichens' },
    { id: 47686, name: 'Protozoa', common: 'protozoans' },
  ];

  const $ = (id) => document.getElementById(id);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

  // Seeded shuffle so an attempt's option order survives a reload.
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

  // ---------------------------------------------------------------- stats
  const defaultStats = () => ({
    version: 1,
    daily: { history: {}, streak: 0, best_streak: 0, last_play_date: null },
    unlimited: { games: 0, perfect: 0, total_correct: 0, distribution: {} },
  });

  let stats = loadStats();
  let authUser = null;

  function loadStats() {
    try {
      const s = JSON.parse(localStorage.getItem(STATS_KEY));
      if (s && s.daily && s.unlimited) return s;
    } catch (e) {}
    return defaultStats();
  }
  function saveStats() {
    try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch (e) {}
    saveStatsRemote();
  }

  // While signed in, Firestore is the source of truth (same model as worm-game).
  let remotePending = false;
  function saveStatsRemote() {
    const A = window.PD_AUTH;
    if (!authUser || !A || remotePending) return;
    remotePending = true;
    setTimeout(() => {               // debounce under the 1 write/s/user rule
      remotePending = false;
      if (!authUser) return;
      A.setDoc(A.doc(A.db, 'plantdiem_stats', authUser.uid),
        Object.assign({}, stats, { last_write: A.serverTimestamp() })).catch((e) => console.warn('stats write failed', e));
    }, 1200);
  }

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
            stats = remote;
          } else {
            saveStatsRemote();       // first sign-in: seed the doc with local progress
          }
          try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch (e) {}
          if (game.mode === 'daily') openDaily(game.puzzle && game.puzzle.date);
        } catch (e) { console.warn('remote stats fetch failed', e); }
      } else if (!user && was) {
        stats = loadStats();
      }
      refreshModal();
    });
  }
  if (window.PD_AUTH) initAuth(); else window.addEventListener('pd-auth-ready', initAuth, { once: true });

  // Per-puzzle record: { attempts: { j: { picks: [ids], done } }, solved }
  function record(date) {
    const h = stats.daily.history;
    return h[date] || (h[date] = { attempts: {}, solved: false });
  }
  const runDepth = (picks, ranks) => {
    let d = 0;
    while (d < picks.length && picks[d] === ranks[d].answer) d++;
    return d;
  };
  function attemptDigits(date, ranks) {
    const rec = stats.daily.history[date];
    const digits = [];
    for (let j = 0; j < MAX_ATTEMPTS; j++) {
      const a = rec && rec.attempts[j];
      digits.push(a && a.done ? runDepth(a.picks, ranks) : null);
    }
    return digits;
  }
  // Score as a string built from digits, so it never shows float noise.
  function scoreString(digits) {
    const d = digits.map((x) => x || 0);
    let frac = d.slice(1).join('').replace(/0+$/, '');
    return d[0] + (frac ? '.' + frac : '.0');
  }
  function puzzleFinal(date, digits, today) {
    return digits.includes(7) || daysBetween(date, today) >= MAX_ATTEMPTS - 1;
  }

  function bumpStreak(today) {
    const d = stats.daily;
    if (d.last_play_date === today) return;
    d.streak = d.last_play_date === addDays(today, -1) ? d.streak + 1 : 1;
    d.best_streak = Math.max(d.best_streak, d.streak);
    d.last_play_date = today;
  }

  async function contributeAggregate(puzzle, depth) {
    const A = window.PD_AUTH;
    const rec = record(puzzle.date);
    if (!authUser || !A || rec.aggregate_contributed) return;
    try {
      await A.setDoc(A.doc(A.db, 'plantdiem_aggregates', puzzle.date), {
        date: puzzle.date, puzzle_number: puzzle.number,
        distribution: { [String(depth)]: A.increment(1) },
        total_plays: A.increment(1), last_updated: A.serverTimestamp(),
      }, { merge: true });
      rec.aggregate_contributed = true;
      saveStats();
    } catch (e) { console.warn('aggregate write failed', e); }
  }

  // ---------------------------------------------------------------- state
  const game = {
    mode: 'daily',
    index: null,          // daily_index.json
    puzzle: null,         // current daily puzzle
    explain: null,        // its explanations file (or null)
    attempt: 0,           // attempt index j for the current daily
    ranks: [],            // [{rank, answer, options:[{id,name,common}]}]
    picks: [],
    showingExplain: false,
    tree: null,           // bc_tree.json (unlimited)
    children: null,
    uSpecies: null,
  };

  // ---------------------------------------------------------------- carousel
  function setPhotos(photos, revealLinks) {
    const car = $('carousel');
    car.innerHTML = photos.length ? photos.map((p, i) =>
      `<figure><img src="${esc(p.src)}" alt="Photo ${i + 1} of the mystery plant" loading="${i ? 'lazy' : 'eager'}"></figure>`).join('')
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
  }
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
  function renderLadder() {
    const depthDone = game.picks.length;
    $('ladder').innerHTML = RANKS.map((r, i) => {
      let cls = '', label = '·';
      if (i < depthDone) {
        const ok = game.picks[i] === game.ranks[i].answer;
        cls = ok ? 'ok' : 'miss';
        const ans = game.ranks[i].options.find((o) => o.id === game.ranks[i].answer);
        label = ans ? ans.name : '';
      } else if (i === depthDone && !runOver()) cls = 'current';
      return `<li class="${cls}" title="${esc(cap(r))}"><b>${cap(r).slice(0, 4)}</b>${esc(label)}</li>`;
    }).join('');
  }
  // A daily run ends at the first miss; an unlimited run always goes to Species.
  const runOver = () => game.picks.length === RANKS.length || game.mode === 'daily' &&
    game.picks.some((p, i) => p !== game.ranks[i].answer);

  function optionHTML(o, i, stateCls) {
    const tip = o.common ? cap(o.common) : '';
    return `<div class="opt ${stateCls}" data-common="${esc(tip)}">
      <button class="opt-main" data-i="${i}" data-tip="${esc(tip)}">${esc(o.name)}<span class="common" hidden>${esc(tip)}</span></button>
      <button class="opt-info" data-info="${i}" aria-label="Show common name">i</button>
    </div>`;
  }

  function renderQuestion() {
    renderLadder();
    const level = game.picks.length;
    const r = game.ranks[level];
    const opts = currentOptions(level);
    const attemptNote = game.mode === 'daily'
      ? `Attempt ${game.attempt + 1} of ${MAX_ATTEMPTS} · ${game.attempt ? (10 ** -game.attempt).toFixed(game.attempt) : 1} pt per rank`
      : `Unlimited · rank ${level + 1} of 7`;
    $('stage').innerHTML = `
      <div class="prompt">${cap(r.rank)}?<small>${esc(attemptNote)}</small></div>
      <div class="options">${opts.map((o, i) => optionHTML(o, i, '')).join('')}</div>`;
    $('stage').querySelectorAll('.opt-main').forEach((b) => { b.onclick = () => choose(opts[+b.dataset.i]); });
    $('stage').querySelectorAll('.opt-info').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        const c = b.parentElement.querySelector('.common');
        c.hidden = !c.hidden;
      };
    });
  }

  function currentOptions(level) {
    const r = game.ranks[level];
    if (game.mode === 'daily') return seededShuffle(r.options, `${game.puzzle.date}:${game.attempt}:${level}`);
    return r.options;   // already shuffled when built
  }

  function choose(opt) {
    const level = game.picks.length;
    game.picks.push(opt.id);
    if (game.mode === 'daily') persistDaily();
    track('pd_pick', { mode: game.mode, rank: game.ranks[level].rank, correct: opt.id === game.ranks[level].answer });
    renderExplanation(level, opt.id);
  }

  // ---------------------------------------------------------------- explanation
  async function renderExplanation(level, chosenId) {
    renderLadder();
    const r = game.ranks[level];
    const opts = currentOptions(level);
    const answer = r.options.find((o) => o.id === r.answer);
    const ok = chosenId === r.answer;
    const over = runOver();

    $('stage').innerHTML = `
      <div class="prompt">${cap(r.rank)}?</div>
      <div class="options">${opts.map((o, i) => optionHTML(o, i,
        'locked ' + (o.id === r.answer ? 'correct' : o.id === chosenId ? 'chosen-wrong' : ''))).join('')}</div>
      <div class="verdict ${ok ? 'ok' : 'miss'}">${ok ? '✓ Correct' : '✗ Not quite'} — the ${r.rank} is
        <i>${esc(answer.name)}</i>${answer.common ? ` (${esc(answer.common)})` : ''}.</div>
      <div class="actions"><button class="btn" id="btn-next">${over ? 'See results' : 'Next: ' + cap(RANKS[level + 1]) + ' →'}</button></div>
      <div class="explain" id="explain"><p class="note">Loading notes…</p></div>`;
    $('stage').querySelectorAll('.opt-info').forEach((b) => {
      b.onclick = () => { const c = b.parentElement.querySelector('.common'); c.hidden = !c.hidden; };
    });
    $('btn-next').onclick = () => (over ? finishRun() : renderQuestion());

    const ex = game.mode === 'daily' ? dailyExplanation(level) : await unlimitedExplanation(level);
    // The player may have moved on while the notes were loading.
    if (game.picks.length !== level + 1 || !$('explain')) return;
    const order = [answer, ...opts.filter((o) => o.id !== r.answer)];
    $('explain').innerHTML = (ex.summary ? `<p>${esc(ex.summary)}</p>` : '') +
      `<ul>${order.map((o) => {
        const note = ex.options[o.id] || ex.options[String(o.id)];
        const cls = o.id === r.answer ? 'is-answer' : o.id === chosenId ? 'is-chosen' : '';
        return `<li class="${cls}"><span class="nm">${esc(o.name)}</span>${o.common ? ` · ${esc(o.common)}` : ''}${note ? `<br>${esc(note)}` : ''}</li>`;
      }).join('')}</ul>` + (ex.footer || '');
  }

  function dailyExplanation(level) {
    const e = game.explain && game.explain.ranks && game.explain.ranks[game.ranks[level].rank];
    if (!e) return { summary: '', options: {}, footer: '<p class="note">Notes for this puzzle are still being written.</p>' };
    const srcs = level === RANKS.length - 1 || runOver() ? game.explain.sources || [] : [];
    return {
      summary: e.summary, options: e.options || {},
      footer: srcs.length ? `<p class="src">Sources: ${srcs.map((s) =>
        `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`).join(' · ')}</p>` : '',
    };
  }

  // ---------------------------------------------------------------- daily mode
  async function loadIndex() {
    if (!game.index) game.index = await getJSON('data/daily_index.json?v=' + VER);
    return game.index;
  }

  function availableDailies(today) {
    return game.index.days.filter((d) => d <= today && daysBetween(d, today) < MAX_ATTEMPTS).sort().reverse();
  }

  function renderPicker(today) {
    const days = availableDailies(today);
    const epoch = game.index.epoch;
    $('daily-picker').innerHTML = days.map((d) => {
      const rec = stats.daily.history[d];
      const j = daysBetween(d, today);
      const playedToday = rec && rec.attempts[j] && rec.attempts[j].done;
      let sub;
      if (rec && rec.solved) sub = 'Solved ✓';
      else if (playedToday) sub = 'Done today';
      else sub = j === 0 ? 'Play' : `Retry · ${j + 1}/7`;
      const ready = !(rec && rec.solved) && !playedToday;
      return `<button class="pick ${ready ? 'ready' : ''} ${game.puzzle && game.puzzle.date === d ? 'active' : ''}" data-date="${d}">
        <div class="p-title">#${daysBetween(epoch, d) + 1} · ${j === 0 ? 'Today' : prettyDate(d)}</div>
        <div class="p-sub">${sub}</div></button>`;
    }).join('');
    $('daily-picker').querySelectorAll('.pick').forEach((b) => { b.onclick = () => openDaily(b.dataset.date); });
  }

  async function openDaily(date) {
    game.mode = 'daily';
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
    if (!date || !days.includes(date)) {
      // Default: the first puzzle still waiting for today's attempt, else today's.
      date = days.find((d) => { const r = stats.daily.history[d]; const j = daysBetween(d, today);
        return !(r && (r.solved || (r.attempts[j] && r.attempts[j].done))); }) || days[0];
    }
    const [puzzle, explain] = await Promise.all([
      getJSON(`data/daily/${date}.json?v=${VER}`),
      getJSON(`data/explanations/${date}.json?v=${VER}`).catch(() => null),
    ]);
    game.puzzle = puzzle;
    game.explain = explain;
    game.ranks = puzzle.ranks;
    game.attempt = daysBetween(date, today);
    const rec = record(date);
    const cur = rec.attempts[game.attempt];
    const solving = rec.solved && Object.values(rec.attempts).find((a) => a.done && runDepth(a.picks, game.ranks) === RANKS.length);
    game.picks = cur ? cur.picks.slice() : solving ? solving.picks.slice() : [];
    renderPicker(today);

    const digits = attemptDigits(date, game.ranks);
    const final = puzzleFinal(date, digits, today);
    setPhotos(puzzle.photos, rec.solved || final);
    if (rec.solved || (cur && cur.done)) return finishRun(true);
    if (game.picks.length && runOver()) return finishRun();
    if (game.picks.length) return renderExplanation(game.picks.length - 1, game.picks[game.picks.length - 1]);
    renderQuestion();
  }

  function persistDaily() {
    const rec = record(game.puzzle.date);
    rec.attempts[game.attempt] = { picks: game.picks.slice(), done: false };
    saveStats();
  }

  // ---------------------------------------------------------------- results
  function finishRun(alreadySaved) {
    if (game.mode === 'unlimited') return finishUnlimited();
    const depth = runDepth(game.picks, game.ranks);

    const today = todayISO();
    const p = game.puzzle;
    const rec = record(p.date);
    if (!alreadySaved) {
      const a = rec.attempts[game.attempt];
      if (a && !a.done) {
        a.done = true;
        if (depth === RANKS.length) rec.solved = true;
        bumpStreak(today);
        saveStats();
        track('pd_attempt', { puzzle: p.number, attempt: game.attempt + 1, depth });
        if (game.attempt === 0) contributeAggregate(p, depth);
      }
    }
    renderLadder();
    const digits = attemptDigits(p.date, game.ranks);
    const final = puzzleFinal(p.date, digits, today);
    // Cache the digits on the record so the stats view needn't load every puzzle.
    const cached = digits.map((d) => d || 0);
    if (JSON.stringify(rec.digits) !== JSON.stringify(cached) || rec.depth0 !== digits[0]) {
      rec.digits = cached;
      rec.depth0 = digits[0];
      saveStats();
    }
    setPhotos(p.photos, final);
    renderPicker(today);

    const rows = digits.map((d, j) => {
      if (j > game.attempt && !(d != null)) return '';
      const day = prettyDate(addDays(p.date, j));
      return `<span>Day ${j + 1}</span><span>${day}</span><span>${d == null ? '—' : d + '/7'}</span>`;
    }).join('');
    const sp = p.species;
    const revealed = final
      ? `<p class="species">It was <i>${esc(sp.name)}</i>${sp.common ? ` — ${esc(cap(sp.common))}` : ''}.</p>` : '';
    const next = rec.solved ? 'Solved — well done!'
      : final ? 'This puzzle is closed. Final score above.'
      : `Come back tomorrow for attempt ${game.attempt + 2} (worth ${(10 ** -(game.attempt + 1)).toFixed(game.attempt + 1)} per rank).`;

    $('stage').innerHTML = `
      <div class="result">
        <div class="note">Plantdiem #${p.number} · ${final ? 'final score' : 'score so far'}</div>
        <div class="big">${scoreString(digits)}</div>
        <div class="attempts">${rows}</div>
        ${revealed}
        <p class="note">${esc(next)}</p>
        <div class="actions" style="justify-content:center">
          <button class="btn" id="btn-share">Share</button>
          <button class="btn ghost" id="btn-review">Review answers</button>
          <button class="btn ghost" id="btn-unl">Play Unlimited</button>
        </div>
      </div>`;
    $('btn-share').onclick = () => share(shareDaily(p, digits, final));
    $('btn-review').onclick = () => review();
    $('btn-unl').onclick = () => switchMode('unlimited');
  }

  // Re-show the explanations for every rank reached in this run.
  function review() {
    const html = game.picks.map((_, level) => {
      const r = game.ranks[level];
      const ans = r.options.find((o) => o.id === r.answer);
      const ex = dailyExplanation(level);
      return `<h3>${cap(r.rank)}: <i>${esc(ans.name)}</i></h3>${ex.summary ? `<p>${esc(ex.summary)}</p>` : ''}`;
    }).join('');
    openModal(() => `<h2>Your run</h2><div class="explain">${html}${dailyExplanation(game.picks.length - 1).footer}</div>`);
  }

  function ladderEmoji(depth, played) {
    if (depth == null) return '';
    return RANKS.map((_, i) => (i < depth ? '🌿' : i === depth ? '🍂' : '⬜')).join('');
  }
  function shareDaily(p, digits, final) {
    const lines = digits.map((d, j) => (d == null ? null : `${ladderEmoji(d)} ${d}/7`)).filter(Boolean);
    return `Plantdiem #${p.number} — ${scoreString(digits)}${final ? '' : ' (so far)'}\n${lines.join('\n')}\n${SITE}`;
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

  // ---------------------------------------------------------------- unlimited mode
  async function loadTree() {
    if (game.tree) return;
    const data = await getJSON('data/bc_tree.json?v=' + VER);
    game.tree = data.taxa;
    game.children = {};
    for (const [id, t] of Object.entries(data.taxa)) {
      (game.children[t[3]] = game.children[t[3]] || []).push(+id);
    }
    game.uSpecies = Object.keys(data.taxa).filter((id) => data.taxa[id][2] === 6 && lineage(+id).length === 7).map(Number);
  }
  function lineage(id) {
    const out = [];
    while (id) { out.unshift(id); id = game.tree[id][3]; }
    return out;
  }
  const treeOpt = (id) => ({ id, name: game.tree[id][0], common: game.tree[id][1] });
  const pickRandom = (arr, n) => seededShuffle(arr, String(Math.random())).slice(0, n);

  async function buildUnlimitedRanks(sid) {
    const ranks = [];
    const line = lineage(sid);
    for (let i = 0; i < line.length; i++) {
      const id = line[i];
      const wrong = i === 0 ? KINGDOMS.filter((k) => k.id !== id) : await wrongOptions(id, i);
      const answer = i === 0 ? KINGDOMS.find((k) => k.id === id) || treeOpt(id) : treeOpt(id);
      ranks.push({ rank: RANKS[i], answer: id, options: pickRandom([answer, ...wrong], 4) });
    }
    return ranks;
  }

  // Siblings that grow in BC (common ones first), then worldwide siblings;
  // when the group has no other members, cousins from the next group up.
  async function wrongOptions(id, rankI) {
    const line = lineage(id);
    const taken = new Set([id]);
    const out = [];
    const members = Object.keys(game.tree).map(Number).filter((t) => game.tree[t][2] === rankI);
    for (let k = line.length - 2; k >= 0 && out.length < 3; k--) {
      const anc = line[k];
      const bc = members.filter((t) => !taken.has(t) && lineage(t).includes(anc))
        .sort((a, b) => game.tree[b][4] - game.tree[a][4]).slice(0, 8);
      for (const t of pickRandom(bc, 3 - out.length)) { out.push(treeOpt(t)); taken.add(t); }
      if (out.length < 3) {
        for (const o of await worldMembers(anc, rankI, taken, 3 - out.length)) { out.push(o); taken.add(o.id); }
      }
    }
    return out;
  }
  async function worldMembers(anc, rankI, taken, n) {
    try {
      const d = await getJSON(`${API}taxa?taxon_id=${anc}&rank=${RANKS[rankI]}&is_active=true&order_by=observations_count&per_page=12`);
      return d.results.filter((t) => !taken.has(t.id) && t.rank === RANKS[rankI]).slice(0, n)
        .map((t) => ({ id: t.id, name: t.name, common: t.preferred_common_name || '' }));
    } catch (e) { return []; }
  }

  async function newUnlimited() {
    game.mode = 'unlimited';
    $('daily-picker').innerHTML = '';
    $('ladder').innerHTML = '';
    setPhotos([], false);
    $('stage').innerHTML = '<p class="note">Finding a plant…</p>';
    try { await loadTree(); } catch (e) { $('stage').innerHTML = '<p>Could not load the plant list.</p>'; return; }
    for (let tries = 0; tries < 5; tries++) {
      const sid = game.uSpecies[Math.floor(Math.random() * game.uSpecies.length)];
      let obs;
      try {
        obs = await getJSON(`${API}observations?taxon_id=${sid}&place_id=${BC_PLACE}&quality_grade=research&photos=true&per_page=12&order_by=votes`);
      } catch (e) { continue; }
      const photos = [];
      for (const o of obs.results) for (const ph of o.photos.slice(0, 2)) {
        photos.push({ src: ph.url.replace('/square.', '/large.'), attribution: ph.attribution, obs: o.uri });
      }
      if (!photos.length) continue;
      if (game.mode !== 'unlimited') return;
      game.uSid = sid;
      game.uPhotos = photos.slice(0, 16);
      game.uWiki = {};
      game.ranks = await buildUnlimitedRanks(sid);
      game.picks = [];
      setPhotos(game.uPhotos, false);
      return renderQuestion();
    }
    $('stage').innerHTML = '<p>iNaturalist did not answer — check your connection and try again.</p>' +
      '<div class="actions"><button class="btn" id="btn-again">Try again</button></div>';
    $('btn-again').onclick = newUnlimited;
  }

  // Unlimited explanations: iNaturalist's Wikipedia summaries, with deeper
  // answers blanked out so a summary can't spoil the next question.
  async function unlimitedExplanation(level) {
    const r = game.ranks[level];
    const ids = r.options.map((o) => o.id).filter((id) => !(id in game.uWiki));
    if (ids.length) {
      try {
        const d = await getJSON(`${API}taxa/${ids.join(',')}`);
        for (const t of d.results) game.uWiki[t.id] = t.wikipedia_summary || '';
      } catch (e) {}
    }
    const deeper = [];
    for (const dr of game.ranks.slice(level + 1)) {
      const a = dr.options.find((o) => o.id === dr.answer);
      deeper.push(a.name, a.common, a.name.split(' ').pop());
    }
    const redact = (html) => {
      let s = (html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      for (const w of deeper) if (w && w.length > 3) s = s.split(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')).join('…');
      return s.length > 320 ? s.slice(0, 317).replace(/\s\S*$/, '') + '…' : s;
    };
    const options = {};
    for (const o of r.options) options[o.id] = redact(game.uWiki[o.id]);
    return { summary: '', options, footer: '<p class="src">Unlimited mode shows each group\'s Wikipedia summary (via iNaturalist), not researched notes. Names of the answers still to come are hidden (…).</p>' };
  }

  function finishUnlimited() {
    const marks = game.picks.map((p, i) => p === game.ranks[i].answer);
    const correct = marks.filter(Boolean).length;
    const u = stats.unlimited;
    u.games += 1;
    u.total_correct = (u.total_correct || 0) + correct;
    if (correct === 7) u.perfect += 1;
    u.distribution[correct] = (u.distribution[correct] || 0) + 1;
    saveStats();
    track('pd_unlimited', { correct });
    renderLadder();
    setPhotos(game.uPhotos, true);
    const sp = treeOpt(game.uSid);
    const emoji = marks.map((m) => (m ? '🌿' : '🍂')).join('');
    $('stage').innerHTML = `
      <div class="result">
        <div class="note">Unlimited · ranks correct</div>
        <div class="big">${correct}/7</div>
        <div style="font-size:1.4rem">${emoji}</div>
        <p class="species">It was <i>${esc(sp.name)}</i>${sp.common ? ` — ${esc(cap(sp.common))}` : ''}.
          <a href="https://www.inaturalist.org/taxa/${sp.id}" target="_blank" rel="noopener">About this plant ↗</a></p>
        <div class="actions" style="justify-content:center">
          <button class="btn" id="btn-again">Next plant</button>
          <button class="btn ghost" id="btn-share">Share</button>
        </div>
      </div>`;
    $('btn-again').onclick = newUnlimited;
    $('btn-share').onclick = () => share(`Plantdiem Unlimited — ${correct}/7\n${emoji}\n${SITE}`);
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
      try { authUser ? await A.signOut(A.auth) : await A.signInWithPopup(A.auth, A.provider); } catch (e) { toast('Sign-in failed'); }
    };
  }

  function bars(dist, total, mine) {
    const max = Math.max(1, ...Object.values(dist));
    return '<div class="bars">' + RANKS.map((r, i) => i).concat(7).map((d) => {
      const n = dist[d] || 0;
      const label = d === 7 ? 'Species ✓' : `${d}/7`;
      return `<div class="bar ${mine === d ? 'me' : ''}"><span>${label}</span>
        <div class="fill" style="width:${Math.max(6, (n / max) * 100)}%">${n}</div></div>`;
    }).join('') + '</div>';
  }

  function statsView() {
    const tabs = ['daily', 'unlimited', 'world'].map((t) =>
      `<button data-tab="${t}" class="${statsTab === t ? 'active' : ''}">${cap(t)}</button>`).join('');
    let body = '';
    const today = todayISO();
    if (statsTab === 'daily') {
      const h = stats.daily.history;
      const dates = Object.keys(h).filter((d) => Object.values(h[d].attempts).some((a) => a.done)).sort().reverse();
      const dist = {};
      const finals = [];
      const rows = [];
      for (const d of dates) {
        const a0 = h[d].attempts[0];
        if (a0 && a0.done) {
          const dep = h[d].depth0;
          if (dep != null) dist[dep] = (dist[dep] || 0) + 1;
        }
        const digits = h[d].digits || [];
        const s = digits.length ? scoreString(digits) : '…';
        const fin = h[d].solved || daysBetween(d, today) >= MAX_ATTEMPTS - 1;
        if (fin && digits.length) finals.push(parseFloat(s));
        rows.push(`<tr><td>${prettyDate(d)}</td><td>#${game.index ? daysBetween(game.index.epoch, d) + 1 : ''}</td><td>${s}${fin ? '' : ' <span class="note">(open)</span>'}</td></tr>`);
      }
      const avg = finals.length ? (finals.reduce((a, b) => a + b, 0) / finals.length).toFixed(2) : '—';
      body = `<div class="statgrid">
          <div><b>${dates.length}</b><span>Played</span></div>
          <div><b>${avg}</b><span>Avg final</span></div>
          <div><b>${stats.daily.last_play_date && daysBetween(stats.daily.last_play_date, today) <= 1 ? stats.daily.streak : 0}</b><span>Streak</span></div>
          <div><b>${stats.daily.best_streak}</b><span>Best streak</span></div>
        </div>
        <h3>First-day depth</h3>${bars(dist, dates.length)}
        ${rows.length ? `<table class="history"><tr><th>Date</th><th>#</th><th>Score</th></tr>${rows.slice(0, 14).join('')}</table>` : ''}`;
    } else if (statsTab === 'unlimited') {
      const u = stats.unlimited;
      body = `<div class="statgrid">
          <div><b>${u.games}</b><span>Played</span></div>
          <div><b>${u.games ? ((u.total_correct || 0) / u.games).toFixed(1) : '—'}</b><span>Avg correct</span></div>
          <div><b>${u.perfect}</b><span>Perfect</span></div>
          <div><b>${u.games ? Math.round((100 * u.perfect) / u.games) + '%' : '—'}</b><span>Perfect %</span></div>
        </div><h3>Ranks correct</h3>${bars(u.distribution, u.games)}`;
    } else {
      body = !world ? '<p class="note">Loading…</p>'
        : world.error ? `<p class="note">${esc(world.error)}</p>`
        : `<p>Today's puzzle, first attempts: <b>${world.total_plays || 0}</b> players</p>${bars(world.distribution || {}, world.total_plays || 0, (stats.daily.history[today] || {}).depth0)}
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
      <p>Each day Plantdiem shows photos of one plant (or seaweed) from British Columbia, photographed by
         <a href="https://www.inaturalist.org/people/softshade" target="_blank" rel="noopener">softshade</a> on iNaturalist.
         Swipe or use the arrows to see every photo.</p>
      <p>Work down the tree of life — <b>Kingdom, Phylum, Class, Order, Family, Genus, Species</b> — choosing from four options each time.
         Hover (or tap <b>i</b>) to see a group's common name. After each pick you'll learn what sets the right group apart.</p>
      <p>A wrong pick ends the run and reveals only that rank's answer.</p>
      <h3>Scoring</h3>
      <p>Day one: <b>1 point</b> per rank you get right. Missed some? Come back the next day and try the same plant again from the top:
         every rank is worth <b>0.1</b>. The day after, <b>0.01</b>, and so on for up to 7 days.
         Each day's run becomes the next decimal digit — 1 → 1.2 → 1.22 → … A perfect 7 locks the puzzle.</p>
      <p>Scores like <b>7.0</b> (perfect first try), <b>6.7</b> (nailed it on day two) or <b>1.224554</b> are all possible.</p>
      <h3>Unlimited</h3>
      <p>Random plants from all research-grade BC observations on iNaturalist, as many as you like. A miss doesn't end the run: you see the right answer and keep going to Species, scoring one point per rank you get right.</p>
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

  // First visit: show the rules once.
  try {
    if (!localStorage.getItem('plantdiem_seen_help')) { localStorage.setItem('plantdiem_seen_help', '1'); openModal(helpView); }
  } catch (e) {}
  openDaily();
})();
