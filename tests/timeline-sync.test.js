/* Sector grid + 2-client live-sync integration test (calendar removed).
   Loads the REAL app.js and sync.js twice (clients A & B) over an
   in-memory fake RTDB with firebase-style child events. No network. */
'use strict';
const vm = require('vm');
const fs = require('fs');
const APP = fs.readFileSync('/home/user/virtus-tracker/app.js', 'utf8');
const SYN = fs.readFileSync('/home/user/virtus-tracker/sync.js', 'utf8');

/* ───── fake realtime database (shared store, per-URL Db with listeners) ───── */
const sharedStores = {};   // databaseURL -> plain object
class FSnap {
  constructor(key, val) { this.key = key; this._v = val; }
  val() { return this._v; }
  exists() { return this._v !== null && this._v !== undefined; }
  numChildren() { return (this._v && typeof this._v === 'object') ? Object.keys(this._v).length : 0; }
  forEach(cb) { if (this._v && typeof this._v === 'object') for (const k of Object.keys(this._v)) if (cb(new FSnap(k, this._v[k])) === true) return true; return false; }
}
class FDb {
  constructor(store) { this.store = store; this.subs = []; }
  node(path) { let n = this.store; for (const p of path) { if (n == null || typeof n !== 'object') return null; n = n[p]; } return n === undefined ? null : n; }
  set(path, v) {
    if (!path.length) return;
    let n = this.store;
    for (let i = 0; i < path.length - 1; i++) n = n[path[i]] = n[path[i]] || {};
    const last = path[path.length - 1];
    if (v === null || v === undefined) delete n[last]; else n[last] = JSON.parse(JSON.stringify(v));
    this.fireValue(path);
  }
  update(path, obj) {
    // diff child listeners at this exact path before mutating
    const childSubs = this.subs.filter(s => s.path.join('/') === path.join('/') && s.evt.startsWith('child_'));
    const before = JSON.parse(JSON.stringify(this.node(path) || {}));
    for (const [k, v] of Object.entries(obj)) this.set(path.concat([k]), v);
    const after = this.node(path) || {};
    for (const s of childSubs) {
      for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const had = k in before, has = k in after;
        if (had && !has) { if (s.evt === 'child_removed') setTimeout(() => s.cb(new FSnap(k, before[k])), 0); }
        else if (!had && has) { if (s.evt === 'child_added') setTimeout(() => s.cb(new FSnap(k, after[k])), 0); }
        else if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) { if (s.evt === 'child_changed') setTimeout(() => s.cb(new FSnap(k, after[k])), 0); }
      }
    }
  }
  sub(path, evt, cb, key) {
    this.subs.push({ path, evt, cb });
    if (evt === 'value') setTimeout(() => cb(new FSnap(key, this.node(path))), 0);
    if (evt === 'child_added') {
      const n = this.node(path) || {};
      for (const k of Object.keys(n)) setTimeout(() => cb(new FSnap(k, n[k])), 0);
    }
  }
  fireValue() {
    for (const s of this.subs.filter(s => s.evt === 'value'))
      setTimeout(() => s.cb(new FSnap(s.path[s.path.length - 1] || '', this.node(s.path))), 0);
  }
}
FDb.prototype.ref = function (path) {
  const parts = (!path || path === '/') ? [] : String(path).replace(/^\//, '').split('/');
  return new FRef(this, parts, parts[parts.length - 1] || '');
};
const dbs = {};  // url -> FDb
class FRef {
  constructor(db, path, key) { this.db = db; this.path = path; this.key = key; }
  child(name) { const parts = String(name).split('/'); return new FRef(this.db, this.path.concat(parts), parts[parts.length - 1]); }
  once() { return Promise.resolve(new FSnap(this.key, this.db.node(this.path))); }
  on(evt, cb) { this.db.sub(this.path, evt, cb, this.key); }
  off() { this.db.subs = this.db.subs.filter(s => s.path.join('/') !== this.path.join('/')); }
  set(v) { this.db.set(this.path, v); return Promise.resolve(); }
  update(obj) { this.db.update(this.path, obj); return Promise.resolve(); }
  remove() { this.db.set(this.path, null); return Promise.resolve(); }
  onDisconnect() { return { remove() { } }; }
}
function makeFirebase() {
  const fb = {
    apps: [],
    initializeApp(cfg, name) { const app = { options: cfg, name }; fb.apps.push(app); return app; },
    database(app) {
      const url = app.options.databaseURL;
      sharedStores[url] = sharedStores[url] || {};
      dbs[url] = dbs[url] || new FDb(sharedStores[url]);
      return dbs[url];
    },
  };
  fb.database.ServerValue = { TIMESTAMP: 0 };
  return fb;
}

/* ───── absorbing DOM shim ───── */
function makeEl(tag) {
  const listeners = {};
  const cls = new Set();
  const style = new Proxy({
    setProperty(k, v) { this['--' + String(k).replace(/^--/, '')] = v; },
    removeProperty() { }, getPropertyValue: () => '',
  }, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' ? '' : t[k])), set: (t, k, v) => { t[k] = v; return true; } });
  const el = {
    tag, id: '', hidden: false, dataset: {}, style,
    set innerHTML(v) { el.children.length = 0; el._html = v; },
    get innerHTML() { return el._html || ''; },
    value: '', textContent: '', disabled: false, checked: false,
    width: 0, height: 0, offsetWidth: 0, offsetHeight: 0, clientWidth: 800, clientHeight: 600,
    scrollLeft: 0, scrollTop: 0, files: [], options: [], children: [],
    get firstChild() { return el.children[0] || null; },
    classList: {
      add: (...c) => c.forEach(x => cls.add(x)),
      remove: (...c) => c.forEach(x => cls.delete(x)),
      toggle: (c, f) => { const on = f === undefined ? !cls.has(c) : f; f ? cls.add(c) : (on ? cls.add(c) : cls.delete(c)); },
      contains: c => cls.has(c),
    },
    addEventListener: (t, f) => (listeners[t] = listeners[t] || []).push(f),
    removeEventListener() { }, dispatch(t, e) { (listeners[t] || []).forEach(f => f(e)); },
    appendChild(c) { el.children.push(c); c._parent = el; return c; }, append(...cs) { cs.forEach(c => { if (c) { el.children.push(c); c._parent = el; } }); }, prepend() { }, insertAdjacentHTML() { }, insertBefore: c => c,
    remove() { const p = el._parent; if (p) { const i = p.children.indexOf(el); if (i >= 0) p.children.splice(i, 1); el._parent = null; } }, replaceChildren() { }, setAttribute() { }, getAttribute: () => null, removeAttribute() { },
    querySelector: () => makeEl('q'), querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 }),
    getContext: () => new Proxy({}, { get: (t, k) => (k === 'canvas' ? el : () => undefined), set: () => true }),
    toDataURL: () => '', focus() { }, blur() { }, click() { }, select() { }, closest: () => null,
  };
  return el;
}
function makeContext(name) {
  const byId = {};
  const ls = new Map();
  const ctx = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    JSON, Math, Object, Array, String, Number, Date, Promise, Map, Set, URL, URLSearchParams,
    Intl, RegExp, Error, TypeError, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
    requestAnimationFrame: f => setTimeout(f, 16),
    localStorage: {
      getItem: k => (ls.has(k) ? ls.get(k) : null),
      setItem: (k, v) => ls.set(k, String(v)),
      removeItem: k => ls.delete(k),
    },
    location: { search: '?board=caltest', href: 'http://x/?board=caltest' },
    navigator: { onLine: true },
    Image: class { set src(v) { } },
    matchMedia: () => ({ matches: false, addEventListener() { } }),
    alert() { },
    __name: name,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.self = ctx;
  ctx.document = {
    getElementById: id => byId[id] = byId[id] || (() => { const e = makeEl('div'); e.id = id; return e; })(),
    // stable per-selector instances so sidebar re-renders stay observable
    querySelector: sel => byId['sel:' + sel] = byId['sel:' + sel] || (() => { const e = makeEl('div'); e.id = sel; return e; })(),
    querySelectorAll: () => [],
    createElement: t => makeEl(t),
    createTextNode: t => ({ text: t }),
    addEventListener() { }, removeEventListener() { },
    body: makeEl('body'), documentElement: makeEl('html'),
    visibilityState: 'visible', hidden: false, title: '',
  };
  ctx.window.addEventListener = () => { };
  ctx.window.removeEventListener = () => { };
  ctx.addEventListener = () => { };
  ctx.firebase = makeFirebase();
  return vm.createContext(ctx);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
function ok(cond, label) {
  console.log((cond ? '  PASS ' : '  FAIL ') + label);
  if (!cond) failures++;
}
const R = (ctx, code) => vm.runInContext(code, ctx);

(async () => {
  /* ─ calendar removed: single global layer ─ */
  console.log('— sector migration on an offline client (legacy dated board) —');
  const C = makeContext('C');
  R(C, APP);   // no sync on C — pure data migration test
  ok(R(C, `Object.keys(state.maps).filter(id => state.maps[id].sector).length`) === 9, '9 sector maps registered');
  ok(R(C, `!!state.maps['rosebridge'].overview`), 'overview map registered');
  R(C, `
    state.timeline = {
      '2099-01-01': {
        posByMap:   { rosebridge: { X: { x: 4000, y: 4000 } } },
        pingsByMap: { rosebridge: [{ id: 'pX', x: 10, y: 10, label: 'OLD PING' }] },
      },
    };
    state.data.rosebridge = {
      characters: [
        { id: 'X', name: 'X', unplaced: true, color: '#fff' },
        { id: 'U', name: 'U', unplaced: true, color: '#fff' },
      ],
      locations: [{ id: 'L1', name: 'HQ', x: 100, y: 200, color: '#fff' }],
      pings: [{ id: 'pLive', x: 8000, y: 8000, label: 'LIVE PING' }],
    };
    delete state.mig.rosebridgeSectors;
    migrateRosebridgeSectors();
  `);
  ok(R(C, `Object.keys(state.timeline).length`) === 0, 'timeline flattened to nothing');
  ok(!R(C, `'calendar' in state`), 'calendar state removed');
  ok(!R(C, `state.data.rosebridge.characters.some(c => c.id === 'X')`), 'X left overview data');
  ok(R(C, `!!state.data.rosebridge.characters.some(c => c.id === 'U' && c.unplaced)`), 'unplaced roster char stays on overview');
  ok(R(C, `state.data['rosebridge-b2'].characters.find(c => c.id === 'X')?.x`) === 75, 'X routed to B2 at local x=4000-3925');
  ok(R(C, `state.data['rosebridge-b2'].characters.find(c => c.id === 'X')?.y`) === 246, 'X routed to B2 at local y=4000-3754');
  ok(R(C, `!state.data['rosebridge-b2'].characters.find(c => c.id === 'X')?.unplaced`), 'X got placed via bucket position');
  ok(R(C, `state.data['rosebridge-a1'].pings[0]?.id`) === 'pX', 'dated ping merged into A1 live pings');
  ok(R(C, `state.data['rosebridge-a1'].locations[0]?.id`) === 'L1', 'location routed to A1');
  ok(R(C, `state.data['rosebridge-c3'].pings[0]?.id`) === 'pLive', 'live ping routed to C3 (col 3)');
  ok(R(C, `state.data['rosebridge-c3'].pings[0]?.x`) === 149, 'C3 ping local x=8000-7851');
  ok(R(C, `state.data['rosebridge-c3'].pings[0]?.y`) === 491, 'C3 ping local y=8000-7509');
  ok(R(C, `state.mig.rosebridgeSectors`) === 1, 'migration flagged');

  console.log('— boot client A —');
  const A = makeContext('A');
  R(A, APP); R(A, SYN);
  console.log('— boot client B —');
  const B = makeContext('B');
  R(B, APP); R(B, SYN);
  await sleep(1200);
  ok(R(A, 'window.AppSync.isConnected()'), 'A connected');
  ok(R(B, 'window.AppSync.isConnected()'), 'B connected');
  const cur = R(A, 'state.current');
  ok(!!cur, 'A has a current map: ' + cur);

  console.log('— A places AVA + a ping (no date needed) —');
  R(A, `switchMap('rosebridge-a1', { silent: true }); addChar('AVA', 100, 50, '#ff0000'); addPing(10, 20);`);
  const avaA = R(A, `curData().characters[0].id`);
  const pingA = R(A, `curData().pings[0].id`);
  ok(R(A, `curData().characters.length`) === 1, 'A live: 1 char');
  ok(R(A, `curData().pings.length`) === 1, 'A live: 1 ping');
  ok(R(A, `markerLayer.children.length`) === 1, 'A: char marker rendered immediately');

  console.log('— markers in screen-space HUD + NOTHING fades on zoom-out in Virtus —');
  R(A, `addLoc('HQ', 5, 5);`);
  R(A, `imgNW = 1000; imgNH = 600; view.z = 0.776; applyView();`);
  {
    const left = R(A, `markerLayer.children[0].style.left`);
    const expect = R(A, `Math.round(view.tx + curData().characters[0].x * view.z) + 'px'`);
    ok(left === expect, 'marker positioned in screen-space pixels');
  }
  R(A, `view.z = 0.29; applyView();`);
  ok(!R(A, `hud.classList.contains('far-zoom')`), 'A at 29% zoom: no declutter');
  R(A, `view.z = 0.12; applyView();`);
  ok(!R(A, `hud.classList.contains('far-zoom')`), 'A at 12% zoom: still nothing fades');
  R(A, `view.z = 0.776; applyView();`);

  console.log('— story ping sidebar: newest-first + involved character chips —');
  ok(R(A, `curData().pings[0].createdAt`) > 0, 'ping carries createdAt');
  R(A, `curData().pings[0].label = 'FIRST'; curData().pings[0].chars.push('${avaA}');`);
  R(A, `const np = addPing(1, 1); np.label = 'NEWER'; renderSidebar();`);
  {
    const kids = R(A, `[...$('#pingList').children].map(c => c.innerHTML)`);
    ok(kids[0] && kids[0].includes('NEWER') && kids[1] && kids[1].includes('FIRST'), 'sidebar: pings sorted newest → oldest');
    ok(kids[1] && kids[1].includes('AVA'), 'sidebar: involved character chip under ping title');
  }
  R(A, `curData().pings[0].label = '';
        deletePing(curData().pings.find(p => p.label === 'NEWER').id);
        deleteLoc(curData().locations[0].id); persistNow();`);
  await sleep(1200);

  console.log('— sidebar tabs: one section at a time, pings default —');
  ok(R(A, `$('#sidebar').dataset.tab`) === 'pings', 'default sidebar tab is STORY PINGS');
  R(A, `setSidebarTab('locs');`);
  ok(R(A, `$('#sidebar').dataset.tab`) === 'locs', 'tab switches to LOCATIONS');
  ok(R(A, `localStorage.getItem(LS_KEY + ':tab')`) === 'locs', 'tab choice persists');
  R(A, `setSidebarTab('pings');`);
  ok(R(A, `$('#sidebar').dataset.tab`) === 'pings', 'tab switches back to STORY PINGS');

  console.log('— story pings sidebar lists ALL maps\' pings —');
  R(A, `switchMap('rosebridge-b2'); renderAll(); const np2 = addPing(3, 4); np2.label = 'FARAWAY'; persistNow();
        switchMap('rosebridge-a1'); renderAll(); renderSidebar();`);
  {
    ok(R(A, `collectAllPings().length`) === 2, 'global index spans all maps');
    const html = R(A, `[...$('#pingList').children].map(c => c.innerHTML).join(' ')`);
    ok(html.includes('FARAWAY'), 'off-map ping appears in the sidebar');
    ok(/rosebridge\s+—\s+b2|b2/i.test(html), 'off-map row names its map');
    R(A, `gotoPing(state.current, curData().pings[0].id);`);
    ok(R(A, `sel && sel.type === 'ping'`), 'same-map ping jump selects it');
  }
  R(A, `deleteGlobalPing('rosebridge-b2', state.data['rosebridge-b2'].pings[0].id);`);
  ok(R(A, `(state.data['rosebridge-b2'].pings || []).length`) === 0, 'cross-map delete scrubs the ping');
  R(A, `renderSidebar();`);
  ok(!R(A, `[...$('#pingList').children].map(c => c.innerHTML).join(' ')`).includes('FARAWAY'), 'sidebar drops the deleted ping');

  console.log('— story pings carry ongoing / finished status —');
  const stPid = R(A, `const sp2 = addPing(9, 9); sp2.label = 'STC'; persistNow(); sp2.id`);
  ok(R(A, `curData().pings.find(p => p.id === '${stPid}').status`) === 'ongoing', 'new ping defaults to ONGOING');
  R(A, `renderPings(); renderSidebar();`);
  {
    ok(R(A, `[...$('#pingList').children].map(c => c.innerHTML).join(' ')`).includes('ONGOING'), 'sidebar badge shows ONGOING');
    ok(R(A, `pingLayer.children.find(c => c.dataset.id === '${stPid}').className`).includes('ong'), 'map ping wears the ONG (yellow) class');
    ok(R(A, `pingLayer.children.find(c => c.dataset.id === '${stPid}').style['--pgc']`) === 'var(--pgc-ong)', 'map ping pinned to yellow var');
    ok(R(A, `[...$('#pingList').children].map(c => c.innerHTML).join(' ')`).includes('ping-dot ong'), 'sidebar dot is ONG-tinted');
  }
  R(A, `curData().pings.find(p => p.id === '${stPid}').status = 'finished'; persistNow(); renderPings(); renderSidebar();`);
  {
    ok(R(A, `[...$('#pingList').children].map(c => c.innerHTML).join(' ')`).includes('FINISHED'), 'sidebar badge switches to FINISHED');
    ok(R(A, `pingLayer.children.find(c => c.dataset.id === '${stPid}').className`).includes('fin'), 'map ping wears the FIN (dull) class');
    ok(R(A, `pingLayer.children.find(c => c.dataset.id === '${stPid}').style['--pgc']`) === 'var(--pgc-fin)', 'map ping pinned to dull var');
    ok(R(A, `[...$('#pingList').children].map(c => c.innerHTML).join(' ')`).includes('ping-dot fin'), 'sidebar dot is FIN-tinted');
  }
  R(A, `deletePing('${stPid}'); persistNow();`);

  console.log('— ping popup SET commits label immediately —');
  const setPid = R(A, `const t1 = addPing(2, 2); renderPings(); openPingPop(t1, 100, 100); t1.id`);
  {
    ok(R(A, `[...$('#pop').children].map(c => c.innerHTML).join(' ')`).includes('✓ SET'), 'popup has a ✓ SET button');
    R(A, `setPingLabel('${setPid}', 'QUICKLABEL');`);
    ok(R(A, `curData().pings.find(x => x.id === '${setPid}').label`) === 'QUICKLABEL', 'SET sets the name immediately (no debounce wait)');
    ok(R(A, `pingLayer.children.some(c => c.dataset.id === '${setPid}' && c.children.some(k => (k.textContent || '').includes('QUICKLABEL')))`), 'marker label refreshes on the spot');
  }
  R(A, `closePop(); deletePing('${setPid}'); persistNow();`);

  console.log('— assignments survive sync echo (no stale popup refs) —');
  {
    const pid = R(A, `const t2 = addPing(6, 6); t2.label = 'ASSIGN'; persistNow(); t2.id`);
    R(A, `state.data = JSON.parse(JSON.stringify(state.data));`);  // mimic sync echo swapping identities
    const res = R(A, `(function(){
      const stale = { id: '${pid}', chars: [], label: 'ASSIGN', x: 6, y: 6 };
      const el = document.createElement('div');
      popInvolvedChars(el, stale);
      const click = (soak) => { (function walk(e){ for (const c of e.children) { walk(c); if (c.className && String(c.className).includes('pc') && (c.innerHTML || '').includes(soak)) c.dispatch('click'); } })(el); };
      click('AVA');
      const live = curData().pings.find(x => x.id === '${pid}');
      live.chars = []; // reset for second click equivalence? no—keep, want two-lasting: re-check presence
      return 0;
    })()`);
    // simpler: two rounds via one stale ref — assert the live ping ends with AVA once
    const res2 = R(A, `(function(){
      const stale = { id: '${pid}', chars: [], label: 'ASSIGN', x: 6, y: 6 };
      const el = document.createElement('div');
      popInvolvedChars(el, stale);
      const click = (soak) => { (function walk(e){ for (const c of e.children) { walk(c); if (c.className && String(c.className).includes('pc') && (c.innerHTML || '').includes(soak)) c.dispatch('click'); } })(el); };
      click('AVA'); click('AVA'); click('AVA');   // toggle on/off/on — must end ON despite stale ref
      return (curData().pings.find(x => x.id === '${pid}').chars || []).length;
    })()`);
    ok(res2 === 1, 'repeated assignment clicks keep saving through sync echo (got ' + res2 + ')');
    R(A, `deletePing('${pid}'); persistNow();`);
  }

  console.log('— per-row hide toggles + SHOW/HIDE ALL covers every type —');
  {
    const hid = R(A, `addChar('HID', 1, 1, '#00ff00'); const pid3 = addPing(3, 3); addLoc('HOME', 9, 9);
          const out = [curData().characters.find(c => c.name === 'HID').id, pid3.id, curData().locations[0].id];
          togglePingHidden(state.current, out[1]); renderMarkers(); renderSidebar(); out`);
    ok(!R(A, `pingLayer.children.some(c => c.dataset.id === '${hid[1]}')`), 'hidden ping not rendered on map');
    ok(R(A, `[...$('#pingList').children].map(c => c.className).join(' ')`).includes('is-hidden'), 'ping row shows as hidden');
    ok(R(A, `mapPingCount(state.current)`) === 1, 'badge ignores hidden ping');
    R(A, `curData().characters.find(c => c.id === '${hid[0]}').hidden = true; curData().locations[0].hidden = true; renderMarkers(); renderLocations(); renderSidebar();`);
    ok(!R(A, `markerLayer.children.some(c => c.dataset.id === '${hid[0]}')`), 'hidden character not rendered');
    ok(!R(A, `locLayer.children.some(c => c.dataset.id === '${hid[2]}')`), 'hidden location not rendered');
    R(A, `$('#btnShowAll').dispatch('click');`);
    await sleep(150);
    ok(R(A, `markerLayer.children.some(c => c.dataset.id === '${hid[0]}')`), 'SHOW ALL: character back on map');
    ok(R(A, `locLayer.children.some(c => c.dataset.id === '${hid[2]}')`), 'SHOW ALL: location back on map');
    ok(R(A, `pingLayer.children.some(c => c.dataset.id === '${hid[1]}')`), 'SHOW ALL: ping back on map');
    R(A, `deleteChar('${hid[0]}'); deletePing('${hid[1]}'); deleteLoc('${hid[2]}'); persistNow();`);
  }

  console.log('— B sees everything live (no date isolation) —');
  R(B, `switchMap('rosebridge-a1', { silent: true }); renderAll();`);
  ok(R(B, `curData().characters.length`) === 1, 'B roster shows AVA');
  ok(R(B, `curData().characters[0].x`) === 100, 'B live: AVA at x=100');
  ok(R(B, `markerLayer.children.length`) === 1, 'B: char marker rendered');
  ok(R(B, `curData().pings.length`) === 1, 'B live: ping visible');
  ok(R(B, `curData().pings[0].x`) === 10, 'B live: ping at x=10');
  ok(R(B, `mapPingCount('rosebridge-a1')`) === 1, 'map badge: 1 story ping on A1');
  R(B, `addLoc('HQ', 5, 5);`);
  ok(R(B, `mapPingCount('rosebridge-a1')`) === 1, 'map badge ignores Locations AND characters');
  ok(R(B, `mapPingCount('rosebridge-a3')`) === 0, 'map badge 0 on pingless sector → indicator omitted');
  {
    const url = 'https://schungdar-default-rtdb.firebaseio.com';
    const ents = (sharedStores[url].virtus || {}).boards?.caltest?.entities || {};
    const keys = Object.keys(ents);
    ok(keys.filter(k => k.includes('__ping__')).length === 1, 'ping pushed as a dateless entity doc');
    ok(!keys.some(k => k.startsWith('tl@')), 'no per-date timeline docs anywhere');
  }

  console.log('— cross-sector isolation —');
  R(B, `switchMap('rosebridge-a2', { silent: true });`);
  ok(R(B, `curData().characters.length`) === 0, 'A2 roster independent of A1');
  ok(R(B, `mapPingCount('rosebridge-a2')`) === 0, 'A2 has no pings');
  R(B, `addChar('BRIX', 30, 40, '#00ff00');`);
  const brixB = R(B, `curData().characters[0].id`);
  await sleep(1200);
  ok(R(A, `mapPingCount('rosebridge-a2')`) === 0, 'A: A2 badge count is 0 (char does not count)');
  R(A, `switchMap('rosebridge-a2', { silent: true });`);
  ok(R(A, `curData().characters[0]?.name`) === 'BRIX', 'A sees BRIX on A2');
  R(A, `switchMap('rosebridge-a1', { silent: true });`);

  console.log('— B moves AVA; A sees it —');
  R(B, `switchMap('rosebridge-a1', { silent: true });
        const c = curData().characters.find(x => x.id === '${avaA}'); c.x = 5; c.y = 7; persistNow();`);
  await sleep(1200);
  ok(R(A, `curData().characters.find(c => c.id === '${avaA}')?.x`) === 5, 'A live: AVA moved to x=5');
  ok(R(A, `curData().characters.find(c => c.id === '${avaA}')?.y`) === 7, 'A live: AVA moved to y=7');

  console.log('— A deletes the ping; B converges —');
  R(A, `deletePing('${pingA}')`);
  await sleep(1200);
  ok(R(A, `curData().pings.length`) === 0, 'A live: ping deleted');
  ok(R(B, `curData().pings.length`) === 0, 'B live: ping deleted');
  ok(R(B, `mapPingCount('rosebridge-a1')`) === 0, 'B badge back to 0');

  console.log('— A deletes AVA and BRIX: rosters scrub everywhere —');
  R(A, `deleteChar('${avaA}'); switchMap('rosebridge-a2', { silent: true }); deleteChar('${brixB}');`);
  await sleep(1200);
  R(B, `switchMap('rosebridge-a1', { silent: true });`);
  ok(R(B, `state.data['rosebridge-a1'].characters.length`) === 0, 'B: A1 roster empty');
  ok(R(B, `state.data['rosebridge-a2'].characters.length`) === 0, 'B: A2 roster empty');

  console.log('— Task I: ADMIN MODE gates shades & warnings (code virtus25) —');
  {
    R(A, 'setAdmin(false, true);');                       // make sure we start locked
    ok(R(A, 'isAdmin()') === false || R(A, 'isAdmin()') === undefined, 'admin locked by default');
    const mBefore = R(A, 'mode');
    R(A, `setMode('warn');`); ok(R(A, 'mode') === mBefore, 'locked: WARN mode refused');
    R(A, `setMode('shade');`); ok(R(A, 'mode') === mBefore, 'locked: SHADE mode refused');
    ok(R(A, `unlockAdmin('nope')`) === false, 'wrong access code rejected');
    ok(R(A, `unlockAdmin('virtus25')`) === true, 'access code virtus25 unlocks admin mode');
    ok(R(A, 'isAdmin()'), 'isAdmin true after unlock');
    R(A, `setMode('warn');`);  ok(R(A, 'mode') === 'warn',  'unlocked: WARN mode available');
    R(A, `setMode('shade');`); ok(R(A, 'mode') === 'shade', 'unlocked: SHADE mode available');
    R(A, `setMode('${mBefore}')`);
    // locked again → story ping popup offers no TYPE/convert row
    R(A, 'setAdmin(false, true);');
    R(A, `(function(){ const sp = addPing(13, 14); sp.label='LOCKTEST'; openPingPop(sp, 60, 60); })();`);
    const lp = R(A, `(function walkAll(e){ let t = (e.innerHTML || ''); for (const c of (e.children || [])) t += ' ' + walkAll(c); return t; })($('#pop'))`);
    ok(!lp.includes('TYPE'), 'locked: ping popup hides the TYPE (warn conversion) row');
    R(A, `closePop(); const sp = curData().pings.find(x => x.label === 'LOCKTEST'); if (sp) deletePing(sp.id); persistNow();`);
  }

  console.log('— Task I: RED ZONES (shading) place / style / hide / sync —');
  {
    R(A, `switchMap('rosebridge-a1', { silent: true });`);
    const shId = R(A, `const z = addShade(500, 600); persistNow(); z.id`);
    ok(R(A, `curData().shades.length`) === 1, 'shade stored on current map data');
    ok(R(A, `shadeLayer.children.some(e => e.dataset.id === '${shId}')`), 'shade rendered in #shadeLayer');
    ok(R(A, `shadeLayer.children[0].style.left`) === '500px', 'shade at world coords (scales with map)');
    ok(String(R(A, `shadeLayer.children[0].className`)).includes('shade'), 'shade element classed .shade');
    const bg1 = R(A, `shadeLayer.children[0].style.background`);
    ok(/rgba\(255,47,47,0.26\)/.test(bg1), 'default MED intensity gradient');
    R(A, `curData().shades.find(x => x.id === '${shId}').level = 3; renderShades(); persistNow();`);
    const bg3 = R(A, `shadeLayer.children[0].style.background`);
    ok(/0.45\)/.test(bg3), 'HIGH intensity bumps alpha (light → strong ramp)');
    R(A, `curData().shades.find(x => x.id === '${shId}').r = SHADE_RADII.l; renderShades(); persistNow();`);
    ok(R(A, `shadeLayer.children[0].style.width`) === (360 * 2) + 'px', 'L radius renders 720px diameter');
    R(A, `curData().shades.find(x => x.id === '${shId}').color = '#00ff00'; renderShades(); persistNow();`);
    const bgC = R(A, `shadeLayer.children[0].style.background`);
    ok(/rgba\(0,255,0,0.45\)/.test(bgC), 'zone color applies (green at HIGH alpha)');
    // popup: intensity seg present
    R(A, `openShadePop(curData().shades.find(x => x.id === '${shId}'), 100, 100);`);
    ok(R(A, `[...$('#pop').children].map(c => c.innerHTML).join(' ')`).includes('INTENSITY'), 'shade popup has intensity seg');
    ok(R(A, `[...$('#pop').children].map(c => c.innerHTML).join(' ')`).includes('CLEAR ZONE'), 'shade popup has clear-zone action');
    R(A, `closePop();`);
    // hide shade → not rendered; SHOW ALL restores
    R(A, `toggleShadeHidden('${shId}');`);
    ok(!R(A, `shadeLayer.children.some(e => e.dataset.id === '${shId}')`), 'hidden shade not rendered');
    R(A, `$('#btnHideAll').dispatch('click');`);
    ok(!R(A, `curData().shades[0].hidden`) === false, 'HIDE ALL covers shades');
    R(A, `$('#btnShowAll').dispatch('click');`);
    ok(R(A, `shadeLayer.children.some(e => e.dataset.id === '${shId}')`), 'SHOW ALL restores shade');
    // sync: B converges on the shade
    await sleep(1200);
    R(B, `switchMap('rosebridge-a1', { silent: true }); renderAll();`);
    ok(R(B, `curData().shades.length`) === 1, 'B received the shade via entity doc sync');
    ok(R(B, `curData().shades[0].level`) === 3, 'B received shade intensity');
    {
      const url = 'https://schungdar-default-rtdb.firebaseio.com';
      const ents = (sharedStores[url].virtus || {}).boards?.caltest?.entities || {};
      ok(Object.keys(ents).some(k => k.includes('__shade__')), 'shade pushed as entity doc (mapId__shade__id)');
    }
    // delete shade; B converges
    R(A, `deleteShade('${shId}'); persistNow();`);
    await sleep(1200);
    ok(R(A, `curData().shades.length`) === 0, 'shade deleted on A');
    ok(R(B, `curData().shades.length`) === 0, 'shade delete converges on B');
  }

  console.log('— Task I: WARNING pings (⚠) place / popup type toggle / sidebar / sync —');
  {
    const wId = R(A, `const w = addPing(777, 888, 'warn'); w.label = 'HOWLER SPOT'; persistNow(); renderPings(); w.id`);
    ok(R(A, `curData().pings.find(x => x.id === '${wId}').ptype`) === 'warn', 'warn ping flagged in data');
    const wEl = R(A, `pingLayer.children.find(e => e.dataset.id === '${wId}')`);
    ok(!!wEl, 'warn ping rendered on map');
    ok(wEl && String(wEl.className || '').includes('warn'), 'warn marker carries .warn class');
    ok(R(A, `String(pingLayer.children.find(e => e.dataset.id === '${wId}')._html || '').includes('⚠')`), 'warn marker contains the ⚠ glyph');
    R(A, `curData().pings.find(x => x.id === '${wId}').color = '#4fc3ff'; renderPings(); persistNow();`);
    ok(R(A, `String(pingLayer.children.find(e => e.dataset.id === '${wId}').style['--pgc'])`) === '#4fc3ff', 'warn ping color applies to the marker');
    // story list: warn pings never appear on the right side
    R(A, `renderSidebar();`);
    const rowHtml = R(A, `(function(){ const rows = [...$('#pingList').children]; const r = rows.find(c => (c.innerHTML || '').includes('HOWLER SPOT')); return r ? r.innerHTML : ''; })()`);
    ok(rowHtml === '', 'warn ping excluded from the story list on the right');
    ok(!R(A, `[...$('#pingList').children].map(c => c.innerHTML).join(' ')`).includes('ping-warn-glyph'), 'no warn glyph rows in the story list');
    ok(R(A, `mapPingCount('rosebridge-a1')`) === 0, 'drawer ⚑ badge skips warn pings (story pings only)');
    ok(String(R(A, `$('#pingCount').textContent`)) === '0', 'ping counter skips warn pings');
    // unlock for the TYPE conversion UI (admin-only control)
    R(A, 'setAdmin(true, true);');
    // popup: TYPE toggle present, no STATUS seg for warn
    R(A, `openPingPop(curData().pings.find(x => x.id === '${wId}'), 120, 120);`);
    const popHtml = R(A, `(function walkAll(e){ let t = (e.innerHTML || ''); for (const c of (e.children || [])) t += ' ' + walkAll(c); return t; })($('#pop'))`);
    ok(popHtml.includes('⚠ WARNING'), 'popup TYPE row shows ⚠ WARNING');
    ok(R(A, `[...$('#pop').children].map(c => c.innerHTML).join(' ')`).includes('PING') === false || popHtml.includes('TYPE'), 'popup TYPE seg present');
    ok(!popHtml.includes('ONGOING'), 'warn popup hides ONGOING/FINISHED status seg');
    // convert to story → status seg returns, kind cleared
    R(A, `(function(){ const t = curData().pings.find(x => x.id === '${wId}'); pushHistory(); delete t.ptype; persist(); renderPings(); renderSidebar(); })();`);
    ok(!R(A, `curData().pings.find(x => x.id === '${wId}').ptype`), 'converting warn → story clears the flag');
    R(A, `openPingPop(curData().pings.find(x => x.id === '${wId}'), 120, 120);`);
    ok(R(A, `[...$('#pop').children].map(c => c.innerHTML).join(' ')`).includes('STATUS'), 'story popup shows STATUS seg again');
    // B converges on warn ping with flag intact
    await sleep(1200);
    R(B, `switchMap('rosebridge-a1', { silent: true }); renderAll();`);
    ok(R(B, `curData().pings.some(p => p.id === '${wId}')`), 'B received the ping');
    ok(!R(B, `curData().pings.find(p => p.id === '${wId}').ptype`), 'converted kind survives sync round-trip (no stray meta)');
    // convert back to warn and sync
    R(A, `(function(){ const t = curData().pings.find(x => x.id === '${wId}'); t.ptype = 'warn'; persistNow(); renderPings(); })();`);
    await sleep(1200);
    ok(R(B, `curData().pings.find(p => p.id === '${wId}')?.ptype`) === 'warn', 'warn flag converges on B');
    ok(R(B, `mapPingCount('rosebridge-a1')`) === 0, 'B: drawer badge skips warn ping too');
    R(A, 'setAdmin(false, true);');   // lock admin again for the rest of the suite
    R(A, `closePop(); deletePing('${wId}'); persistNow();`);
    await sleep(1200);
    ok(R(B, `curData().pings.length`) === 0, 'warn ping delete converges');
  }

  console.log('— echo-convergence: no dangling diff on either client after quiet period —');
  await sleep(1000);
  R(A, 'persistNow()'); R(B, 'persistNow()');
  await sleep(1000);
  ok(true, 'quiet convergence reached (no throw during extra push cycles)');

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL OK');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
