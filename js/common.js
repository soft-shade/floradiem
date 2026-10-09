/* Floradiem — code shared by the game (app.js) and the tree page (tree.js):
 * the stats record, how two copies of it merge, and the per-player species
 * trees that every solved Daily and Unlimited puzzle grows.
 *
 * Stats version 3 adds
 *   trees: { daily: [entry...], unlimited: [entry...] }   oldest first
 *   taxa:  { id: [scientific name, common name] }          shared by entries
 * An entry is { t, id, s, l, d? }: time (ms), species id, score, the 7 taxon
 * ids from kingdom to species, and for dailies the puzzle date. A tree holds
 * TREE_CAP entries; the next entry starts a new one, and old trees stay
 * viewable (tree.html?mode=daily&n=2).
 */
(function () {
  'use strict';

  const RANKS = ['kingdom', 'phylum', 'class', 'order', 'family', 'genus', 'species'];
  // Storage keys and Firestore collections keep the game's original name
  // (Plantdiem) so existing progress and security rules carry over.
  const STATS_KEY = 'plantdiem_stats';
  const TREE_CAP = 250;

  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const round3 = (x) => Math.round(x * 1000) / 1000;
  const fmtScore = (x) => (x == null ? '—' : String(round3(x)));
  // Species are shown with the genus abbreviated, field-guide style: "E. cicutarium".
  const shortName = (name, rank) => {
    const w = (name || '').split(' ');
    return rank === 'species' && w.length > 1 ? `${w[0][0]}. ${w.slice(1).join(' ')}` : name;
  };

  const defaultStats = () => ({
    version: 3,
    daily: { history: {}, streak: 0, best_streak: 0, last_play_date: null },
    unlimited: { games: 0, perfect: 0, total_score: 0, distribution: {} },
    trees: { daily: [], unlimited: [] },
    taxa: {},
  });

  // Per-puzzle record: { guesses: [ids], done, score, aggregate_contributed }.
  // Records from the old attempts-per-day scheme are converted: the puzzle-day
  // run (1 point per rank before the first miss) is exactly what the new rules
  // would have scored, so it carries over; later-day retries are dropped.
  function upgradeRecord(r) {
    if (!r) return null;
    if (r.guesses) return r;
    const a0 = r.attempts && r.attempts[0];
    if (!a0) return null;
    const out = { guesses: (a0.picks || []).slice(), done: !!a0.done, aggregate_contributed: !!r.aggregate_contributed };
    const depth = r.depth0 != null ? r.depth0 : r.digits && r.digits[0] != null ? r.digits[0] : null;
    if (out.done && depth != null) out.score = depth;
    return out;
  }
  function upgradeStats(s) {
    s.daily = s.daily || { history: {} };
    const h = s.daily.history = s.daily.history || {};
    for (const k of Object.keys(h)) { const u = upgradeRecord(h[k]); if (u) h[k] = u; else delete h[k]; }
    const u = s.unlimited = s.unlimited || { games: 0, perfect: 0, distribution: {} };
    if (u.total_score == null) u.total_score = u.total_correct || 0;
    delete u.total_correct;
    s.trees = s.trees || {};
    s.trees.daily = s.trees.daily || [];
    s.trees.unlimited = s.trees.unlimited || [];
    s.taxa = s.taxa || {};
    s.version = 3;
    return s;
  }

  function loadStats() {
    try {
      const s = JSON.parse(localStorage.getItem(STATS_KEY));
      if (s && s.daily && s.unlimited) return upgradeStats(s);
    } catch (e) {}
    return defaultStats();
  }

  const entryKey = (e) => e.d || `${e.t}:${e.id}`;
  const byTime = (a, b) => (a.t - b.t) || (entryKey(a) < entryKey(b) ? -1 : 1);

  // Add a solved puzzle to a tree. `line` is the answer at each rank, kingdom
  // first: [{id, name, common}]. A puzzle already in the tree (same daily
  // date, or same moment and species) isn't added twice.
  function addEntry(stats, mode, { t, id, score, line, date }) {
    upgradeStats(stats);
    const list = stats.trees[mode];
    const e = { t, id, s: round3(score), l: line.map((x) => x.id) };
    if (date) e.d = date;
    const k = entryKey(e);
    if (list.some((x) => entryKey(x) === k)) return false;
    for (const x of line) stats.taxa[x.id] = [x.name || '', x.common || ''];
    list.push(e);
    list.sort(byTime);
    return true;
  }

  // Trees are consecutive slices of TREE_CAP entries; n is 1-based.
  const treeCount = (list) => Math.max(1, Math.ceil((list || []).length / TREE_CAP));
  const treeSlice = (list, n) => (list || []).slice((n - 1) * TREE_CAP, n * TREE_CAP);

  // Merge another copy of the stats into `target` in place (in place so that
  // records other code is holding stay live). A result recorded in either
  // copy survives: finished runs beat unfinished ones, longer beat shorter.
  function mergeInto(target, src) {
    const copy = (x) => JSON.parse(JSON.stringify(x));
    src = upgradeStats(copy(src));
    upgradeStats(target);
    const ht = target.daily.history;
    for (const [date, rs] of Object.entries(src.daily.history)) {
      const rt = ht[date];
      if (!rt) { ht[date] = copy(rs); continue; }
      rt.guesses = rt.guesses || [];
      if (!rt.done && (rs.done || (rs.guesses || []).length > rt.guesses.length)) {
        rt.guesses = copy(rs.guesses || []);
        rt.done = !!rs.done;
        if (rs.score != null) rt.score = rs.score; else delete rt.score;
      }
      if (rt.done && rt.score == null && rs.done && rs.score != null) rt.score = rs.score;
      rt.aggregate_contributed = !!(rt.aggregate_contributed || rs.aggregate_contributed);
    }
    const dt = target.daily, ds = src.daily;
    if ((ds.last_play_date || '') > (dt.last_play_date || '')) { dt.last_play_date = ds.last_play_date; dt.streak = ds.streak; }
    else if (ds.last_play_date && ds.last_play_date === dt.last_play_date) dt.streak = Math.max(dt.streak || 0, ds.streak || 0);
    dt.best_streak = Math.max(dt.best_streak || 0, ds.best_streak || 0);
    // Unlimited totals can't be merged without double counting; keep the larger.
    if ((src.unlimited.games || 0) > (target.unlimited.games || 0)) Object.assign(target.unlimited, copy(src.unlimited));
    // Tree entries are keyed, so the union is exact.
    for (const mode of ['daily', 'unlimited']) {
      const have = new Set(target.trees[mode].map(entryKey));
      let added = false;
      for (const e of src.trees[mode]) if (!have.has(entryKey(e))) { target.trees[mode].push(copy(e)); added = true; }
      if (added) target.trees[mode].sort(byTime);
    }
    for (const [id, v] of Object.entries(src.taxa)) if (!target.taxa[id] || (!target.taxa[id][1] && v[1])) target.taxa[id] = v.slice();
    return target;
  }

  window.PDC = { RANKS, STATS_KEY, TREE_CAP, cap, esc, round3, fmtScore, shortName,
    defaultStats, upgradeStats, loadStats, entryKey, addEntry, treeCount, treeSlice, mergeInto };
})();
