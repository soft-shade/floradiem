/* Floradiem — the personal species-tree page.
 *
 * Draws the player's solved species as a circular taxonomy tree in the style
 * of ete3's circular mode (the Softshade poster trees): white arcs join the
 * members of each group, straight radial branches lead outward, every taxon's
 * name sits along its branch, and labels are coloured by class. Leaves carry
 * the points scored for that species.
 *
 * Rendering is kept cheap for Firefox: every branch is one <path>, each label
 * is one <text> with a single transform, and panning/zooming only rewrites the
 * transform on the group that holds them.
 */
(function () {
  'use strict';

  const C = window.PDC;
  const { RANKS, cap, esc, fmtScore } = C;
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const mode = params.get('mode') === 'unlimited' ? 'unlimited' : 'daily';
  const wanted = parseInt(params.get('n'), 10) || 0;   // 0 = the current tree
  const THEME_KEY = 'plantdiem_tree_theme';
  const FS = 11;            // label font size, in SVG units
  const PAD = 5;            // gap between a label's end and its group's arc
  const STEM_MIN = 26;      // shortest radial branch

  let stats = C.loadStats();
  let theme = 'dark';
  try { theme = localStorage.getItem(THEME_KEY) || 'dark'; } catch (e) {}
  let current = null;       // the laid-out tree on screen (for downloads)

  // ---------------------------------------------------------------- labels (ete "peter" style)
  const SHORT = 15;         // common names longer than this give way to the scientific name
  const taxon = (id) => stats.taxa[id] || ['', ''];
  const abbrev = (name) => { const w = (name || '').split(' '); return w.length > 1 ? `${w[0][0]}. ${w.slice(1).join(' ')}` : name; };
  const titleCase = (s) => (s || '').replace(/[A-Za-z]+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
  function label(id, rankI) {
    const [name, common] = taxon(id);
    const com = common && common.toLowerCase() !== name.toLowerCase() ? titleCase(common) : '';
    if (rankI === 6) return com ? `${com} (${abbrev(name)})` : abbrev(name);
    if (rankI === 5) return com && com.length <= SHORT ? `${com} (${name})` : name;
    return com && com.length <= SHORT ? com : name;
  }

  // matplotlib's "rainbow" colormap, sampled from 0.2 (blue) to 1.0 (red)
  // like the poster notebook; one colour per class, in alphabetical order.
  function rainbow(x) {
    const r = Math.min(1, Math.max(0, Math.abs(2 * x - 0.5)));
    const g = Math.sin(Math.PI * x);
    const b = Math.cos(Math.PI * x / 2);
    return [r, g, b];
  }
  const hex = (rgb) => '#' + rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
  function classColors(n, light) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const x = n === 1 ? 0.6 : 0.2 + (0.8 * i) / (n - 1);
      let c = rainbow(x);
      if (light) c = c.map((v) => v * 0.62);   // the poster's colours are made for black; darken on white
      out.push(hex(c));
    }
    return out;
  }

  // ---------------------------------------------------------------- hierarchy
  // entries → nested nodes {id, rankI, label, children: [], leaves, scores}.
  // The same species solved twice (Unlimited) is one leaf with both scores.
  function buildHierarchy(entries) {
    const root = { id: 0, rankI: -1, label: '', children: [], kids: new Map() };
    for (const e of entries) {
      let node = root;
      e.l.forEach((id, i) => {
        let child = node.kids.get(id);
        if (!child) {
          child = { id, rankI: i, label: label(id, i), children: [], kids: new Map(), entries: [] };
          node.kids.set(id, child);
          node.children.push(child);
        }
        node = child;
      });
      node.entries.push(e);
    }
    const sortRec = (n) => {
      n.children.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
      n.children.forEach(sortRec);
      delete n.kids;
    };
    sortRec(root);
    return root;
  }

  // Text widths from a canvas, so branch lengths can make room for labels.
  const canvas = document.createElement('canvas').getContext('2d');
  canvas.font = `${FS}px Lato, "Helvetica Neue", Arial, sans-serif`;
  const textW = (s) => canvas.measureText(s).width;

  const rad = (deg) => (deg * Math.PI) / 180;

  // ---------------------------------------------------------------- layout
  // Leaves are spread evenly around the circle. A node sits one branch
  // length (`stem`) beyond its parent's arc; its label runs outward from
  // there, and the arc joining its children sits just past the label. The
  // stem grows until the leaf ring has room for one label height per leaf.
  function layout(root) {
    const leaves = [];
    const walk = (n) => { if (!n.children.length) leaves.push(n); n.children.forEach(walk); };
    walk(root);
    const N = leaves.length;
    const span = 360 * (N / (N + 1));            // one empty slot at the seam
    leaves.forEach((lf, i) => { lf.angle = -90 + (i + 0.5) * (span / N); });
    const setAngles = (n) => {
      if (!n.children.length) return;
      n.children.forEach(setAngles);
      n.angle = (n.children[0].angle + n.children[n.children.length - 1].angle) / 2;
    };
    setAngles(root);
    for (const lf of leaves) {
      const pts = lf.entries.map((e) => fmtScore(e.s)).join(' · ');
      lf.text = `${lf.label} · ${pts}`;
    }
    const allNodes = [];
    const collect = (n) => { allNodes.push(n); n.children.forEach(collect); };
    collect(root);
    for (const n of allNodes) { n.text = n.text || n.label; n.w = n.rankI < 0 ? 0 : textW(n.text); }

    // Nodes of one rank whose angles are close need enough radius that their
    // labels don't cross: at least a label height of arc between neighbours.
    const minR = RANKS.map(() => 0);
    for (let d = 0; d < RANKS.length; d++) {
      const angles = allNodes.filter((n) => n.rankI === d).map((n) => n.angle).sort((a, b) => a - b);
      let gap = 360;
      for (let i = 1; i < angles.length; i++) gap = Math.min(gap, angles[i] - angles[i - 1]);
      if (angles.length > 1) gap = Math.min(gap, angles[0] + 360 - angles[angles.length - 1]);
      if (gap < 360) minR[d] = (FS * 1.3) / rad(gap);
    }

    let stem = STEM_MIN;
    let minLeafR = 0;
    for (let iter = 0; iter < 6; iter++) {
      const place = (n, arcR) => {
        n.r = n.rankI < 0 ? 0 : Math.max(arcR + stem, minR[n.rankI]);
        n.arcR = n.rankI < 0 ? 0 : n.r + n.w + PAD;
        n.children.forEach((c) => place(c, n.arcR));
      };
      place(root, 0);
      minLeafR = Math.min(...leaves.map((l) => l.r));
      const need = (N * FS * 1.25) / (2 * Math.PI);  // ring radius that fits every leaf label
      if (minLeafR >= need) break;
      stem += (need - minLeafR) / RANKS.length + 1;
    }
    const maxR = Math.max(...leaves.map((l) => l.r + l.w)) + 2 * FS;
    return { root, leaves, allNodes, N, maxR, stem };
  }

  // ---------------------------------------------------------------- drawing
  const pt = (r, a) => [r * Math.cos(rad(a)), r * Math.sin(rad(a))];
  const f = (x) => Math.round(x * 100) / 100;

  function draw(L, classes) {
    const dark = theme !== 'light';
    const fg = dark ? '#fff' : '#111';
    const bg = dark ? '#000' : '#fff';
    const colors = classColors(classes.length, !dark);
    const colorOf = new Map(classes.map((id, i) => [id, colors[i]]));

    // Every branch and arc in one path.
    let d = '';
    for (const n of L.allNodes) {
      if (!n.children.length) continue;
      const kids = n.children;
      if (n.rankI >= 0 && kids.length > 1) {
        const a0 = kids[0].angle, a1 = kids[kids.length - 1].angle;
        const [x0, y0] = pt(n.arcR, a0), [x1, y1] = pt(n.arcR, a1);
        d += `M${f(x0)} ${f(y0)}A${f(n.arcR)} ${f(n.arcR)} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${f(x1)} ${f(y1)}`;
      }
      for (const c of kids) {
        const [x0, y0] = pt(n.arcR, c.angle), [x1, y1] = pt(c.r, c.angle);
        d += `M${f(x0)} ${f(y0)}L${f(x1)} ${f(y1)}`;
      }
    }

    // Labels: rotated to lie along the branch, flipped on the left half so
    // they never read upside down, coloured by class.
    const texts = [];
    const classOf = new Map();
    const paint = (n, cls) => { if (n.rankI === 2) cls = n.id; classOf.set(n, cls); n.children.forEach((c) => paint(c, cls)); };
    paint(L.root, null);
    for (const n of L.allNodes) {
      if (n.rankI < 0) continue;
      const a = ((n.angle % 360) + 360) % 360;
      const flip = a > 90 && a < 270;
      const r0 = n.r + 2;
      const tf = flip ? `rotate(${f(a + 180)}) translate(${f(-(r0 + n.w))},0)` : `rotate(${f(a)}) translate(${f(r0)},0)`;
      const color = classOf.get(n) != null ? colorOf.get(classOf.get(n)) : fg;
      const leaf = !n.children.length;
      let tip = '';
      if (leaf) {
        const [name, common] = taxon(n.id);
        tip = n.entries.map((e) => `${fmtScore(e.s)} pts${e.d ? ' · ' + e.d : ' · ' + new Date(e.t).toLocaleDateString()}`).join('; ');
        tip = `${common ? cap(common) + ' — ' : ''}${name}: ${tip}`;
      }
      const t = `<text transform="${tf}" dy="0.35em" fill="${color}"${leaf ? ' font-weight="700"' : ''}>${tip ? `<title>${esc(tip)}</title>` : ''}${esc(n.text)}</text>`;
      texts.push(leaf ? `<a href="https://www.inaturalist.org/taxa/${n.id}" target="_blank" rel="noopener">${t}</a>` : t);
    }

    const R = L.maxR;
    const svg = $('tree-svg');
    svg.setAttribute('viewBox', `${f(-R)} ${f(-R)} ${f(2 * R)} ${f(2 * R)}`);
    svg.setAttribute('width', f(2 * R));
    svg.setAttribute('height', f(2 * R));
    svg.setAttribute('font-size', FS);
    svg.setAttribute('font-family', 'Lato, "Helvetica Neue", Arial, sans-serif');
    svg.style.background = bg;
    svg.innerHTML = `<rect x="${f(-R)}" y="${f(-R)}" width="${f(2 * R)}" height="${f(2 * R)}" fill="${bg}"/>
      <g id="view"><path d="${d}" fill="none" stroke="${fg}" stroke-width="1.1" stroke-linecap="round"/>${texts.join('')}</g>`;
    svg.hidden = false;
    $('zoom').hidden = false;
    resetView();

    $('legend').className = 'legend' + (dark ? ' ondark' : '');
    const counts = new Map();
    for (const lf of L.leaves) { const c = classOf.get(lf); counts.set(c, (counts.get(c) || 0) + lf.entries.length); }
    $('legend').innerHTML = classes.map((id, i) =>
      `<span><i style="background:${colors[i]}"></i>${esc(label(id, 2))} · ${counts.get(id) || 0}</span>`).join('');
  }

  // ---------------------------------------------------------------- pan & zoom
  const view = { k: 1, x: 0, y: 0 };
  function applyView() { const g = $('view'); if (g) g.setAttribute('transform', `translate(${f(view.x)} ${f(view.y)}) scale(${f(view.k)})`); }
  function resetView() { view.k = 1; view.x = 0; view.y = 0; applyView(); }
  function zoomAt(factor, cx, cy) {
    const k = Math.min(12, Math.max(0.5, view.k * factor));
    const s = k / view.k;
    view.x = cx - (cx - view.x) * s;
    view.y = cy - (cy - view.y) * s;
    view.k = k;
    applyView();
  }
  // Pointer position in SVG user units.
  function svgPoint(ev) {
    const svg = $('tree-svg');
    const r = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const scale = Math.min(r.width / vb.width, r.height / vb.height);
    const ox = (r.width - vb.width * scale) / 2, oy = (r.height - vb.height * scale) / 2;
    return [vb.x + (ev.clientX - r.left - ox) / scale, vb.y + (ev.clientY - r.top - oy) / scale];
  }
  function wirePanZoom() {
    const svg = $('tree-svg');
    svg.addEventListener('wheel', (e) => { e.preventDefault(); const [x, y] = svgPoint(e); zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, x, y); }, { passive: false });
    const pointers = new Map();
    let last = null, pinch = null;
    svg.addEventListener('pointerdown', (e) => { svg.setPointerCapture(e.pointerId); pointers.set(e.pointerId, e); last = svgPoint(e); pinch = null; });
    svg.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, e);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        const [mx, my] = svgPoint({ clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 });
        if (pinch) zoomAt(dist / pinch, mx, my);
        pinch = dist;
        return;
      }
      const [x, y] = svgPoint(e);
      if (last) { view.x += x - last[0]; view.y += y - last[1]; applyView(); }
      last = [x, y];
    });
    const up = (e) => { pointers.delete(e.pointerId); last = null; pinch = null; };
    svg.addEventListener('pointerup', up);
    svg.addEventListener('pointercancel', up);
    svg.addEventListener('click', (e) => { if (e.target.closest('a') && (Math.abs(view.k - 1) > 0 || view.x || view.y) && e.detail === 0) e.preventDefault(); });
    $('z-in').onclick = () => zoomAt(1.3, 0, 0);
    $('z-out').onclick = () => zoomAt(1 / 1.3, 0, 0);
    $('z-fit').onclick = resetView;
  }

  // ---------------------------------------------------------------- downloads
  function svgText() {
    const svg = $('tree-svg').cloneNode(true);
    svg.removeAttribute('hidden');
    svg.removeAttribute('style');
    svg.querySelector('#view').removeAttribute('transform');
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + svg.outerHTML;
  }
  const fileStem = () => `floradiem-${mode}-tree-${current ? current.n : 1}`;
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  $('btn-svg').onclick = () => { if (current) download(new Blob([svgText()], { type: 'image/svg+xml' }), fileStem() + '.svg'); };
  $('btn-png').onclick = () => {
    if (!current) return;
    const size = Math.min(4000, Math.max(2000, Math.round(current.L.maxR * 2 * 1.5)));
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svgText()], { type: 'image/svg+xml' }));
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      c.getContext('2d').drawImage(img, 0, 0, size, size);
      URL.revokeObjectURL(url);
      c.toBlob((b) => download(b, fileStem() + '.png'), 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); alert('Could not render the PNG in this browser; try the SVG download.'); };
    img.src = url;
  };

  // ---------------------------------------------------------------- page
  function render() {
    const list = stats.trees[mode] || [];
    const count = C.treeCount(list);
    const n = wanted ? Math.min(Math.max(1, wanted), count) : count;
    const entries = C.treeSlice(list, n);
    document.body.classList.toggle('light', theme === 'light');
    $('btn-theme').textContent = theme === 'light' ? 'Dark' : 'Light';
    document.querySelectorAll('#mode-tabs .mode-tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));

    $('tree-title').textContent = `Your ${cap(mode)} tree${count > 1 ? ` #${n}` : ''}`;
    const full = entries.length >= C.TREE_CAP;
    $('tree-sub').textContent = entries.length
      ? `${entries.length} / ${C.TREE_CAP} species${full ? ' · complete' : ''}${n === count ? '' : ' · an earlier tree'}`
      : '';
    document.title = `${$('tree-title').textContent} — Floradiem`;
    const pick = [];
    for (let i = 1; i <= count; i++) pick.push(i === n ? `<span class="cur">#${i}</span>` : `<a href="tree.html?mode=${mode}&n=${i}">#${i}</a>`);
    $('tree-pick').innerHTML = count > 1 ? `<span class="note">Trees:</span>${pick.join('')}` : '';

    if (!entries.length) {
      $('tree-svg').hidden = true;
      $('zoom').hidden = true;
      $('legend').innerHTML = '';
      $('tree-empty').hidden = false;
      $('tree-empty').innerHTML = `<p>No species here yet.</p><p>Every ${mode === 'daily' ? 'daily puzzle' : 'Unlimited round'} you solve plants one.</p>
        <p><a class="btn" href="index.html${mode === 'unlimited' ? '?mode=unlimited' : ''}">Play ${cap(mode)}</a></p>`;
      current = null;
      return;
    }
    $('tree-empty').hidden = true;
    const root = buildHierarchy(entries);
    const L = layout(root);
    // Classes in the order they appear around the circle (alphabetical).
    const classes = [];
    const findClasses = (nd) => { if (nd.rankI === 2) classes.push(nd.id); else nd.children.forEach(findClasses); };
    findClasses(root);
    draw(L, classes);
    current = { L, n };
  }

  $('btn-theme').onclick = () => {
    theme = theme === 'light' ? 'dark' : 'light';
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
    render();
  };
  wirePanZoom();
  render();

  // Signed in: fold in what other devices have added.
  function initAuth() {
    const A = window.PD_AUTH;
    if (!A) return;
    A.onAuthStateChanged(A.auth, async (user) => {
      if (!user) return;
      try {
        const snap = await A.getDoc(A.doc(A.db, 'plantdiem_stats', user.uid));
        const remote = snap.exists() ? snap.data() : null;
        if (!remote || !remote.daily) return;
        delete remote.last_write;
        const before = JSON.stringify(stats);
        C.mergeInto(stats, remote);
        if (JSON.stringify(stats) !== before) {
          try { localStorage.setItem(C.STATS_KEY, JSON.stringify(stats)); } catch (e) {}
          render();
        }
      } catch (e) { console.warn('remote stats fetch failed', e); }
    });
  }
  if (window.PD_AUTH) initAuth(); else window.addEventListener('pd-auth-ready', initAuth, { once: true });
  addEventListener('storage', (e) => {
    if (e.key !== C.STATS_KEY || !e.newValue) return;
    try { C.mergeInto(stats, JSON.parse(e.newValue)); render(); } catch (err) {}
  });
})();
