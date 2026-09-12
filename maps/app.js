/* ═══════════════════════════════════════════════════════════════
   AFTERLIGHT // CHARACTER TRACKER
   Client-side character position tracker for roleplay maps.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

/* ───────── utilities ───────── */
const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

const COLORS = ['#5df2c0','#4fc3ff','#ffd166','#ff6b81','#b388ff','#ff9f43','#7bed9f','#f368e0','#48dbfb','#e8edf2',
                '#ff4b3e','#33d17a','#f1fa8c','#a29bfe','#fd7f2c','#00d4d8','#ef476f','#9dff57','#8d99ae','#c77dff'];
const LS_KEY = 'virtusTracker.v1';

/* Rosebridge master (11776x11264) is split into a moderate-res OVERVIEW
   plus a 3x3 grid of native-resolution SECTOR maps. Each sector is ~9x
   lighter to decode than the full map, so panning/zooming stays smooth.
   box = [x0, y0] in master pixels (see tools/build_sectors.py). */
const SECTORS = [
  ['a1', 0, 0], ['a2', 3925, 0], ['a3', 7851, 0],
  ['b1', 0, 3754], ['b2', 3925, 3754], ['b3', 7851, 3754],
  ['c1', 0, 7509], ['c2', 3925, 7509], ['c3', 7851, 7509],
];
const BUILTIN_MAPS = [
  { id: 'rosebridge', name: 'Rosebridge — Overview', src: 'maps/rosebridge_overview.jpg',
    thumb: 'maps/rosebridge_thumb.jpg', overview: true, menu: 'maps/rosebridge_menu.jpg' },
  ...SECTORS.map(([n, x0, y0]) => ({
    id: 'rosebridge-' + n, name: 'Sector ' + n.toUpperCase(),
    src: `maps/sectors/rosebridge_${n}.jpg`, thumb: `maps/sectors/thumb_${n}.jpg`,
    sector: n, box: [x0, y0],
  })),
];



/* ───────── element refs ───────── */
const viewport   = $('#viewport'), world = $('#world'), mapImg = $('#mapImg'), tileLayer = $('#tileLayer');
const markerLayer = $('#markerLayer'), pingLayer = $('#pingLayer'), locLayer = $('#locLayer');
const hud = $('#hud');
const shadeLayer = $('#shadeLayer');
const pop = $('#pop'), veil = $('#veil'), hint = $('#hint'), coordsBox = $('#coords');

/* ───────── state ───────── */
let state = null;
let mode = 'add';                 // 'select' | 'add' | 'ping'
let sel = null;                   // {type:'char'|'ping', id}
let dragSnap = null;              // snapshot taken when a marker drag starts
let suppressMapClick = false;
let charIndex = new Map();        // id -> char (current map)
let imgNW = 0, imgNH = 0;         // natural image size

const view = { z: 1, tx: 0, ty: 0 };

function freshState() {
  const maps = {}, order = [];
  for (const m of BUILTIN_MAPS) { maps[m.id] = { ...m, builtin: true }; order.push(m.id); }
  return { v: 1, theme: 'dark', labels: true, hintDone: false, maps, order, current: order[0], data: {}, views: {} };
}

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return freshState();
    const s = JSON.parse(raw);
    if (!s || s.v !== 1) return freshState();
    return Object.assign(freshState(), s);
  } catch { return freshState(); }
}

function ensureBuiltins() {
  for (const m of BUILTIN_MAPS) {
    if (!state.maps[m.id]) { state.maps[m.id] = { ...m, builtin: true }; state.order.push(m.id); }
  }
  state.order = state.order.filter(id => state.maps[id]);
  if (!state.maps[state.current]) state.current = state.order[0];
}

const mData = id => {
  const d = (state.data[id] ||= { characters: [], pings: [], locations: [], shades: [] });
  d.characters ||= []; d.pings ||= []; d.locations ||= []; d.shades ||= [];
  return d;
};
const curData = () => mData(state.current);

/* ───────── map asset migrations (hi-res re-renders) ─────────
   The built-in district JPEGs were re-rendered from the ESRI label-free
   source at ~4x resolution. Existing marker/location/ping coordinates are
   stored in OLD image pixels; scale them once to the new image size and
   drop the saved view so the map re-fits. Flagged per map in state.mig. */
const MAP_MIGRATIONS = {
  'hokutozawa':        { ow:1852, oh:982,  nw:5924, nh:3140 },
  'yokono-industrial': { ow:1607, oh:1055, nw:2248, nh:1476 },
  'saga':              { ow:1602, oh:1055, nw:2564, nh:1688 },
  'yokono':            { ow:1846, oh:993,  nw:5904, nh:3176 },
  'misamoto':          { ow:1613, oh:1037, nw:5160, nh:3316 },
  'yachihida-east':    { ow:1828, oh:983,  nw:5848, nh:3144 },
  'yachihida-west':    { ow:1492, oh:1047, nw:4772, nh:3348 },
  'sakahida':          { ow:1836, oh:987,  nw:5652, nh:3036 },
  'onomaki':           { ow:1616, oh:1047, nw:5168, nh:3348 },
  'takiru':            { ow:1548, oh:1042, nw:4952, nh:3332 },
  'metro-district':    { ow:1613, oh:1037, nw:5160, nh:3316 },
  'highlands':         { ow:1920, oh:1080, nw:5680, nh:3196 },
  'kabuki':            { ow:1920, oh:1080, nw:5376, nh:3024 },
};
function runMapMigrations() {
  state.mig ||= {};
  let changed = false;
  for (const [id, m] of Object.entries(MAP_MIGRATIONS)) {
    if (state.mig[id]) continue;
    const d = state.data[id];
    if (d) {
      const sx = m.nw / m.ow, sy = m.nh / m.oh;
      for (const list of [d.characters || [], d.locations || [], d.pings || []]) {
        for (const ent of list) {
          if (typeof ent.x === 'number') ent.x *= sx;
          if (typeof ent.y === 'number') ent.y *= sy;
        }
      }
      changed = true;
    }
    if (state.views) delete state.views[id];
    state.mig[id] = 1;
  }
  return changed;
}

/* ───────── persistence + sync indicator ───────── */
function setSync(busy, failed) {
  const dot = $('#syncDot'), txt = $('#syncText');
  dot.classList.toggle('busy', !!busy);
  dot.style.background = failed ? 'var(--danger)' : '';
  dot.style.boxShadow  = failed ? '0 0 8px var(--danger)' : '';
  txt.textContent = failed ? 'STORAGE FULL' : busy ? 'STORING…' : 'SYNCHRONISED';
}
function persistNow() {
  setSync(true);
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
    setTimeout(() => setSync(false), 220);
  } catch {
    setSync(false, true);
    toast('STORAGE FULL — EXPORT YOUR SETUP TO KEEP IT SAFE', 'red');
  }
  window.AppSync?.noteChange();
}
const persist = debounce(persistNow, 350);

/* ───────── legacy timeline data (calendar was removed) ─────────
   Old boards stored per-date buckets. They are flattened into the
   global layer once (see migrateRosebridgeSectors) and no longer
   surfaced anywhere in the UI. The structure is kept only so the
   sync layer can keep ignoring/merging stray tl@ docs safely. */
let pendingPlace = null;             // charId waiting for a map click to be placed

/* scrub a deleted character from any leftover timeline bucket */
function scrubCharEverywhere(id) {
  for (const b of Object.values(state.timeline || {})) {
    for (const pos of Object.values(b.posByMap || {})) delete pos[id];
  }
}

/* One-time migration: flatten timeline buckets into the global layer,
   then split the old full-map 'rosebridge' content (11776x11264 pixel
   space) into the 9 sector maps at sector-local coordinates. */
function migrateRosebridgeSectors() {
  state.mig ||= {};
  if (state.mig.rosebridgeSectors) return;
  // 1) flatten every dated bucket into the live global layer
  for (const [key, b] of Object.entries(state.timeline || {})) {
    if (key === '' || !b) continue;
    for (const [mid, pos] of Object.entries(b.posByMap || {})) {
      const d = mData(mid);
      for (const [cid, p] of Object.entries(pos || {})) {
        const c = d.characters.find(x => x.id === cid);
        if (c && (c.unplaced || typeof c.x !== 'number')) { c.x = p.x; c.y = p.y; c.unplaced = false; }
      }
    }
    for (const [mid, pings] of Object.entries(b.pingsByMap || {})) {
      const d = mData(mid), seen = new Set(d.pings.map(p => p.id));
      for (const p of (pings || [])) if (p && p.id != null && !seen.has(p.id)) { d.pings.push(p); seen.add(p.id); }
    }
  }
  state.timeline = {};
  delete state.calendar;
  // 2) split old full-map content into sectors (old coords = master pixels)
  const X0 = [0, 3925, 7851], Y0 = [0, 3754, 7509];
  const WC = [3925, 3926, 3925], HC = [3754, 3755, 3755];
  const rb = state.data.rosebridge;
  if (rb) {
    const route = (e, lists) => {
      if (typeof e.x !== 'number' || typeof e.y !== 'number') { lists.keep.push(e); return; }
      const c = e.x >= X0[2] ? 2 : e.x >= X0[1] ? 1 : 0;
      const r = e.y >= Y0[2] ? 2 : e.y >= Y0[1] ? 1 : 0;
      e.x = Math.min(Math.max(e.x - X0[c], 0), WC[c]);
      e.y = Math.min(Math.max(e.y - Y0[r], 0), HC[r]);
      lists['abc'[r] + (c + 1)].push(e);
    };
    const bucketize = list => {
      const lists = { keep: [], a1: [], a2: [], a3: [], b1: [], b2: [], b3: [], c1: [], c2: [], c3: [] };
      for (const e of (list || [])) route(e, lists);
      return lists;
    };
    const chLists = bucketize(rb.characters);
    const loLists = bucketize(rb.locations);
    const piLists = bucketize(rb.pings);
    for (const k of ['a1', 'a2', 'a3', 'b1', 'b2', 'b3', 'c1', 'c2', 'c3']) {
      const d = mData('rosebridge-' + k);
      if (chLists[k].length) d.characters.push(...chLists[k]);
      if (loLists[k].length) d.locations.push(...loLists[k]);
      if (piLists[k].length) d.pings.push(...piLists[k]);
    }
    rb.characters = chLists.keep;   // unplaced roster chars stay on the overview
    rb.locations = loLists.keep;
    rb.pings = piLists.keep;
  }
  delete state.views.rosebridge;
  for (const k of ['a1', 'a2', 'a3', 'b1', 'b2', 'b3', 'c1', 'c2', 'c3']) delete state.views['rosebridge-' + k];
  state.mig.rosebridgeSectors = 1;
}

/* world → viewport screen coords (for placing popovers without a mouse event) */
const w2s = (wx, wy) => ({ px: view.tx + wx * view.z, py: view.ty + wy * view.z });
/* markers live in a screen-space overlay (#hud), positioned by JS in integer
   screen pixels — no nested counter-scaling, so they never rasterize blurry */
function placeMarker(el) {
  el.style.left = Math.round(view.tx + (+el.dataset.wx) * view.z) + 'px';
  el.style.top = Math.round(view.ty + (+el.dataset.wy) * view.z) + 'px';
}
function relayoutMarkers() {
  if (!hud) return;
  for (const layer of [pingLayer, locLayer, markerLayer])
    for (const el of layer.children) if (el.dataset && el.dataset.wx != null) placeMarker(el);
}
const mapNameOf = mid => (state.maps[mid]?.name || mid);

/* ───────── pending placement (put roster character on the map) ───────── */
function beginPlacement(charId) {
  pendingPlace = charId;
  closePop();
  const c = curData().characters.find(x => x.id === charId);
  toast(`CLICK THE MAP TO PLACE ${c ? c.name.toUpperCase() : 'CHARACTER'}`, 'amber');
  viewport.style.cursor = 'crosshair';
}
function cancelPlacement() {
  if (!pendingPlace) return;
  pendingPlace = null;
  viewport.style.cursor = '';
  renderSidebar();
}
function placePendingAt(mx, my) {
  const c = curData().characters.find(x => x.id === pendingPlace);
  pendingPlace = null;
  viewport.style.cursor = '';
  if (!c) { renderSidebar(); return; }
  pushHistory();
  c.x = mx; c.y = my; c.unplaced = false;
  sel = { type: 'char', id: c.id };
  persist(); renderAll();
  toast('CHARACTER POSITIONED', 'green');
}
/* ───────── history (undo / redo) ───────── */
const undoStack = [], redoStack = [];
const snapshot = () => JSON.parse(JSON.stringify({ cur: state.current, data: state.data }));
function pushHistory(snap) {
  undoStack.push(snap || snapshot());
  if (undoStack.length > 60) undoStack.shift();
  redoStack.length = 0;
  updateUndoButtons();
}
function restoreSnap(s) {
  state.data = s.data;
  if (s.cur !== state.current) switchMap(s.cur, { silent: true, skipViewSave: true });
  sel = null; closePop(); renderAll(); persist();
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restoreSnap(undoStack.pop());
  toast('UNDO'); updateUndoButtons();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restoreSnap(redoStack.pop());
  toast('REDO'); updateUndoButtons();
}
function updateUndoButtons() {
  $('#btnUndo').disabled = !undoStack.length;
  $('#btnRedo').disabled = !redoStack.length;
}

/* ───────── tiled map streaming ─────────
   Huge maps (Rosebridge is 11776×11264) are served as a pyramid of
   512 px JPEG tiles. Only tiles covering the current viewport are
   decoded — pan/zoom stays smooth because the browser never holds
   the full-resolution bitmap. World pixel coordinates are unchanged,
   so saved views, pins and exports keep working. */
const tileCache = new Map();              // 'lvl:tx,ty' -> <img>
function updateTiles() {
  const m = state.maps[state.current];
  if (!m || !m.tiles || !imgNW || !tileLayer) return;
  const maxL = m.tileLevels - 1;
  const lvl = Math.max(0, Math.min(maxL, Math.round(-Math.log2(view.z))));
  const keep = new Set();
  const add = (lv, cx0, cy0, cx1, cy1) => {
    const tw = 512 << lv;                 // world px per tile edge
    const cols = Math.ceil(imgNW / tw), rows = Math.ceil(imgNH / tw);
    for (let ty = Math.max(0, cy0); ty <= Math.min(rows - 1, cy1); ty++)
      for (let tx = Math.max(0, cx0); tx <= Math.min(cols - 1, cx1); tx++) {
        const key = lv + ':' + tx + ',' + ty;
        keep.add(key);
        if (tileCache.has(key)) continue;
        const el = document.createElement('img');
        el.className = 'tile';
        el.draggable = false;
        el.decoding = 'async';
        el.src = `${m.tiles}/l${lv}/${tx}_${ty}.jpg`;
        el.style.left = tx * tw + 'px';
        el.style.top = ty * tw + 'px';
        el.style.width = tw + 'px';
        el.style.height = tw + 'px';
        // stacking: tileLayer is world's first child, so tiles stay below
        // marker layers; current-level tiles are always appended after the
        // coarse base tiles, so fine detail lands on top without z-index.
        tileCache.set(key, el);
        tileLayer.appendChild(el);
      }
  };
  add(maxL, 0, 0, Infinity, Infinity);    // permanent coarse base (anti-flash, 4 tiles)
  if (lvl !== maxL) {
    const tw = 512 << lvl;
    add(lvl,
      Math.floor((-view.tx / view.z) / tw),
      Math.floor((-view.ty / view.z) / tw),
      Math.floor(((-view.tx + viewport.clientWidth) / view.z) / tw),
      Math.floor(((-view.ty + viewport.clientHeight) / view.z) / tw));
  }
  for (const [key, el] of tileCache)
    if (!keep.has(key)) { el.remove(); tileCache.delete(key); }
}

/* ───────── view math ───────── */
function applyView() {
  world.style.transform = `translate3d(${view.tx}px,${view.ty}px,0) scale(${view.z})`;
  updateTiles();
  // Virtus: markers never fade on zoom-out
  hud.classList.remove('far-zoom');
  relayoutMarkers();
  const pct = Math.round(view.z * 100);
  $('#stZoom').textContent = `ZOOM ${pct}%`;
  $('#zLevel').textContent = pct + '%';
  state.views[state.current] = { ...view };
  persist();
  scheduleLabelLayout();
}
function fitZoom() {
  const vw = viewport.clientWidth, vh = viewport.clientHeight;
  return Math.min(vw / imgNW, vh / imgNH) * 0.97;
}
const minZ = () => fitZoom() * 0.22;
const maxZ = () => 8;

function animateView(target, dur = 380) {
  world.classList.add('anim');
  Object.assign(view, target);
  applyView();
  clearTimeout(animateView._t);
  animateView._t = setTimeout(() => world.classList.remove('anim'), dur + 40);
}
function fitView(animate = true) {
  if (!imgNW) return;
  const z = fitZoom();
  const t = { z, tx: (viewport.clientWidth  - imgNW * z) / 2, ty: (viewport.clientHeight - imgNH * z) / 2 };
  animate ? animateView(t) : (Object.assign(view, t), applyView());
}
function zoomAt(px, py, factor) {
  const nz = clamp(view.z * factor, minZ(), maxZ());
  if (nz === view.z) return;
  closePop();
  view.tx = px - (px - view.tx) * (nz / view.z);
  view.ty = py - (py - view.ty) * (nz / view.z);
  view.z = nz;
  applyView();
}
function centerOn(mx, my, animate = true) {
  closePop();
  const readable = Math.max(view.z, Math.min(1.1, fitZoom() * 2.4));
  const t = { z: readable, tx: viewport.clientWidth / 2 - mx * readable, ty: viewport.clientHeight / 2 - my * readable };
  animate ? animateView(t) : (Object.assign(view, t), applyView());
}
const toMap = (px, py) => ({ x: (px - view.tx) / view.z, y: (py - view.ty) / view.z });
function evPos(e) { const r = viewport.getBoundingClientRect(); return { px: e.clientX - r.left, py: e.clientY - r.top }; }

/* ───────── map loading / switching ───────── */
function switchMap(id, opts = {}) {
  if (!state.maps[id]) return;
  if (!opts.skipViewSave && state.current && state.views) state.views[state.current] = { ...view };
  state.current = id;
  sel = null; closePop();
  pendingPlace = null; viewport && (viewport.style.cursor = '');
  const m = state.maps[id];
  veil.classList.add('on');
  if (m.tiles) {
    tileCache.forEach(el => el.remove()); tileCache.clear();
    tileLayer.innerHTML = '';
    tileLayer.style.display = '';
    mapImg.style.display = 'none';
    if (mapImg.getAttribute('src')) mapImg.removeAttribute('src');   // release the giant decode
  } else {
    tileLayer.style.display = 'none';
    mapImg.style.display = '';
  }
  const finish = () => {
    imgNW = m.tiles ? m.w : mapImg.naturalWidth; imgNH = m.tiles ? m.h : mapImg.naturalHeight;
    world.style.width = imgNW + 'px'; world.style.height = imgNH + 'px';
    const saved = state.views[id];
    if (saved && saved.z) Object.assign(view, saved);
    else { const z = fitZoom(); Object.assign(view, { z, tx: (viewport.clientWidth - imgNW * z) / 2, ty: (viewport.clientHeight - imgNH * z) / 2 }); }
    applyView();
    veil.classList.remove('on');
    $('#stMap').textContent = m.name.toUpperCase();
    $('#mapNameTag').textContent = m.name.toUpperCase();
    renderAll();
    if (opts.focus) {
      const fp = curData().pings.find(x => x.id === opts.focus);
      if (fp) { sel = { type: 'ping', id: fp.id }; renderAll(); centerOn(fp.x, fp.y, false); }
    }
    if (!opts.silent) toast(`MAP LOADED — ${m.name.toUpperCase()}`);
    if (m.overview) { renderDrawer(); $('#mapDrawer').classList.remove('hidden'); }
    persist();
  };
  if (m.tiles) finish();
  else if (mapImg.getAttribute('src') === m.src && mapImg.complete && mapImg.naturalWidth) finish();
  else { mapImg.onload = finish; mapImg.onerror = () => { veil.classList.remove('on'); toast('MAP IMAGE FAILED TO LOAD', 'red'); }; mapImg.src = m.src; }
}

/* ───────── toasts ───────── */
function toast(msg, cls = '') {
  const box = $('#toasts');
  while (box.children.length >= 4) box.firstChild.remove();
  const t = document.createElement('div');
  t.className = 'toast ' + cls;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 350); }, 2100);
}

/* ───────── marker rendering ───────── */
function renderMarkers() {
  charIndex = new Map();
  markerLayer.innerHTML = '';
  markerLayer.classList.toggle('nolabels', !state.labels);
  const q = $('#searchInput').value.trim().toLowerCase();
  for (const c of curData().characters) {
    charIndex.set(c.id, c);
    if (c.hidden || c.unplaced) continue;
    const el = document.createElement('div');
    el.className = `mk shape-${c.shape || 'circle'}${sel && sel.type === 'char' && sel.id === c.id ? ' sel' : ''}${c.avatar ? ' has-avatar' : ''}${q && !c.name.toLowerCase().includes(q) ? ' dimmed' : ''}`;
    el.dataset.wx = c.x; el.dataset.wy = c.y; placeMarker(el);
    el.style.setProperty('--c', c.color || COLORS[0]);
    el.dataset.id = c.id;
    const dot = document.createElement('div');
    dot.className = 'mk-dot';
    if (c.avatar) { const im = document.createElement('img'); im.src = c.avatar; im.draggable = false; dot.appendChild(im); }
    const lab = document.createElement('div');
    lab.className = 'mk-label'; lab.textContent = c.name;
    el.append(dot, lab);
    el.addEventListener('pointerdown', e => startEntityDrag(e, c, el, 'char'));
    markerLayer.appendChild(el);
  }
  layoutLabels();
}

function renderPings() {
  pingLayer.innerHTML = '';
  pingLayer.classList.toggle('nolabels', !state.labels);
  for (const p of curData().pings) {
    if (p.hidden) continue;
    const el = document.createElement('div');
    const fin = p.status === 'finished';
    const warn = p.ptype === 'warn';
    if (warn) {
      el.className = 'pg warn' + (sel && sel.type === 'ping' && sel.id === p.id ? ' sel' : '');
      el.style.setProperty('--pgc', p.color || '#ff4438');
      el.innerHTML = `<div class="pg-ring"></div><div class="warn-sign">\u26A0</div>`;
    } else {
      el.className = 'pg' + (fin ? ' fin' : ' ong') + (sel && sel.type === 'ping' && sel.id === p.id ? ' sel' : '');
      el.style.setProperty('--pgc', fin ? 'var(--pgc-fin)' : 'var(--pgc-ong)');
      el.innerHTML = `<div class="pg-ring"></div><div class="pg-core"></div>`;
    }
    el.dataset.wx = p.x; el.dataset.wy = p.y; placeMarker(el);
    el.dataset.id = p.id;
    if (p.label) { const l = document.createElement('div'); l.className = 'pg-label'; l.textContent = p.label; el.appendChild(l); }
    if (!warn || adminOn) el.addEventListener('pointerdown', e => startEntityDrag(e, p, el, 'ping'));
    else el.addEventListener('pointerdown', e => { e.stopPropagation(); toast('ADMIN MODE NEEDED TO EDIT WARNINGS — TAP 🔒', 'amber'); });
    pingLayer.appendChild(el);
  }
  layoutLabels();
}

/* ───────── location pins (fixed place markers) ───────── */
let locIndex = new Map();
function renderLocations() {
  locIndex = new Map();
  locLayer.innerHTML = '';
  locLayer.classList.toggle('nolabels', !state.labels);
  for (const l of curData().locations) {
    locIndex.set(l.id, l);
    if (l.hidden) continue;
    const el = document.createElement('div');
    el.className = 'loc' + (sel && sel.type === 'loc' && sel.id === l.id ? ' sel' : '');
    el.dataset.wx = l.x; el.dataset.wy = l.y; placeMarker(el);
    el.style.setProperty('--c', l.color || LOCCOLORS_DEFAULT);
    el.dataset.id = l.id;
    el.innerHTML = `<div class="loc-pin"></div>`;
    const lab = document.createElement('div');
    lab.className = 'loc-label'; lab.textContent = l.name;
    el.appendChild(lab);
    el.addEventListener('pointerdown', e => {
      e.stopPropagation();
      suppressMapClick = true; setTimeout(() => suppressMapClick = false, 80);
    });
    el.addEventListener('click', e => {
      e.stopPropagation();
      sel = { type: 'loc', id: l.id };
      renderLocations(); renderSidebar();
      const p = evPos(e);
      openEditLocPop(l, p.px, p.py);
    });
    locLayer.appendChild(el);
  }
  layoutLabels();
}
const LOCCOLORS_DEFAULT = '#e8edf2';

function addLoc(name, x, y, color) {
  pushHistory();
  const l = { id: uid(), name, x, y, color: color || LOCCOLORS_DEFAULT };
  curData().locations.push(l);
  sel = { type: 'loc', id: l.id };
  persist(); closePop(); renderAll();
  toast('LOCATION MARKED');
}
function deleteLoc(id) {
  pushHistory();
  const d = curData();
  d.locations = d.locations.filter(l => l.id !== id);
  if (sel?.type === 'loc' && sel.id === id) sel = null;
  persist(); closePop(); renderAll();
  toast('LOCATION REMOVED', 'red');
}

/* label de-cluttering — fan out overlapping labels */
let labelRaf = false;
function scheduleLabelLayout() { if (!labelRaf) { labelRaf = true; requestAnimationFrame(() => { labelRaf = false; layoutLabels(); }); } }
function layoutLabels() {
  // [layer, markerSel, labelSel, dirs(it) → [[cls,{x,y}],…]] — mirrors the CSS offsets exactly
  const kinds = [
    [markerLayer, '.mk', '.mk-label', it => [
      ['',      { x: it.sx + 16,        y: it.sy - it.h / 2 }],
      ['lbl-l', { x: it.sx - 16 - it.w, y: it.sy - it.h / 2 }],
      ['lbl-t', { x: it.sx - it.w / 2,  y: it.sy - 16 - it.h }],
      ['lbl-b', { x: it.sx - it.w / 2,  y: it.sy + 16 }],
    ]],
    [locLayer, '.loc', '.loc-label', it => [
      ['',      { x: it.sx + 14,        y: it.sy - 13 }],
      ['lbl-l', { x: it.sx - 14 - it.w, y: it.sy - 13 }],
      ['lbl-t', { x: it.sx - it.w / 2,  y: it.sy - 38 }],
      ['lbl-b', { x: it.sx - it.w / 2,  y: it.sy + 10 }],
    ]],
    [pingLayer, '.pg', '.pg-label', it => [
      ['',      { x: it.sx + 14,        y: it.sy - it.h / 2 }],
      ['lbl-l', { x: it.sx - 14 - it.w, y: it.sy - it.h / 2 }],
      ['lbl-t', { x: it.sx - it.w / 2,  y: it.sy - 14 - it.h }],
      ['lbl-b', { x: it.sx - it.w / 2,  y: it.sy + 14 }],
    ]],
  ];
  // clear previous dodge/fade state first (incl. markers whose labels are hidden)
  for (const [layer, selc] of kinds)
    for (const el of layer.querySelectorAll(selc))
      el.classList.remove('lbl-l', 'lbl-t', 'lbl-b', 'lbl-dim');

  const items = [];
  for (const [layer, selc, labc, dirs] of kinds) {
    for (const el of layer.querySelectorAll(selc)) {
      const lab = el.querySelector(labc);
      if (!lab) continue;
      const w = lab.offsetWidth, h = lab.offsetHeight;
      if (!w || !h) continue;                       // labels hidden
      items.push({
        el, w, h, dirs,
        sx: (+el.dataset.wx) * view.z + view.tx,
        sy: (+el.dataset.wy) * view.z + view.ty,
        sel: el.classList.contains('sel'),
      });
    }
  }
  if (!items.length) return;

  const PAD = 3;
  const candidates = it =>
    it.dirs(it).map(([cls, r]) => [cls, { x: r.x - PAD, y: r.y - PAD, w: it.w + PAD * 2, h: it.h + PAD * 2 }]);
  const clash = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  // priority: selected first, then top-to-bottom (stable de-clash order)
  items.sort((a, b) => (b.sel - a.sel) || (a.sy - b.sy) || (a.sx - b.sx));
  const placed = [];
  for (const it of items) {
    let done = false;
    for (const [cls, r] of candidates(it)) {
      if (!placed.some(q => clash(r, q))) {
        if (cls) it.el.classList.add(cls);
        placed.push(r);
        done = true;
        break;
      }
    }
    if (!done) {
      // every side collides → fade it (dim overlapping names);
      // hovering the marker restores full opacity via CSS
      it.el.classList.add('lbl-dim');
      placed.push(candidates(it)[0][1]);
    }
  }
}

/* ───────── sidebar ───────── */
/* ───────── global story-ping index (all maps) ───────── */
function collectAllPings() {
  const out = [];
  for (const [mid, d] of Object.entries(state.data || {}))
    (d.pings || []).forEach((p, i) => out.push({ p, mapId: mid, ord: i }));
  out.sort((a, b) => ((b.p.createdAt || 0) - (a.p.createdAt || 0)) || (b.ord - a.ord));
  return out;
}
/* jump to any story ping anywhere — swaps map, then focuses it */
function gotoPing(mapId, id) {
  closePop();
  if (mapId === state.current) {
    const p = curData().pings.find(x => x.id === id);
    if (p) { sel = { type: 'ping', id }; renderAll(); centerOn(p.x, p.y); }
    return;
  }
  toast(`JUMPING TO PING — ${mapNameOf(mapId).toUpperCase()}`);
  switchMap(mapId, { silent: true, focus: id });
}
/* flip a ping's visible flag on whichever map owns it */
function togglePingHidden(mapId, id) {
  const tp = state.data[mapId]?.pings?.find(x => x.id === id);
  if (tp) tp.hidden = !tp.hidden;
  persist(); renderPings(); renderSidebar();
}

/* delete a ping from whichever map owns it */
function deleteGlobalPing(mapId, id) {
  if (mapId === state.current) { deletePing(id); return; }
  const dd = state.data[mapId];
  if (dd) dd.pings = (dd.pings || []).filter(p => p.id !== id);
  persist(); renderSidebar(); toast('PING REMOVED', 'red');
}

/* sidebar tabs — one section visible at a time, STORY PINGS by default */
function setSidebarTab(t) {
  if (t !== 'pings' && t !== 'chars' && t !== 'locs') t = 'pings';
  $('#sidebar').dataset.tab = t;
  $$('#sideTabs .side-tab').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  try { localStorage.setItem(LS_KEY + ':tab', t); } catch (e) { }
}
function renderSidebar() {
  const d = curData();
  const q = $('#searchInput').value.trim().toLowerCase();
  const list = $('#charList');
  list.innerHTML = '';
  const chars = d.characters.filter(c => !q || c.name.toLowerCase().includes(q));
  if (!chars.length) {
    list.innerHTML = `<div class="empty-msg">${q ? 'NO MATCHES FOUND'
      : 'NO CHARACTERS ON THIS MAP —<br>CLICK THE MAP TO PLACE ONE'}</div>`;
  }
  for (const c of chars) {
    const unplaced = !!c.unplaced;
    const row = document.createElement('div');
    row.className = 'char-row' + (sel && sel.type === 'char' && sel.id === c.id ? ' on' : '') + (c.hidden ? ' is-hidden' : '') + (unplaced ? ' is-unplaced' : '');
    row.innerHTML = `
      <span class="char-dot ${c.shape === 'diamond' ? 'dia' : c.shape === 'square' ? 'sq' : ''}" style="--c:${esc(c.color)};background:${esc(c.color)}"></span>
      <span class="char-name">${esc(c.name)}</span>
      <span class="row-btns">
        ${unplaced
          ? `<button class="rb place" data-act="place" title="Place on the map">◎</button>`
          : `<button class="rb" data-act="locate" title="Centre on character">⌖</button>`}
        <button class="rb" data-act="dup" title="Duplicate marker">⧉</button>
        <button class="rb" data-act="hide" title="Hide / show on map">👁</button>
        <button class="rb warn" data-act="del" title="Remove character">✕</button>
      </span>`;
    row.addEventListener('click', e => {
      const act = e.target.closest('.rb')?.dataset.act;
      if (act === 'hide')  { pushHistory(); c.hidden = !c.hidden; persist(); renderMarkers(); renderSidebar(); return; }
      if (act === 'del')   { deleteChar(c.id); return; }
      if (act === 'dup')   { duplicateChar(c.id); return; }
      if (act === 'place') { beginPlacement(c.id); return; }
      if (c.unplaced) { beginPlacement(c.id); return; }
      selectChar(c.id);
      centerOn(c.x, c.y);
    });
    if (pendingPlace === c.id) row.classList.add('is-placing');
    list.appendChild(row);
  }
  const llist = $('#locList');
  llist.innerHTML = '';
  if (!d.locations.length) llist.innerHTML = `<div class="empty-msg">NO LOCATIONS — ENABLE ⌂ LOC MODE AND CLICK</div>`;
  for (const l of d.locations) {
    const row = document.createElement('div');
    row.className = 'ping-row loc-row' + (sel && sel.type === 'loc' && sel.id === l.id ? ' on' : '') + (l.hidden ? ' is-hidden' : '');
    row.innerHTML = `<span class="loc-dot" style="--c:${esc(l.color || '#e8edf2')};background:${esc(l.color || '#e8edf2')}"></span>
      <span class="ping-name loc-pin-name" style="color:var(--txt)">${esc(l.name)}</span>
      <span class="row-btns"><button class="rb" data-act="hide" title="Hide / show on map">👁</button><button class="rb warn" data-act="del" title="Remove location">✕</button></span>`;
    row.addEventListener('click', e => {
      const rb = e.target.closest('.rb');
      if (rb && rb.dataset.act === 'hide') { pushHistory(); l.hidden = !l.hidden; persist(); renderLocations(); renderSidebar(); return; }
      if (rb) { deleteLoc(l.id); return; }
      sel = { type: 'loc', id: l.id };
      renderLocations(); renderSidebar(); centerOn(l.x, l.y);
    });
    llist.appendChild(row);
  }
  const plist = $('#pingList');
  plist.innerHTML = '';
  // ALL story pings — every map, newest first; involved characters as chips
  // (warning pings are activity markers, never part of the story list)
  const allPings = collectAllPings().filter(it => it.p.ptype !== 'warn');
  if (!allPings.length) plist.innerHTML = `<div class="empty-msg">NO PINGS ANYWHERE — ENABLE ⚑ PING MODE AND CLICK</div>`;
  for (const it of allPings) {
    const p = it.p;
    const off = it.mapId !== state.current;
    const on = sel && sel.type === 'ping' && sel.id === p.id && !off;
    const meta = off ? `<span class="ping-meta">${esc(mapNameOf(it.mapId).toUpperCase())}</span>` : '';
    const row = document.createElement('div');
    row.className = 'ping-row' + (on ? ' on' : '') + (p.hidden ? ' is-hidden' : '');
    row.innerHTML = `<span class="${p.ptype === 'warn' ? 'ping-warn-glyph' : `ping-dot ${p.status === 'finished' ? 'fin' : 'ong'}`}">${p.ptype === 'warn' ? '\u26A0' : ''}</span><span class="ping-name">${esc(p.label || (p.ptype === 'warn' ? 'WARNING' : 'PING'))}${p.ptype === 'warn' ? '' : pingStatusBadge(p)}<span class="ping-chars">${pingChars(p, state.data[it.mapId]?.characters || [])}</span>${meta}</span>
      <span class="row-btns"><button class="rb" data-act="hide" title="Hide / show on map">👁</button><button class="rb warn" title="Remove ping">✕</button></span>`;
    row.addEventListener('click', e => {
      const rb = e.target.closest('.rb');
      if (rb && rb.dataset.act === 'hide') { togglePingHidden(it.mapId, p.id); return; }
      if (rb) { deleteGlobalPing(it.mapId, p.id); return; }
      gotoPing(it.mapId, p.id);
    });
    plist.appendChild(row);
  }
  updateStatus();
}

function updateStatus() {
  const d = curData();
  $('#charCount').textContent = d.characters.length;
  $('#locCount').textContent = d.locations.length;
  $('#pingCount').textContent = collectAllPings().filter(it => it.p.ptype !== 'warn').length;
  $('#stChars').textContent = `${d.characters.length} CHARACTER${d.characters.length === 1 ? '' : 'S'}`;
  $('#stLocs').textContent = `${d.locations.length} LOCATION${d.locations.length === 1 ? '' : 'S'}`;
  $('#stPings').textContent = `${d.pings.length} PING${d.pings.length === 1 ? '' : 'S'}`;
}

function renderAll() { renderMarkers(); renderLocations(); renderPings(); renderShades(); renderSidebar(); renderDrawer(); }

/* ───────── selection ───────── */
function deselect() { sel = null; closePop(); renderMarkers(); renderLocations(); renderPings(); renderShades(); renderSidebar(); }
function selectChar(id) { sel = { type: 'char', id }; renderMarkers(); renderSidebar(); }
function selectPing(id) { sel = { type: 'ping', id }; renderPings(); renderSidebar(); }

/* ───────── popover ───────── */
function openPop(build, px, py) {
  closePop();
  build(pop);
  pop.classList.remove('hidden');
  const w = pop.offsetWidth, h = pop.offsetHeight;
  pop.style.left = clamp(px + 14, 8, viewport.clientWidth - w - 8) + 'px';
  pop.style.top  = clamp(py - 20, 8, viewport.clientHeight - h - 8) + 'px';
}
function closePop() { pop.classList.add('hidden'); pop.innerHTML = ''; }

function popHeader(el, title) {
  el.innerHTML = `<div class="pop-title"><span>${title}</span><button class="x" data-x>✕</button></div>`;
  el.querySelector('[data-x]').addEventListener('click', () => { closePop(); deselect(); });
}
function swatchRow(el, current, onPick) {
  const row = document.createElement('div');
  row.className = 'swatches';
  COLORS.forEach(col => {
    const b = document.createElement('button');
    b.className = 'sw' + (col === current ? ' on' : '');
    b.style.background = col;
    b.addEventListener('click', () => { row.querySelectorAll('.sw').forEach(x => x.classList.remove('on')); b.classList.add('on'); onPick(col); });
    row.appendChild(b);
  });
  el.appendChild(row);
}
let lastColor = COLORS[0];
let lastLocColor = '#e8edf2';

function openAddPop(mx, my, px, py) {
  openPop(el => {
    popHeader(el, 'NEW CHARACTER');
    const inp = document.createElement('input');
    inp.className = 'pop-input'; inp.placeholder = 'CHARACTER NAME…';
    inp.maxLength = 40; inp.spellcheck = false;
    el.appendChild(inp);
    let picked = lastColor;
    swatchRow(el, picked, c => picked = c);
    const act = document.createElement('div');
    act.className = 'pop-actions';
    act.innerHTML = `<button class="pbtn primary">POSITION CHARACTER</button>`;
    const place = () => {
      const name = inp.value.trim();
      if (!name) { inp.focus(); inp.style.borderColor = 'var(--danger)'; return; }
      addChar(name, mx, my, picked);
    };
    act.querySelector('button').addEventListener('click', place);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') place(); e.stopPropagation(); });
    el.appendChild(act);
    setTimeout(() => inp.focus(), 30);
  }, px, py);
}

function openAddLocPop(mx, my, px, py) {
  openPop(el => {
    popHeader(el, 'NEW LOCATION');
    const inp = document.createElement('input');
    inp.className = 'pop-input'; inp.placeholder = 'PLACE NAME (e.g. NEXUS TOWER)…';
    inp.maxLength = 40; inp.spellcheck = false;
    el.appendChild(inp);
    let picked = lastLocColor;
    swatchRow(el, picked === LOCCOLORS_DEFAULT ? COLORS[COLORS.length - 1] : picked, c => picked = c);
    const act = document.createElement('div');
    act.className = 'pop-actions';
    act.innerHTML = `<button class="pbtn primary">MARK LOCATION</button>`;
    const place = () => {
      const name = inp.value.trim();
      if (!name) { inp.focus(); inp.style.borderColor = 'var(--danger)'; return; }
      lastLocColor = picked;
      addLoc(name, mx, my, picked);
    };
    act.querySelector('button').addEventListener('click', place);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') place(); e.stopPropagation(); });
    el.appendChild(act);
    const note = document.createElement('div');
    note.style.cssText = 'font-size:8px;letter-spacing:.14em;color:var(--faint);margin-top:8px;line-height:1.8';
    note.textContent = 'LOCATIONS ARE FIXED — REMOVE AND RE-PLACE TO RELOCATE';
    el.appendChild(note);
    setTimeout(() => inp.focus(), 30);
  }, px, py);
}

function openEditLocPop(l, px, py) {
  openPop(el => {
    popHeader(el, 'LOCATION');
    const inp = document.createElement('input');
    inp.className = 'pop-input'; inp.value = l.name; inp.maxLength = 40; inp.spellcheck = false;
    inp.addEventListener('input', debounce(() => {
      const v = inp.value.trim();
      if (v) { pushHistory(); l.name = v; persist(); renderLocations(); renderSidebar(); toast('LOCATION RENAMED'); }
    }, 450));
    inp.addEventListener('keydown', e => e.stopPropagation());
    el.appendChild(inp);
    swatchRow(el, l.color, col => { pushHistory(); l.color = col; persist(); renderLocations(); renderSidebar(); });
    const act = document.createElement('div');
    act.className = 'pop-actions';
    act.innerHTML = `<button class="pbtn" data-a="centre">⌖ CENTRE</button><button class="pbtn danger" data-a="del">✕ REMOVE</button>`;
    act.addEventListener('click', e => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'centre') centerOn(l.x, l.y);
      if (a === 'del') deleteLoc(l.id);
    });
    el.appendChild(act);
  }, px, py);
}

function openEditPop(c, px, py) {
  openPop(el => {
    popHeader(el, 'CHARACTER');
    const inp = document.createElement('input');
    inp.className = 'pop-input'; inp.value = c.name; inp.maxLength = 40; inp.spellcheck = false;
    inp.addEventListener('input', debounce(() => {
      const v = inp.value.trim();
      if (v) { pushHistory(); c.name = v; persist(); renderMarkers(); renderSidebar(); toast('NAME UPDATED'); }
    }, 500));
    inp.addEventListener('keydown', e => e.stopPropagation());
    el.appendChild(inp);

    swatchRow(el, c.color, col => { pushHistory(); c.color = col; persist(); renderMarkers(); renderSidebar(); });

    const shapes = document.createElement('div');
    shapes.className = 'shape-row';
    ['circle', 'diamond', 'square'].forEach(s => {
      const b = document.createElement('button');
      b.className = 'shape-btn' + ((c.shape || 'circle') === s ? ' on' : '');
      b.textContent = { circle: '● CIRCLE', diamond: '◆ DIAMOND', square: '■ SQUARE' }[s];
      b.addEventListener('click', () => {
        pushHistory(); c.shape = s; persist(); renderMarkers(); renderSidebar();
        shapes.querySelectorAll('.shape-btn').forEach(x => x.classList.remove('on')); b.classList.add('on');
      });
      shapes.appendChild(b);
    });
    el.appendChild(shapes);

    // avatar
    const avRow = document.createElement('div');
    avRow.className = 'avatar-row';
    const paint = () => {
      avRow.innerHTML = c.avatar
        ? `<img class="avatar-prev" src="${c.avatar}" style="--c:${esc(c.color)}"><button class="pbtn" data-av="chg">CHANGE IMAGE</button><button class="pbtn" data-av="rm">REMOVE</button>`
        : `<span class="avatar-none">＋</span><button class="pbtn" data-av="add">ADD IMAGE</button>`;
      avRow.querySelectorAll('[data-av]').forEach(b => b.addEventListener('click', () => {
        const a = b.dataset.av;
        if (a === 'rm') { pushHistory(); c.avatar = null; persist(); renderMarkers(); paint(); return; }
        pickAvatarFile(dataUrl => { pushHistory(); c.avatar = dataUrl; persist(); renderMarkers(); paint(); });
      }));
    };
    paint();
    el.appendChild(avRow);

    const note = document.createElement('textarea');
    note.className = 'pop-note'; note.placeholder = 'NOTES (optional)…'; note.value = c.notes || '';
    note.addEventListener('input', debounce(() => { c.notes = note.value; persist(); }, 400));
    note.addEventListener('keydown', e => e.stopPropagation());
    el.appendChild(note);

    const act = document.createElement('div');
    act.className = 'pop-actions';
    act.innerHTML = `
      <button class="pbtn" data-a="centre">⌖ CENTRE</button>
      <button class="pbtn" data-a="dup">⧉ DUPLICATE</button>
      <button class="pbtn" data-a="xfer">⇄ TRANSFER</button>
      <button class="pbtn" data-a="vis">${c.hidden ? '◎ SHOW' : '◎ HIDE'}</button>
      <button class="pbtn danger" data-a="del">✕ REMOVE</button>`;
    act.addEventListener('click', e => {
      const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
      if (a === 'centre') centerOn(c.x, c.y);
      if (a === 'dup') duplicateChar(c.id);
      if (a === 'xfer') openTransferPop(c, px, py);
      if (a === 'vis') { pushHistory(); c.hidden = !c.hidden; persist(); closePop(); renderAll(); toast(c.hidden ? 'CHARACTER HIDDEN' : 'CHARACTER VISIBLE'); }
      if (a === 'del') deleteChar(c.id);
    });
    el.appendChild(act);
  }, px, py);
}

/* ───────── characters involved in a story ping ─────────
   p.chars holds roster char ids; chips render under the ping title. */
function pingChars(p, roster = curData().characters) {
  return (p.chars || [])
    .map(id => roster.find(c => c.id === id))
    .filter(Boolean)
    .map(c => `<span class="pc" title="${esc(c.name)}"><i style="background:${esc(c.color || COLORS[0])}"></i>${esc(c.name)}</span>`)
    .join('');
}
/* story-ping status: 'ongoing' (default) | 'finished' — badge for sidebar rows */
const pingStatusBadge = p => {
  const fin = p.status === 'finished';
  return `<span class="ping-status ${fin ? 'finished' : 'ongoing'}">${fin ? 'FINISHED' : 'ONGOING'}</span>`;
};
/* TYPE: STORY (⚑) ⇄ WARNING (⚠) — conversion either way */
function popPingKind(el, p) {
  const wrap = document.createElement('div');
  wrap.className = 'pop-inv pop-st';
  wrap.innerHTML = `<div class="pop-inv-title">TYPE</div>`;
  const seg = document.createElement('div');
  seg.className = 'pop-st-seg';
  const mk = (key, label) => {
    const b = document.createElement('button');
    const isWarn = key === 'warn';
    b.className = 'pop-st-btn pingkind' + (isWarn ? ' warn' : '') + ((p.ptype === 'warn') === isWarn ? ' on' : '');
    b.innerHTML = label;
    b.dataset.k = key;
    b.addEventListener('click', () => {
      const live = curData().pings.find(x => x.id === p.id) || p;
      if ((live.ptype === 'warn') === isWarn) return;
      pushHistory();
      if (isWarn) live.ptype = 'warn'; else delete live.ptype;
      p.ptype = live.ptype;
      persist(); renderPings(); renderSidebar();
      closePop(); openPingPop(live, view.tx + live.x * view.z, view.ty + live.y * view.z);
    });
    return b;
  };
  seg.append(mk('story', '⚑ STORY'), mk('warn', '⚠ WARNING'));
  wrap.appendChild(seg);
  el.appendChild(wrap);
}

function popPingStatus(el, p) {
  p.status ||= 'ongoing';
  const wrap = document.createElement('div');
  wrap.className = 'pop-inv pop-st';
  wrap.innerHTML = `<div class="pop-inv-title">STATUS</div>`;
  const seg = document.createElement('div');
  seg.className = 'pop-st-seg';
  const mk = (key, label) => {
    const b = document.createElement('button');
    b.className = `pop-st-btn ${key}` + (p.status === key ? ' on' : '');
    b.textContent = label;
    b.addEventListener('click', () => {
      const live = curData().pings.find(x => x.id === p.id) || p;
      if ((live.status || 'ongoing') === key) return;
      pushHistory();
      live.status = key; p.status = key;
      persist(); renderPings(); renderSidebar();
      seg.querySelectorAll('.pop-st-btn').forEach(x => x.classList.toggle('on', x.dataset.k === key));
    });
    b.dataset.k = key;
    return b;
  };
  seg.append(mk('ongoing', 'ONGOING'), mk('finished', 'FINISHED'));
  wrap.appendChild(seg);
  el.appendChild(wrap);
}

function popInvolvedChars(el, p) {
  p.chars ||= [];
  const wrap = document.createElement('div');
  wrap.className = 'pop-inv';
  wrap.innerHTML = `<div class="pop-inv-title">CHARACTERS INVOLVED</div>`;
  const box = document.createElement('div');
  box.className = 'inv-chips';
  const roster = curData().characters;
  if (!roster.length) {
    const none = document.createElement('div');
    none.className = 'pop-inv-none';
    none.textContent = 'NO CHARACTERS YET — ADD THEM IN ＋ MODE';
    box.appendChild(none);
  }
  for (const c of roster) {
    const b = document.createElement('button');
    b.className = 'pc inv' + (p.chars.includes(c.id) ? ' on' : '');
    b.innerHTML = `<i style="background:${esc(c.color || COLORS[0])}"></i>${esc(c.name)}`;
    b.addEventListener('click', () => {
      const live = curData().pings.find(x => x.id === p.id) || p;
      live.chars ||= [];
      const j = live.chars.indexOf(c.id);
      pushHistory();
      if (j >= 0) live.chars.splice(j, 1); else live.chars.push(c.id);
      persist(); renderSidebar();
      b.classList.toggle('on', live.chars.includes(c.id));
    });
    box.appendChild(b);
  }
  wrap.appendChild(box);
  el.appendChild(wrap);
}

/* instantly commit a ping's label (popup SET button, Enter key, input debounce) */
function setPingLabel(id, v) {
  const p = curData().pings.find(x => x.id === id);
  if (!p || (p.label || '') === v) return;
  pushHistory(); p.label = v; persist(); renderPings(); renderSidebar();
}
/* ───────── red-zone (shade) popup ───────── */
function openShadePop(sh, px, py) {
  openPop(el => {
    popHeader(el, 'RED ZONE');
    const live = () => (curData().shades || []).find(x => x.id === sh.id) || sh;
    const note0 = document.createElement('div');
    note0.className = 'pop-inv-none';
    note0.style.marginBottom = '6px';
    note0.textContent = 'ACTIVITY SHADING — LOW-OCCUPANCY SCALE';
    el.appendChild(note0);

    // intensity: light red → strong red
    const wrap = document.createElement('div');
    wrap.className = 'pop-inv pop-st';
    wrap.innerHTML = `<div class="pop-inv-title">INTENSITY (LOW OCCUPANCY)</div>`;
    const seg = document.createElement('div');
    seg.className = 'pop-st-seg';
    const mkI = (lvl, label) => {
      const b = document.createElement('button');
      b.className = 'pop-st-btn shade-lv' + (lvI(sh) === lvl ? ' on' : '');
      b.dataset.k = lvl;
      b.innerHTML = label;
      b.addEventListener('click', () => {
        pushHistory();
        live().level = lvl; sh.level = lvl;
        persist(); renderShades();
        seg.querySelectorAll('.pop-st-btn').forEach(x => x.classList.toggle('on', +x.dataset.k === lvl));
      });
      return b;
    };
    function lvI(x) { return x.level || 2; }
    seg.append(mkI(1, 'LOW'), mkI(2, 'MED'), mkI(3, 'HIGH'));
    wrap.appendChild(seg);
    el.appendChild(wrap);

    // zone color (default red)
    const cw = document.createElement('div');
    cw.className = 'pop-inv pop-st';
    cw.innerHTML = `<div class="pop-inv-title">COLOR</div>`;
    el.appendChild(cw);
    swatchRow(cw, sh.color || '#ff2f2f', c => {
      pushHistory();
      live().color = c; sh.color = c;
      persist(); renderShades();
    });

    // size segment S / M / L (world-px radii so zones scale with the map)
    const wrap2 = document.createElement('div');
    wrap2.className = 'pop-inv pop-st';
    wrap2.innerHTML = `<div class="pop-inv-title">SIZE</div>`;
    const seg2 = document.createElement('div');
    seg2.className = 'pop-st-seg';
    const curKey = () => {
      const r = sh.r || SHADE_RADII.m;
      if (r <= SHADE_RADII.s) return 's';
      if (r >= SHADE_RADII.l) return 'l';
      return 'm';
    };
    const mkR = (key, label) => {
      const b = document.createElement('button');
      b.className = 'pop-st-btn' + (curKey() === key ? ' on' : '');
      b.dataset.k = key;
      b.textContent = label;
      b.addEventListener('click', () => {
        pushHistory();
        live().r = SHADE_RADII[key]; sh.r = SHADE_RADII[key];
        persist(); renderShades();
        seg2.querySelectorAll('.pop-st-btn').forEach(x => x.classList.toggle('on', x.dataset.k === key));
      });
      return b;
    };
    seg2.append(mkR('s', 'S'), mkR('m', 'M'), mkR('l', 'L'));
    wrap2.appendChild(seg2);
    el.appendChild(wrap2);

    // optional note
    const inp = document.createElement('input');
    inp.className = 'pop-input'; inp.value = sh.note || '';
    inp.placeholder = 'NOTE (e.g. HOWLER ACTIVITY)…'; inp.maxLength = 60; inp.spellcheck = false;
    inp.addEventListener('input', debounce(() => { pushHistory(); live().note = inp.value.trim(); persist(); }, 400));
    inp.addEventListener('keydown', e => e.stopPropagation());
    el.appendChild(inp);

    const act = document.createElement('div');
    act.className = 'pop-actions';
    act.innerHTML = `<button class="pbtn" data-a="centre">⌖ CENTRE</button><button class="pbtn" data-a="vis">${sh.hidden ? '◎ SHOW' : '◎ HIDE'}</button><button class="pbtn danger" data-a="del">✕ CLEAR ZONE</button>`;
    act.addEventListener('click', e => {
      const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
      if (a === 'centre') centerOn(live().x, live().y);
      if (a === 'vis') toggleShadeHidden(live().id);
      if (a === 'del') deleteShade(live().id);
    });
    el.appendChild(act);
  }, px, py);
}

function openPingPop(p, px, py) {
  openPop(el => {
    popHeader(el, p.ptype === 'warn' ? '⚠ WARNING' : 'PING');
    const live = () => curData().pings.find(x => x.id === p.id) || p;
    const inp = document.createElement('input');
    inp.className = 'pop-input'; inp.value = p.label || ''; inp.placeholder = 'LABEL (e.g. MEETING POINT)…';
    inp.maxLength = 40; inp.spellcheck = false;
    const commitLabel = () => setPingLabel(live().id, inp.value.trim());
    inp.addEventListener('input', debounce(commitLabel, 350));
    inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') commitLabel(); });
    el.appendChild(inp);
    // TYPE toggle — story ping vs warning ping (activity marker; admins only)
    if (adminOn) popPingKind(el, p);
    // ongoing / finished status toggle (story pings only)
    if (p.ptype !== 'warn') popPingStatus(el, p);
    // warn color (admins only)
    if (p.ptype === 'warn' && adminOn) {
      const cw = document.createElement('div');
      cw.className = 'pop-inv pop-st';
      cw.innerHTML = `<div class="pop-inv-title">COLOR</div>`;
      el.appendChild(cw);
      swatchRow(cw, p.color || '#ff4438', c => {
        pushHistory();
        live().color = c; p.color = c;
        persist(); renderPings(); renderSidebar();
      });
    }
    // characters involved in this story ping — toggle roster chips
    popInvolvedChars(el, p);
    const act = document.createElement('div');
    act.className = 'pop-actions';
    act.innerHTML = `<button class="pbtn" data-a="set">✓ SET</button><button class="pbtn" data-a="centre">⌖ CENTRE</button><button class="pbtn amber" data-a="del">✕ REMOVE PING</button>`;
    act.addEventListener('click', e => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'set') { commitLabel(); persistNow(); toast('PING SET', 'green'); renderSidebar(); }
      if (a === 'centre') centerOn(live().x, live().y);
      if (a === 'del') deletePing(live().id);
    });
    el.appendChild(act);
    setTimeout(() => inp.focus(), 30);
  }, px, py);
}

function avatarOf(c) { return c.avatar; }
function pickAvatarFile(cb) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = () => {
    const f = inp.files[0]; if (!f) return;
    const img = new Image();
    img.onload = () => {
      const s = 96, cv = document.createElement('canvas');
      cv.width = cv.height = s;
      const cx = cv.getContext('2d');
      const sc = Math.max(s / img.width, s / img.height);
      cx.drawImage(img, (s - img.width * sc) / 2, (s - img.height * sc) / 2, img.width * sc, img.height * sc);
      URL.revokeObjectURL(img.src);
      cb(cv.toDataURL('image/jpeg', 0.85));
    };
    img.src = URL.createObjectURL(f);
  };
  inp.click();
}

/* ───────── character / ping mutations ───────── */
function addChar(name, x, y, color) {
  pushHistory();
  lastColor = color;
  const c = { id: uid(), name, x, y, color, shape: 'circle', avatar: null, notes: '', hidden: false };
  curData().characters.push(c);
  sel = { type: 'char', id: c.id };
  if (!state.hintDone) { state.hintDone = true; hint.classList.add('hidden'); }
  persist(); closePop(); renderAll();
  toast('CHARACTER POSITIONED');
}
function deleteChar(id) {
  pushHistory();
  const d = curData();
  d.characters = d.characters.filter(c => c.id !== id);
  scrubCharEverywhere(id);
  if (sel?.type === 'char' && sel.id === id) sel = null;
  persist(); closePop(); renderAll();
  toast('CHARACTER REMOVED', 'red');
}
function duplicateChar(id) {
  const c = charIndex.get(id) || curData().characters.find(x => x.id === id);
  if (!c) return;
  pushHistory();
  const copy = { ...c, id: uid(), x: c.x + 26 / view.z, y: c.y + 26 / view.z };
  curData().characters.push(copy);
  sel = { type: 'char', id: copy.id };
  persist(); closePop(); renderAll();
  toast('CHARACTER DUPLICATED');
}

/* ───────── character transfer between sectors ─────────
   Moves a character to another map's roster — name, colour, shape, avatar,
   notes and story-ping involvements all survive (same id); only the new
   position needs a click. One undo step; syncs as one entity move. */
function transferChar(id, targetMapId, opts = {}) {
  const src = curData();
  const c = src.characters.find(x => x.id === id);
  const tgt = state.maps[targetMapId];
  if (!c || !tgt || targetMapId === state.current) return null;
  pushHistory();
  const copy = { ...c };
  delete copy.x; delete copy.y;
  copy.unplaced = true;
  src.characters = src.characters.filter(x => x.id !== id);
  mData(targetMapId).characters.push(copy);
  if (sel?.type === 'char' && sel.id === id) sel = null;
  persist(); closePop(); renderAll();
  toast(`${copy.name.toUpperCase()} MOVED TO ${(tgt.sector ? 'SECTOR ' + tgt.sector : tgt.name).toUpperCase()} — PLACE FROM ITS ROSTER`, 'green');
  if (opts.follow) {
    switchMap(targetMapId, { silent: true });
    beginPlacement(copy.id);
    renderAll();
  }
  return copy;
}

function openTransferPop(c, px, py) {
  openPop(el => {
    popHeader(el, 'TRANSFER CHARACTER');
    const lbl = document.createElement('div');
    lbl.className = 'pop-inv-none';
    lbl.style.marginBottom = '7px';
    lbl.textContent = `MOVE ${(c.name || 'CHARACTER').toUpperCase()} — EVERYTHING IS KEPT; PLACE IT ON THE NEW MAP.`;
    el.appendChild(lbl);
    const list = document.createElement('div');
    for (const mid of state.order) {
      if (mid === state.current || !state.maps[mid]) continue;
      const m = state.maps[mid];
      const row = document.createElement('div');
      row.className = 'xfer-row';
      row.innerHTML = `<button class="pbtn xfer-t" data-m="${mid}">${m.sector ? '⇄ SECTOR ' + m.sector.toUpperCase() : '⇄ ' + esc(m.name).toUpperCase()}</button><button class="pbtn xfer-go" data-m="${mid}" title="Move there and jump to the map to place">➤</button>`;
      list.appendChild(row);
    }
    list.addEventListener('click', e => {
      const b = e.target.closest('[data-m]'); if (!b) return;
      transferChar(c.id, b.dataset.m, { follow: b.className.includes('xfer-go') });
    });
    el.appendChild(list);
  }, px, py);
}
function addPing(x, y, kind) {
  pushHistory();
  const p = { id: uid(), x, y, label: '', createdAt: Date.now(), chars: [], status: 'ongoing' };
  if (kind === 'warn') { p.ptype = 'warn'; p.color = '#ff4438'; }
  curData().pings.push(p);
  sel = { type: 'ping', id: p.id };
  persist(); renderPings(); renderSidebar();
  toast('PING DROPPED', 'amber');
  return p;
}
function deletePing(id) {
  pushHistory();
  const d = curData();
  d.pings = d.pings.filter(p => p.id !== id);
  if (sel?.type === 'ping' && sel.id === id) sel = null;
  persist(); closePop(); renderPings(); renderSidebar();
  toast('PING REMOVED', 'amber');
}

/* ───────── ADMIN MODE — red zones & warning pings are admin-only ─────────
   Locked by default; unlock with the access code. Flag persists per-browser. */
const ADMIN_CODE = 'virtus25';
const ADMIN_KEY = LS_KEY + ':admin';
let adminOn = false;
function isAdmin() { return adminOn; }
function setAdmin(on, quiet) {
  adminOn = !!on;
  try { localStorage.setItem(ADMIN_KEY, adminOn ? '1' : '0'); } catch (e) { }
  applyAdminUI();
  if (!quiet) toast(adminOn ? 'ADMIN MODE ON — SHADES & WARNINGS EDITABLE' : 'ADMIN MODE LOCKED', adminOn ? 'green' : 'amber');
}
function applyAdminUI() {
  const b = $('#btnAdmin');
  if (b) {
    b.classList.toggle('on', adminOn);
    const ico = b.querySelector('.ico'); if (ico) ico.textContent = adminOn ? '🔓' : '🔒';
  }
  try { (document.querySelectorAll('#modeGroup [data-admin]') || []).forEach(x => x.classList.toggle('hidden', !adminOn)); } catch (e) { }
  if (!adminOn) {
    closePop();
    if (mode === 'warn' || mode === 'shade') setMode('select');
  }
  if (state) { renderPings(); renderShades(); }
}
function unlockAdmin(code) {
  if (String(code || '').trim() === ADMIN_CODE) { setAdmin(true); return true; }
  toast('WRONG ACCESS CODE', 'red');
  return false;
}
function openAdminPop() {
  if (adminOn) { setAdmin(false); return; }
  openPop(el => {
    popHeader(el, '🔒 ADMIN MODE');
    const msg = document.createElement('div');
    msg.className = 'pop-inv-none';
    msg.style.marginBottom = '6px';
    msg.textContent = 'ACCESS CODE REQUIRED TO CONTROL RED ZONES & WARNINGS';
    el.appendChild(msg);
    const inp = document.createElement('input');
    inp.type = 'password'; inp.className = 'pop-input'; inp.placeholder = 'ACCESS CODE…';
    inp.maxLength = 40; inp.spellcheck = false;
    el.appendChild(inp);
    const act = document.createElement('div');
    act.className = 'pop-actions';
    act.innerHTML = `<button class="pbtn primary" data-a="go">UNLOCK</button>`;
    const go = () => { if (unlockAdmin(inp.value)) closePop(); else { inp.value = ''; inp.focus(); } };
    act.querySelector('button').addEventListener('click', go);
    inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') go(); });
    el.appendChild(act);
    setTimeout(() => inp.focus(), 30);
  }, 80, 72);
}

/* hex '#rrggbb' → {r,g,b} for building translucent fills */
function hexRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return { r: 255, g: 47, b: 47 };
  const v = parseInt(m[1], 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}

/* ───────── RED ZONES (activity shading) ─────────
   Shades live inside #world so they scale/pan with the map — they mark
   geography. Intensity ramps from light to strong red on an occupancy scale. */
const SHADE_LEVELS = {
  1: { label: 'LOW',  a1: 0.13, a2: 0.05 },
  2: { label: 'MED',  a1: 0.26, a2: 0.10 },
  3: { label: 'HIGH', a1: 0.45, a2: 0.18 },
};
const SHADE_RADII = { s: 90, m: 190, l: 360 };

function addShade(x, y) {
  pushHistory();
  const sh = { id: uid(), x, y, r: SHADE_RADII.m, level: 2, note: '', color: '#ff2f2f' };
  curData().shades.push(sh);
  sel = { type: 'shade', id: sh.id };
  persist(); renderShades(); renderSidebar();
  toast('ZONE SHADED', 'red');
  return sh;
}

function deleteShade(id) {
  pushHistory();
  const d = curData();
  d.shades = (d.shades || []).filter(x => x.id !== id);
  if (sel?.type === 'shade' && sel.id === id) sel = null;
  persist(); closePop(); renderShades(); renderSidebar();
  toast('ZONE CLEARED', 'red');
}

function toggleShadeHidden(id) {
  pushHistory();
  const sh = (curData().shades || []).find(x => x.id === id);
  if (!sh) return;
  sh.hidden = !sh.hidden;
  persist(); renderShades(); renderSidebar(); closePop();
}

function renderShades() {
  shadeLayer.innerHTML = '';
  const d = curData();
  for (const sh of (d.shades || [])) {
    if (sh.hidden) continue;
    const lv = SHADE_LEVELS[sh.level] || SHADE_LEVELS[2];
    const r = sh.r || SHADE_RADII.m;
    const el = document.createElement('div');
    el.className = 'shade' + (sel && sel.type === 'shade' && sel.id === sh.id ? ' sel' : '');
    el.style.left = sh.x + 'px'; el.style.top = sh.y + 'px';
    el.style.width = el.style.height = (2 * r) + 'px';
    const c = hexRgb(sh.color);
    el.style.background = `radial-gradient(circle, rgba(${c.r},${c.g},${c.b},${lv.a1}) 0%, rgba(${c.r},${c.g},${c.b},${lv.a2}) 55%, rgba(${c.r},${c.g},${c.b},0) 72%)`;
    el.style.borderColor = `rgba(${c.r},${c.g},${c.b},${lv.a1 * 2})`;
    el.dataset.id = sh.id;
    if (adminOn) el.addEventListener('pointerdown', e => startEntityDrag(e, sh, el, 'shade'));
    else el.addEventListener('pointerdown', e => { e.stopPropagation(); toast('ADMIN MODE NEEDED TO EDIT ZONES — TAP 🔒', 'amber'); });
    shadeLayer.appendChild(el);
  }
}

/* ───────── dragging markers / pings ───────── */
function startEntityDrag(e, ent, el, kind) {
  if (e.button !== 0) return;
  e.stopPropagation();
  const { px, py } = evPos(e);
  const start = { px, py, x: ent.x, y: ent.y, moved: false };
  dragSnap = snapshot();
  el.classList.add('drag');
  el.setPointerCapture(e.pointerId);

  const onMove = ev => {
    const p = evPos(ev);
    const dx = (p.px - start.px) / view.z, dy = (p.py - start.py) / view.z;
    if (!start.moved && Math.hypot(p.px - start.px, p.py - start.py) < 4) return;
    start.moved = true;
    closePop();
    ent.x = start.x + dx; ent.y = start.y + dy;
    if (kind === 'shade') { el.style.left = ent.x + 'px'; el.style.top = ent.y + 'px'; }
    else { el.dataset.wx = ent.x; el.dataset.wy = ent.y; placeMarker(el); }
    window.liveDragTick?.();
  };
  const onUp = ev => {
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.classList.remove('drag');
    suppressMapClick = true; setTimeout(() => suppressMapClick = false, 60);
    if (start.moved) {
      pushHistory(dragSnap);
      redoStack.length = 0;
      persist();
      toast(kind === 'char' ? 'POSITION UPDATED' : 'PING MOVED', kind === 'ping' ? 'amber' : '');
      renderSidebar();
    } else {
      const p = evPos(ev);
      if (kind === 'char') { sel = { type: 'char', id: ent.id }; renderMarkers(); renderSidebar(); openEditPop(ent, p.px, p.py); }
      else if (kind === 'ping') { sel = { type: 'ping', id: ent.id }; renderPings(); renderSidebar(); openPingPop(ent, p.px, p.py); }
      else if (kind === 'shade') { sel = { type: 'shade', id: ent.id }; renderShades(); openShadePop(ent, p.px, p.py); }
    }
    dragSnap = null;
  };
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
}

/* ───────── map drawer ───────── */
function mapPingCount(id) {
  // visible story pings only (Locations, characters, hidden & warning pings never count)
  return (state.data[id]?.pings || []).filter(p => !p.hidden && p.ptype !== 'warn').length;
}
function renderDrawer() {
  const grid = $('#mapGrid');
  grid.innerHTML = '';
  const onOverview = !!state.maps[state.current]?.overview;
  $('#drawerTitle').textContent = onOverview ? 'ROSEBRIDGE — SELECT SECTOR' : 'SELECT MAP';
  // sector menu: moderate-quality overview image split into a 3x3 grid;
  // clicking a section opens that sector's high-definition map
  const ov = Object.values(state.maps).find(m => m.overview && m.menu);
  if (ov) {
    const menu = document.createElement('div');
    menu.className = 'sector-menu';
    const img = document.createElement('img');
    img.src = ov.menu; img.alt = 'Rosebridge overview'; img.className = 'sm-img';
    img.draggable = false;
    menu.appendChild(img);
    for (const m of Object.values(state.maps)) {
      if (!m.sector) continue;
      const row = 'abc'.indexOf(m.sector[0]), col = +m.sector[1] - 1;
      const cell = document.createElement('button');
      cell.className = 'sm-cell' + (state.current === m.id ? ' on' : '');
      cell.style.left = (col * 100 / 3) + '%';
      cell.style.top = (row * 100 / 3) + '%';
      const n = mapPingCount(m.id);
      cell.innerHTML = `<span class="sm-name">${m.sector.toUpperCase()}</span>${n ? `<span class="sm-count">${n} ⚑</span>` : ''}`;
      cell.title = `${m.name.toUpperCase()} — HIGH DEFINITION`;
      cell.addEventListener('click', () => { $('#mapDrawer').classList.add('hidden'); switchMap(m.id); });
      menu.appendChild(cell);
    }
    grid.appendChild(menu);
  }
  for (const id of state.order) {
    const m = state.maps[id];
    const n = mapPingCount(id);
    const card = document.createElement('button');
    card.className = 'map-card' + (id === state.current ? ' on' : '');
    card.innerHTML = `<img src="${m.thumb || m.src}" alt="" loading="lazy"><span class="mc-name">${esc(m.name)}</span>${n ? `<span class="mc-count">${n} ⚑</span>` : ''}`;
    card.addEventListener('click', () => { $('#mapDrawer').classList.add('hidden'); switchMap(id); });
    grid.appendChild(card);
  }
  const up = document.createElement('button');
  up.className = 'map-card upload';
  up.innerHTML = `<span>⇧ UPLOAD IMAGE / .KMZ</span>`;
  up.addEventListener('click', () => $('#uploadMap').click());
  grid.appendChild(up);
}

function handleMapUpload(file) {
  if (/\.kmz$/i.test(file.name) || file.type === 'application/vnd.google-earth.kmz') { handleKmz(file); return; }
  addCustomMapFromUrl(file.name, URL.createObjectURL(file), true, true);
}

function addCustomMapFromUrl(name, url, revoke, switchTo) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const MAX = 3200;
      let { width: w, height: h } = img;
      const cv = document.createElement('canvas');
      if (Math.max(w, h) > MAX) { const k = MAX / Math.max(w, h); w = Math.round(w * k); h = Math.round(h * k); }
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      if (revoke) URL.revokeObjectURL(url);
      const id = 'u_' + uid();
      const nm = name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').toUpperCase().slice(0, 40) || 'CUSTOM MAP';
      state.maps[id] = { id, name: nm, src: cv.toDataURL('image/jpeg', 0.86), builtin: false };
      state.order.push(id);
      if (switchTo) { $('#mapDrawer').classList.add('hidden'); switchMap(id); toast('CUSTOM MAP ADDED'); }
      else renderDrawer();
      resolve();
    };
    img.onerror = () => { if (revoke) URL.revokeObjectURL(url); toast('IMAGE COULD NOT BE READ', 'red'); reject(new Error('image read failed')); };
    img.src = url;
  });
}

/* ───────── KMZ import (Google Earth packages) ─────────
   Only the ground-overlay imagery is imported. Placemarks,
   labels, paths and other KML elements are ignored on purpose. */
function parseZip(buf) {
  const dv = new DataView(buf);
  let eocd = -1;
  for (let i = dv.byteLength - 22; i >= Math.max(0, dv.byteLength - 22 - 65536); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a KMZ/ZIP package');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const td = new TextDecoder();
  const files = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const csize  = dv.getUint32(off + 20, true);
    const nameLen  = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const comLen   = dv.getUint16(off + 32, true);
    const lho      = dv.getUint32(off + 42, true);
    const name = td.decode(new Uint8Array(buf, off + 46, nameLen));
    files.push({ name, method, csize, lho });
    off += 46 + nameLen + extraLen + comLen;
  }
  for (const f of files) {
    const nameLen  = dv.getUint16(f.lho + 26, true);
    const extraLen = dv.getUint16(f.lho + 28, true);
    f.start = f.lho + 30 + nameLen + extraLen;
  }
  return { buf, files };
}
async function zipRead(z, f) {
  const raw = new Uint8Array(z.buf, f.start, f.csize);
  if (f.method === 0) return raw;
  if (f.method === 8) {
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new Error('unsupported compression method ' + f.method);
}

async function handleKmz(file) {
  toast('UNPACKING KMZ…', 'amber');
  try {
    const z = parseZip(await file.arrayBuffer());
    const kmlEntry = z.files.find(f => f.name.toLowerCase().endsWith('.kml'));
    const overlays = [];
    if (kmlEntry) {
      const doc = new DOMParser().parseFromString(new TextDecoder().decode(await zipRead(z, kmlEntry)), 'text/xml');
      for (const go of [...doc.getElementsByTagName('*')].filter(e => e.localName === 'GroundOverlay')) {
        const get = t => { const el = [...go.getElementsByTagName('*')].find(e => e.localName === t); return el ? el.textContent.trim() : ''; };
        const href = get('href');
        if (href) overlays.push({ name: get('name'), href });
      }
    }
    const imgRe = /\.(png|jpe?g|webp|gif|bmp)$/i;
    const targets = [];
    for (const o of overlays) {
      const h = o.href.replace(/^\.?\//, '');
      const match = z.files.find(f => f.name === h)
        || z.files.find(f => { try { return decodeURIComponent(f.name) === decodeURIComponent(h); } catch { return false; } })
        || z.files.find(f => f.name.split('/').pop() === h.split('/').pop());
      if (match) targets.push({ name: o.name || match.name.split('/').pop(), entry: match });
    }
    if (!targets.length) {
      const imgs = z.files.filter(f => imgRe.test(f.name)).sort((a, b) => b.csize - a.csize);
      if (!imgs.length) { toast('KMZ CONTAINS NO USABLE MAP IMAGE', 'red'); return; }
      targets.push(...imgs.map(f => ({ name: f.name.split('/').pop(), entry: f })));
    }
    const seen = new Set();
    let added = 0;
    for (const t of targets) {
      if (seen.has(t.entry.name)) continue;
      seen.add(t.entry.name);
      const data = await zipRead(z, t.entry);
      const ext = t.entry.name.split('.').pop().toLowerCase();
      const mime = { png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' }[ext] || 'image/jpeg';
      try {
        await addCustomMapFromUrl(t.name, URL.createObjectURL(new Blob([data], { type: mime })), true, added === 0);
        added++;
      } catch { /* single bad image shouldn't abort the rest */ }
    }
    if (added) toast(`${added} MAP${added > 1 ? 'S' : ''} IMPORTED FROM KMZ — LABELS STRIPPED`);
    else toast('KMZ CONTAINS NO USABLE MAP IMAGE', 'red');
  } catch (err) {
    console.warn('KMZ import:', err);
    toast('KMZ IMPORT FAILED — ' + (err.message || 'INVALID PACKAGE').toUpperCase(), 'red');
  }
}

/* ───────── export / import ───────── */
function exportSetup() {
  const payload = JSON.stringify({ app: 'virtus-character-tracker', v: 1, exported: new Date().toISOString(), state }, null, 2);
  const a = document.createElement('a');
  const d = new Date(), p = n => String(n).padStart(2, '0');
  a.href = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
  a.download = `virtus-setup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('SETUP EXPORTED');
}
function importSetup(file) {
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const parsed = JSON.parse(rd.result);
      const s = parsed.state || parsed;
      if (!s || !s.maps || !s.data || !s.order) throw new Error('bad format');
      pushHistory();
      state = Object.assign(freshState(), s);
      ensureBuiltins();
      runMapMigrations();
      migrateRosebridgeSectors();
      sel = null; closePop();
      applyTheme(); applyLabels();
      switchMap(state.current, { silent: true, skipViewSave: true });
      persistNow();
      toast('SETUP IMPORTED');
    } catch { toast('IMPORT FAILED — INVALID FILE', 'red'); }
  };
  rd.readAsText(file);
}

/* ───────── screenshot capture ───────── */
function captureView() {
  if (!imgNW) return;
  const capMap = state.maps[state.current];
  if (capMap?.tiles && (!mapImg.complete || !mapImg.naturalWidth)) {
    // full-res master is only loaded on demand for exports
    veil.classList.add('on');
    mapImg.onload = () => { veil.classList.remove('on'); captureView(); };
    mapImg.onerror = () => { veil.classList.remove('on'); toast('MAP IMAGE FAILED TO LOAD', 'red'); };
    mapImg.src = capMap.src;
    return;
  }
  try {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const vw = viewport.clientWidth, vh = viewport.clientHeight;
    const cv = document.createElement('canvas');
    cv.width = vw * dpr; cv.height = vh * dpr;
    const x = cv.getContext('2d');
    x.scale(dpr, dpr);
    x.fillStyle = getComputedStyle(document.body).getPropertyValue('--bg') || '#0a0e10';
    x.fillRect(0, 0, vw, vh);
    x.drawImage(mapImg, view.tx, view.ty, imgNW * view.z, imgNH * view.z);
    if (capMap?.tiles) mapImg.removeAttribute('src');   // release the giant decode after capture

    // locations (fixed place pins)
    for (const l of curData().locations) {
      const sx = l.x * view.z + view.tx, sy = l.y * view.z + view.ty;
      const col = l.color || '#e8edf2';
      x.save();
      x.fillStyle = col; x.shadowColor = col; x.shadowBlur = 12;
      x.beginPath(); x.arc(sx, sy - 9, 6.5, 0, 7); x.fill();
      x.beginPath(); x.moveTo(sx - 5.2, sy - 6.2); x.lineTo(sx, sy); x.lineTo(sx + 5.2, sy - 6.2); x.closePath(); x.fill();
      x.shadowBlur = 0;
      x.beginPath(); x.arc(sx, sy - 9, 2.2, 0, 7); x.fillStyle = 'rgba(10,14,13,.9)'; x.fill();
      x.restore();
      if (state.labels) drawLabel(x, l.name, sx + 12, sy - 12, col, '#f2f7fb');
    }
    // pings
    for (const p of curData().pings) {
      const sx = p.x * view.z + view.tx, sy = p.y * view.z + view.ty;
      x.save();
      x.translate(sx, sy); x.rotate(Math.PI / 4);
      x.fillStyle = '#ffb347';
      x.shadowColor = '#ffb347'; x.shadowBlur = 14;
      x.fillRect(-6, -6, 12, 12);
      x.restore();
      if (state.labels && p.label) drawLabel(x, p.label, sx + 12, sy, '#ffb347', '#ffb347');
    }
    // characters
    for (const c of curData().characters) {
      if (c.hidden) continue;
      const sx = c.x * view.z + view.tx, sy = c.y * view.z + view.ty;
      x.save();
      if (c.shape === 'diamond') { x.translate(sx, sy); x.rotate(Math.PI / 4); x.translate(-sx, -sy); }
      x.beginPath();
      if (!c.shape || c.shape === 'circle') x.arc(sx, sy, c.avatar ? 13 : 7, 0, 7);
      else x.rect(sx - 7, sy - 7, 14, 14);
      x.fillStyle = c.color; x.shadowColor = c.color; x.shadowBlur = 12;
      x.fill();
      x.shadowBlur = 0; x.lineWidth = 2; x.strokeStyle = 'rgba(255,255,255,.9)'; x.stroke();
      x.restore();
      if (state.labels) drawLabel(x, c.name, sx + (c.avatar ? 18 : 12), sy, c.color, '#eafff7');
    }
    const a = document.createElement('a');
    a.download = `virtus-map-${state.current}.png`;
    a.href = cv.toDataURL('image/png');
    a.click();
    toast('VIEW CAPTURED');
  } catch { toast('CAPTURE FAILED', 'red'); }
}
function drawLabel(x, text, sx, sy, accent, fg) {
  x.font = '700 11px ui-monospace, Menlo, Consolas, monospace';
  const label = text.toUpperCase();
  const w = x.measureText(label).width;
  x.fillStyle = 'rgba(5,10,9,.85)';
  x.fillRect(sx, sy - 9, w + 14, 18);
  x.fillStyle = accent;
  x.fillRect(sx, sy - 9, 3, 18);
  x.strokeStyle = 'rgba(120,220,190,.35)';
  x.strokeRect(sx + .5, sy - 8.5, w + 14, 18);
  x.fillStyle = fg;
  x.textBaseline = 'middle';
  x.fillText(label, sx + 8, sy + 1);
}

/* ───────── modal ───────── */
function openModal(title, bodyHtml, actions) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHtml;
  const act = $('#modalActions');
  act.innerHTML = '';
  actions.forEach(a => {
    const b = document.createElement('button');
    b.className = 'pbtn ' + (a.cls || '');
    b.textContent = a.label;
    b.addEventListener('click', () => { $('#modal').classList.add('hidden'); a.fn && a.fn(); });
    act.appendChild(b);
  });
  $('#modal').classList.remove('hidden');
}
function confirmClear() {
  const d = curData();
  if (!d.characters.length && !d.pings.length && !d.locations.length) { toast('MAP ALREADY CLEAR'); return; }
  openModal('CLEAR MAP',
    `Remove <b style="color:var(--acc)">${d.characters.length} characters</b>, <b>${d.locations.length} locations</b> and <b style="color:var(--amb)">${d.pings.length} pings</b> from <b>${esc(state.maps[state.current].name)}</b>?<br><span style="color:var(--dim)">This can be undone with Ctrl+Z.</span>`,
    [{ label: 'CANCEL' }, { label: 'CLEAR EVERYTHING', cls: 'danger', fn: () => {
      pushHistory();
      curData().characters = []; curData().pings = []; curData().locations = [];
      sel = null; closePop(); renderAll(); persist();
      toast('MAP CLEARED', 'red');
    }}]);
}
function showHelp() {
  openModal('KEYBOARD SHORTCUTS', `<table>
    <tr><td><kbd>V</kbd></td><td>Select / pan mode</td></tr>
    <tr><td><kbd>N</kbd></td><td>Add-character mode (click map)</td></tr>
    <tr><td><kbd>B</kbd></td><td>Location mode (fixed place markers)</td></tr>
    <tr><td><kbd>P</kbd></td><td>Ping mode (click map)</td></tr>
    <tr><td><kbd>F</kbd></td><td>Fit map to screen</td></tr>
    <tr><td><kbd>+</kbd> / <kbd>−</kbd></td><td>Zoom in / out</td></tr>
    <tr><td><kbd>←→↑↓</kbd></td><td>Nudge selected character</td></tr>
    <tr><td><kbd>L</kbd></td><td>Toggle name labels</td></tr>
    <tr><td><kbd>Del</kbd></td><td>Remove selected marker</td></tr>
    <tr><td><kbd>Ctrl+Z</kbd> / <kbd>Ctrl+Y</kbd></td><td>Undo / redo</td></tr>
    <tr><td><kbd>Ctrl+S</kbd></td><td>Export setup as JSON</td></tr>
    <tr><td><kbd>Esc</kbd></td><td>Close panel / deselect</td></tr>
  </table>`, [{ label: 'CLOSE', cls: 'primary' }]);
}

/* ───────── theme / labels / mode ───────── */
function applyTheme() { document.body.classList.toggle('light', state.theme === 'light'); }
function applyLabels() {
  const on = state.labels;
  $('#btnLabels').classList.toggle('active', on);
  markerLayer.classList.toggle('nolabels', !on);
  locLayer.classList.toggle('nolabels', !on);
  pingLayer.classList.toggle('nolabels', !on);
}
function setMode(m) {
  if ((m === 'warn' || m === 'shade') && !adminOn) { toast('ADMIN MODE — TAP 🔒 TO UNLOCK', 'amber'); return; }
  mode = m;
  $$('#modeGroup .mode').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
  viewport.classList.toggle('mode-select', m === 'select');
  closePop();
  const msgs = { select: 'SELECT MODE — CLICK MARKERS, DRAG TO PAN', add: 'ADD MODE — CLICK MAP TO POSITION A CHARACTER', loc: 'LOCATION MODE — CLICK MAP TO MARK A FIXED PLACE', ping: 'PING MODE — CLICK MAP TO DROP A PING', warn: 'WARN MODE — CLICK MAP TO DROP A ⚠ WARNING PING', shade: 'SHADE MODE — CLICK MAP TO SHADE A RED ZONE' };
  if (m !== 'select' && state.maps[state.current]?.overview)
    toast('PLACEMENT DISABLED ON OVERVIEW — SELECT A SECTOR', 'amber');
  else toast(msgs[m], m === 'ping' ? 'amber' : '');
}

/* ───────── viewport interaction ───────── */
function wireViewport() {
  let pan = null;

  viewport.addEventListener('pointerdown', e => {
    if (e.target.closest('#pop, #zoomCtl, .mk, .pg, .loc')) return;
    if (e.button !== 0 && e.button !== 1) return;
    const { px, py } = evPos(e);
    pan = { px, py, tx: view.tx, ty: view.ty, moved: false };
    viewport.setPointerCapture(e.pointerId);
  });

  viewport.addEventListener('pointermove', e => {
    const { px, py } = evPos(e);
    if (pan) {
      if (!pan.moved && Math.hypot(px - pan.px, py - pan.py) > 4) { pan.moved = true; closePop(); viewport.classList.add('panning'); }
      if (pan.moved) { view.tx = pan.tx + (px - pan.px); view.ty = pan.ty + (py - pan.py); applyView(); }
    }
    if (imgNW) {
      const m = toMap(px, py);
      if (m.x >= 0 && m.y >= 0 && m.x <= imgNW && m.y <= imgNH) {
        coordsBox.classList.remove('hidden');
        $('#coordX').textContent = `X: ${Math.round(m.x)}`;
        $('#coordY').textContent = `Y: ${Math.round(m.y)}`;
      } else coordsBox.classList.add('hidden');
    }
  });

  viewport.addEventListener('pointerup', e => {
    const wasPan = pan;
    pan = null;
    viewport.classList.remove('panning');
    if (!wasPan || wasPan.moved || suppressMapClick) return;
    if (e.target.closest('#pop, #zoomCtl, .mk, .pg, .loc')) return;
    const { px, py } = evPos(e);
    const m = toMap(px, py);
    if (m.x < 0 || m.y < 0 || m.x > imgNW || m.y > imgNH) { deselect(); return; }
    // pending roster placement takes precedence
    if (pendingPlace) {
      if (state.maps[state.current]?.overview) {
        toast('OVERVIEW IS VIEW-ONLY — PLACE ON A SECTOR MAP', 'amber');
        return;
      }
      placePendingAt(m.x, m.y);
      return;
    }
    // overview is view-only — no placement of any kind
    if (state.maps[state.current]?.overview && mode !== 'select') {
      toast('OVERVIEW IS VIEW-ONLY — SELECT A SECTOR', 'amber');
      renderDrawer(); $('#mapDrawer').classList.remove('hidden');
      return;
    }
    if (mode === 'add') {
      deselect();
      openAddPop(m.x, m.y, px, py);
    } else if (mode === 'loc') {
      deselect();
      openAddLocPop(m.x, m.y, px, py);
    } else if (mode === 'ping') {
      deselect();
      const p = addPing(m.x, m.y);
      openPingPop(p, px, py);
    } else if (mode === 'warn') {
      deselect();
      const p = addPing(m.x, m.y, 'warn');
      openPingPop(p, px, py);
    } else if (mode === 'shade') {
      deselect();
      const sh = addShade(m.x, m.y);
      openShadePop(sh, px, py);
    } else {
      deselect();
    }
  });

  viewport.addEventListener('pointerleave', () => coordsBox.classList.add('hidden'));

  viewport.addEventListener('wheel', e => {
    e.preventDefault();
    const { px, py } = evPos(e);
    zoomAt(px, py, Math.exp(-e.deltaY * 0.0013));
  }, { passive: false });

  viewport.addEventListener('dblclick', e => {
    if (mode !== 'select' || e.target.closest('.mk, .pg, #pop')) return;
    const { px, py } = evPos(e);
    zoomAt(px, py, 1.6);
  });
}

/* ───────── keyboard ───────── */
function wireKeys() {
  document.addEventListener('keydown', e => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); exportSetup(); return; }
    if (typing) { if (e.key === 'Escape') document.activeElement.blur(); return; }

    switch (e.key) {
      case 'v': case 'V': setMode('select'); break;
      case 'n': case 'N': setMode('add'); break;
      case 'b': case 'B': setMode('loc'); break;
      case 'p': case 'P': setMode('ping'); break;
      case 'w': case 'W': setMode('warn'); break;
      case 's': case 'S': setMode('shade'); break;
      case 'f': case 'F': fitView(); break;
      case 'l': case 'L': toggleLabels(); break;
      case '+': case '=': zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, 1.25); break;
      case '-': case '_': zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, 0.8); break;
      case 'Delete': case 'Backspace':
        if (sel?.type === 'char') deleteChar(sel.id);
        else if (sel?.type === 'loc') deleteLoc(sel.id);
        else if (sel?.type === 'ping') deletePing(sel.id);
        else if (sel?.type === 'shade') deleteShade(sel.id);
        break;
      case 'Escape':
        if (!$('#modal').classList.contains('hidden')) $('#modal').classList.add('hidden');
        else if (!$('#mapDrawer').classList.contains('hidden')) $('#mapDrawer').classList.add('hidden');
        else if (!pop.classList.contains('hidden')) closePop();
        else if (sel) deselect();
        break;
      case '?': showHelp(); break;
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
        if (sel?.type === 'char') {
          e.preventDefault();
          const c = charIndex.get(sel.id);
          if (c) {
            if (!nudge._armed) { pushHistory(); nudge._armed = true; clearTimeout(nudge._t); nudge._t = setTimeout(() => { nudge._armed = false; persist(); toast('POSITION UPDATED'); }, 900); }
            const step = (e.shiftKey ? 40 : 10) / view.z;
            if (e.key === 'ArrowLeft') c.x -= step; if (e.key === 'ArrowRight') c.x += step;
            if (e.key === 'ArrowUp') c.y -= step; if (e.key === 'ArrowDown') c.y += step;
            const el = markerLayer.querySelector(`[data-id="${c.id}"]`);
            if (el) { el.style.left = c.x + 'px'; el.style.top = c.y + 'px'; }
          }
        }
        break;
      }
    }
  });
}
const nudge = {};

function toggleLabels() {
  state.labels = !state.labels;
  applyLabels(); persist();
  toast(state.labels ? 'LABELS SHOWN' : 'LABELS HIDDEN');
}

/* ───────── toolbar wiring ───────── */
function wireToolbar() {
  $$('#modeGroup .mode').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $$('#sideTabs .side-tab').forEach(b => b.addEventListener('click', () => setSidebarTab(b.dataset.tab)));
  setSidebarTab(localStorage.getItem(LS_KEY + ':tab') || 'pings');
  $('#btnMaps').addEventListener('click', () => { renderDrawer(); $('#mapDrawer').classList.toggle('hidden'); });
  $('#drawerClose').addEventListener('click', () => $('#mapDrawer').classList.add('hidden'));
  $('#btnUndo').addEventListener('click', undo);
  $('#btnRedo').addEventListener('click', redo);
  $('#btnLabels').addEventListener('click', toggleLabels);
  $('#btnList').addEventListener('click', () => { $('#sidebar').classList.toggle('closed'); $('#btnList').classList.toggle('active'); });
  $('#btnList').classList.add('active');
  $('#btnShot').addEventListener('click', captureView);
  $('#btnExport').addEventListener('click', exportSetup);
  $('#btnImport').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', e => { if (e.target.files[0]) importSetup(e.target.files[0]); e.target.value = ''; });
  $('#uploadMap').addEventListener('change', e => { if (e.target.files[0]) handleMapUpload(e.target.files[0]); e.target.value = ''; });
  $('#btnTheme').addEventListener('click', () => {
    state.theme = state.theme === 'light' ? 'dark' : 'light';
    applyTheme(); persist();
    toast(state.theme === 'light' ? 'LIGHT INTERFACE' : 'DARK INTERFACE');
  });
  $('#btnHelp').addEventListener('click', showHelp);
  $('#btnAdmin').addEventListener('click', openAdminPop);
  applyAdminUI();
  $('#btnClear').addEventListener('click', confirmClear);
  $('#btnHideAll').addEventListener('click', () => {
    pushHistory();
    const d = curData();
    d.characters.forEach(c => c.hidden = true);
    d.locations.forEach(l => l.hidden = true);
    d.pings.forEach(p => p.hidden = true);
    (d.shades || []).forEach(x => x.hidden = true);
    persist(); renderAll(); toast('EVERYTHING HIDDEN');
  });
  $('#btnShowAll').addEventListener('click', () => {
    pushHistory();
    const d = curData();
    d.characters.forEach(c => c.hidden = false);
    d.locations.forEach(l => l.hidden = false);
    d.pings.forEach(p => p.hidden = false);
    (d.shades || []).forEach(x => x.hidden = false);
    persist(); renderAll(); toast('EVERYTHING VISIBLE');
  });

  // zoom cluster
  $('#zIn').addEventListener('click', () => zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, 1.3));
  $('#zOut').addEventListener('click', () => zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, 0.77));
  $('#zFit').addEventListener('click', () => fitView());
  $('#zLevel').addEventListener('click', () => {
    const cx = viewport.clientWidth / 2, cy = viewport.clientHeight / 2;
    const m = toMap(cx, cy);
    animateView({ z: 1, tx: cx - m.x, ty: cy - m.y });
  });
  $('#zFull').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  });

  // search
  $('#searchInput').addEventListener('input', debounce(() => { renderSidebar(); renderMarkers(); }, 160));
  $('#searchInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const first = $('#charList .char-row');
      if (first) first.click();
    }
    e.stopPropagation();
  });

  // close drawer on outside click
  document.addEventListener('pointerdown', e => {
    const dr = $('#mapDrawer');
    if (!dr.classList.contains('hidden') && !e.target.closest('#mapDrawer, #btnMaps')) dr.classList.add('hidden');
  });

  window.addEventListener('resize', () => { updateTiles(); /* keep proportional; nothing else needed, view is anchored */ });
  window.addEventListener('beforeunload', () => persistNow());
}

/* ───────── live-sync hooks (exposed to sync.js) ───────── */
window.AppHooks = {
  get state() { return state; },
  toast,
  refreshAll() { renderAll(); updateStatus(); },
  applyRemote(touchedMaps, touched) {
    // refresh UI for entities changed by other clients
    renderAll(); updateStatus();
    persistNowLocal();
  },
};
// persist to LocalStorage WITHOUT triggering an outgoing sync push
function persistNowLocal() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch {}
}

/* near-live position updates while dragging a marker/ping */
let dragSyncTimer = 0;
function liveDragTick() {
  const now = Date.now();
  if (now - dragSyncTimer > 180) {
    dragSyncTimer = now;
    persistNow();            // local cache (no debounce)
    window.AppSync?.noteChange();
  }
}

/* ───────── live panel ───────── */
function wireLivePanel() {
  const btn = $('#btnLive'), panel = $('#liveModal');
  if (!btn || !panel) return;
  const open = () => {
    panel.classList.remove('hidden');
    $('#liveBoard').value = window.AppSync?.boardId?.() || 'public';
    $('#liveName').value = window.AppSync?.operatorName?.() || '';
    const isBuiltin = window.AppSync?.usingBuiltin?.();
    $('#liveConfig').value = isBuiltin ? '' : JSON.stringify(window.AppSync.cfg(), null, 2);
    $('#liveConfig').placeholder = isBuiltin
      ? 'BLANK = PRECONFIGURED LIVE SYNC — works out of the box. Paste your own Firebase config only if you want a private database.'
      : 'Firebase config override is active';
    updateLivePanelStatus();
  };
  const close = () => panel.classList.add('hidden');
  btn.addEventListener('click', open);
  $('#liveClose').addEventListener('click', close);
  panel.querySelector('.modal-veil').addEventListener('click', close);

  $('#liveConnect').addEventListener('click', async () => {
    const board = $('#liveBoard').value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'public';
    $('#liveBoard').value = board;
    const name = $('#liveName').value.trim().slice(0, 24);
    if (name) window.AppSync.setOperatorName(name);
    const raw = $('#liveConfig').value.trim();
    if (raw) {
      let parsed = null;
      try {
        const js = raw.replace(/^\s*(const|let|var)\s+\w+\s*=\s*/, '').replace(/;+\s*$/, '');
        parsed = JSON.parse(js);
      } catch { toast('CONFIG IS NOT VALID JSON', 'red'); return; }
      if (!parsed.databaseURL && !parsed.projectId) { toast('CONFIG MISSING databaseURL / projectId', 'red'); return; }
      window.AppSync.saveCfg(parsed, board);
      toast('USING CUSTOM FIREBASE PROJECT', 'amber');
    } else {
      window.AppSync.saveCfg(null, board);   // preconfigured live sync
    }
    if (window.AppSync.isConnected()) window.AppSync.disconnect();
    const r = await window.AppSync.connect(null, board);
    updateLivePanelStatus();
    if (r.ok) toast(`LIVE — EVERYONE ON “${board.toUpperCase()}” SEES EVERYTHING`, 'green');
  });
  $('#liveDisconnect').addEventListener('click', () => { window.AppSync.disconnect(); updateLivePanelStatus(); });
  $('#liveForget').addEventListener('click', () => {
    window.AppSync.disconnect(); window.AppSync.saveCfg(null);
    $('#liveConfig').value = ''; updateLivePanelStatus();
    toast('BACK TO PRECONFIGURED SYNC', 'green');
  });
}
function updateLivePanelStatus() {
  const el = $('#liveStatus');
  if (!el) return;
  const S = window.AppSync;
  const on = S?.isConnected?.();
  const peers = S?.peerCount?.() || 0;
  el.innerHTML = on
    ? `<span class="live-pill on">● LIVE</span> board <b>“${S.boardId()}”</b> — ${peers} operator${peers === 1 ? '' : 's'} online. Changes appear on every screen in ~1 second.`
    : `<span class="live-pill cfg">● READY</span> live sync is built-in — just pick a board code and press <b>CONNECT ▸ GO LIVE</b>.`;
}

/* ───────── init ───────── */
function init() {
  state = loadState();
  try { adminOn = localStorage.getItem(ADMIN_KEY) === '1'; } catch (e) { }
  ensureBuiltins();
  runMapMigrations();
  migrateRosebridgeSectors();
  applyTheme();
  wireViewport();
  wireToolbar();
  wireKeys();
  setMode('add');
  updateUndoButtons();
  switchMap(state.current, { silent: true, skipViewSave: true });
  if (!state.hintDone) hint.classList.remove('hidden');
  applyLabels();
  setSync(false);
  persist();
  wireLivePanel();
  // auto-connect live sync on boot (preconfigured; silent offline retry)
  const tryBoot = (attempts = 0) => {
    if (!window.AppSync) return;
    window.AppSync.connect(null, null, { quiet: true }).then(r => {
      if (!r.ok && attempts < 2) setTimeout(() => tryBoot(attempts + 1), 2500);
      else if (r.ok && attempts === 0) toast(`LIVE SYNC ACTIVE — BOARD “${window.AppSync.boardId().toUpperCase()}”`, 'green');
    });
  };
  setTimeout(tryBoot, 800);

  // dismiss loading screen after the first painted frame
  const dismissLoader = () => {
    const ld = $('#loader');
    if (!ld || ld.classList.contains('done')) return;
    ld.classList.add('done');
    setTimeout(() => ld.remove(), 700);
  };
  window.addEventListener('error', dismissLoader);
  setTimeout(dismissLoader, 950);
}
init();
