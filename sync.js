/* ═══════════════════════════════════════════════════════════════
   VIRTUS // LIVE SYNC  (Firebase Realtime Database)
   ─────────────────────────────────────────────────────────────
   Zero-setup live sharing of characters, locations and pings.
   Ships with a preconfigured Firebase project; no console task
   needed — the app auto-connects on load and everyone on the same
   BOARD CODE sees changes in about a second.

   Data layout (rooted under its own namespace):
     virtus/boards/<board>/entities/<mapId>__<type>__<id>  - markers (NO-DATE layer + global roster/locations)
     virtus/boards/<board>/entities/tl@<date>@<mapId>@cpos|pings - per-date timeline layers
     virtus/boards/<board>/presence/<uid>                  - who's online

   If Firebase is unreachable / config invalid, the app behaves
   exactly like the offline version (LocalStorage + JSON export).
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const AppSync = (() => {
    /* Preconfigured Firebase project (Realtime Database). Public-facing
     keys are normal for client-side Firebase apps; access is governed
     by DB rules. */
  const BUILTIN_CONFIG = {
    apiKey: "AIzaSyBRQ_UztF2lwcX81RVinv-5FBaumAclAuk",
    authDomain: "schungdar.firebaseapp.com",
    databaseURL: "https://schungdar-default-rtdb.firebaseio.com",
    projectId: "schungdar",
    storageBucket: "schungdar.firebasestorage.app",
    messagingSenderId: "448271329140",
    appId: "1:448271329140:web:a69f2a5574d243e800ae21",
  };

  const LS_CFG   = 'virtus_live_config';   // optional override config
  const LS_BOARD = 'virtus_live_board';
  const LS_NAME  = 'virtus_live_name';

  let fbApp = null, rtdb = null;
  let entRef = null, presRef = null, meRef = null, connRef = null;
  let attached = false, connected = false, connecting = false;
  let lastSynced = {};        // docId -> canonical JSON (echo suppression)
  let pushTimer = null, suppressDiff = false, peerCount = 0;
  let myId = localStorage.getItem('virtus_live_uid')
    || (localStorage.setItem('virtus_live_uid', 'u' + Math.random().toString(36).slice(2, 10)),
        localStorage.getItem('virtus_live_uid'));

  const hooks = () => window.AppHooks;

  /* ───────── config / board ───────── */
  const overrideCfg = () => { try { return JSON.parse(localStorage.getItem(LS_CFG) || 'null'); } catch { return null; } };
  const cfg = () => overrideCfg() || BUILTIN_CONFIG;
  const usingBuiltin = () => !overrideCfg();
  const boardId = () => {
    const url = new URLSearchParams(location.search).get('board');
    if (url) return url.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'public';
    return (localStorage.getItem(LS_BOARD) || 'public').trim().toLowerCase();
  };
  function saveCfg(c, b) {
    if (c === null) localStorage.removeItem(LS_CFG);
    else if (c) localStorage.setItem(LS_CFG, JSON.stringify(c));
    if (b !== undefined) localStorage.setItem(LS_BOARD, String(b || 'public').trim().toLowerCase());
  }
  const operatorName = () => localStorage.getItem(LS_NAME) || '';
  const setOperatorName = n => localStorage.setItem(LS_NAME, n);

  /* ───────── doc id helpers (RTDB-safe keys) ───────── */
  const san = s => String(s).replace(/[.#$/\[\]]/g, '_');
  const docId = (mapId, type, id) => `${san(mapId)}__${type}__${san(id)}`;
  const parseDocId = d => {
    const i = d.indexOf('__'), j = d.indexOf('__', i + 2);
    return { mapId: d.slice(0, i), type: d.slice(i + 2, j), id: d.slice(j + 2) };
  };
  const listName = { character: 'characters', location: 'locations', ping: 'pings', shade: 'shades' };

  /* canonical (stable, key-sorted) serialization for echo suppression */
  const sortKeysDeep = v => Array.isArray(v) ? v.map(sortKeysDeep)
    : (v && typeof v === 'object')
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeysDeep(v[k])]))
      : v;
  function canon(mapId, type, ent) {
    return JSON.stringify(sortKeysDeep({ ...ent, map: mapId, kind: type }));
  }

  /* ───────── timeline (calendar date layers) ─────────
     Entity docs (chars/locations/pings) carry the NO-DATE ('') layer —
     exactly what pre-calendar boards used. Every real calendar date
     syncs its character positions + story pings via dedicated docs:
       tl@<isoDate>@<mapId>@cpos   → { tl, map, part, payload:{charId:{x,y}} }
       tl@<isoDate>@<mapId>@pings  → { tl, map, part, payload:[pings] }
     Locations + the character roster stay global entity docs, so a
     peer on a different date never sees another date's layer. */
  const TL_RE = /^tl@([^@]*)@([^@]*)@(cpos|pings)$/;
  const tlDocId = (key, mapId, part) => `tl@${key || 'unset'}@${san(mapId)}@${part}`;
  function parseTlDocId(d) {
    const m = TL_RE.exec(String(d));
    if (!m) return null;
    return { key: m[1] === 'unset' ? '' : m[1], mapId: m[2], part: m[3] };
  }
  const activeKeyOf = st => (st.calendar?.selected ?? '');
  const noDateBucket = st => (st.timeline ||= {})[''] ||= { posByMap: {}, pingsByMap: {} };
  function tlBucket(st, key) {
    return (st.timeline ||= {})[key] ||= { posByMap: {}, pingsByMap: {} };
  }
  /* what the ACTIVE date's layer looks like, derived from live working data */
  function liveBucketOf(st) {
    const posByMap = {}, pingsByMap = {};
    for (const [mid, d] of Object.entries(st.data || {})) {
      if (!d) continue;
      const pos = {};
      for (const c of (d.characters || [])) if (!c.unplaced && c.x != null) pos[c.id] = { x: c.x, y: c.y };
      if (Object.keys(pos).length) posByMap[mid] = pos;
      if (d.pings?.length) pingsByMap[mid] = JSON.parse(JSON.stringify(d.pings));
    }
    return { posByMap, pingsByMap };
  }
  function tlCanon(key, mapId, part, payload) {
    return JSON.stringify(sortKeysDeep({ tl: key, map: mapId, part, payload }));
  }
  /* apply ONE PART of a date bucket into the LIVE working data for a map.
     Scoped per-part: a remote cpos doc must not touch live pings and
     vice-versa (the bucket may be a partial mirror of the live layer). */
  function applyBucketLive(st, mapId, part) {
    const key = activeKeyOf(st);
    const b = st.timeline?.[key] || {};
    const d = (st.data[mapId] ||= { characters: [], pings: [], locations: [], shades: [] });
    if (part === 'cpos') {
      const pos = b.posByMap?.[mapId] || {};
      for (const c of (d.characters || [])) {
        const p = pos[c.id];
        if (p) { c.x = p.x; c.y = p.y; delete c.unplaced; }
        else { delete c.x; delete c.y; c.unplaced = true; }
      }
    } else if (part === 'pings') {
      d.pings = JSON.parse(JSON.stringify(b.pingsByMap?.[mapId] || []));
    }
  }

  function snapshotFromState() {
    const st = hooks()?.state;
    const out = {};
    if (!st) return out;
    const active = activeKeyOf(st);
    const noDate = active !== '' ? (st.timeline?.[''] || { posByMap: {}, pingsByMap: {} }) : null;
    for (const [mapId, d] of Object.entries(st.data || {})) {
      if (!d) continue;
      for (const [type, list] of [
        ['character', d.characters],
        ['location', d.locations],
        ['shade', d.shades],
        // ping entities = the NO-DATE layer (live pings only when no date is active)
        ['ping', active === '' ? d.pings : (noDate.pingsByMap?.[mapId] || [])],
      ]) {
        for (const ent0 of (list || [])) {
          if (!ent0 || ent0.id == null) continue;
          const ent = { ...ent0 };
          if (type === 'character') {
            delete ent.unplaced;
            if (active !== '') {
              // while a date is active, live positions belong to that date —
              // the shared entity doc keeps the NO-DATE layer's position
              const p = noDate.posByMap?.[mapId]?.[ent.id];
              if (p) { ent.x = p.x; ent.y = p.y; }
              else { delete ent.x; delete ent.y; }
            }
          }
          out[docId(mapId, type, ent.id)] = canon(mapId, type, ent);
        }
      }
    }
    // per-date timeline docs (every stored non-'unset' bucket + live composite)
    const live = active !== '' ? liveBucketOf(st) : null;
    const keys = new Set(Object.keys(st.timeline || {}).filter(k => k !== ''));
    if (active !== '') keys.add(active);
    for (const key of keys) {
      const b = key === active ? live : st.timeline[key];
      if (!b) continue;
      for (const [mid, pos] of Object.entries(b.posByMap || {})) {
        if (pos && Object.keys(pos).length)
          out[tlDocId(key, mid, 'cpos')] = tlCanon(key, mid, 'cpos', pos);
      }
      for (const [mid, pings] of Object.entries(b.pingsByMap || {})) {
        if (pings?.length)
          out[tlDocId(key, mid, 'pings')] = tlCanon(key, mid, 'pings', pings);
      }
    }
    return out;
  }

  /* ───────── UI status ───────── */
  function setStatus(mode, extra) {
    const dot = document.getElementById('syncDot');
    const txt = document.getElementById('syncText');
    const online = document.getElementById('stOnline');
    const bd = boardId();
    let text = 'LOCAL ONLY';
    if (mode === 'live') text = `LIVE — “${bd}”${peerCount ? ` · ${peerCount} ONLINE` : ''}`;
    else if (mode === 'busy') text = 'CONNECTING…';
    else if (mode === 'err') text = extra || 'SYNC ERROR';
    if (txt) txt.textContent = text;
    if (online) online.textContent = mode === 'live' ? 'BOARD ONLINE' : 'LOCAL ONLY';
    if (dot) {
      const col = mode === 'live' ? 'var(--acc)' : mode === 'busy' ? 'var(--amb)' : mode === 'err' ? 'var(--red)' : 'var(--dim)';
      dot.style.background = col;
      dot.style.boxShadow = `0 0 8px ${col}`;
      dot.classList?.toggle?.('busy', mode === 'busy');
    }
  }

  function log(msg, kind) { try { hooks()?.toast?.(msg, kind); } catch {} }

  /* ───────── connect ───────── */
  async function connect(c, bd, opts = {}) {
    if (connected || connecting) return { ok: true };
    if (typeof firebase === 'undefined' || !firebase.initializeApp) {
      const e = 'FIREBASE SDK NOT LOADED (offline?)';
      if (!opts.quiet) log(e, 'red');
      setStatus('off');
      return { ok: false, err: e };
    }
    c = c || cfg(); bd = bd || boardId();
    if (!c.databaseURL && !c.projectId) {
      const e = 'CONFIG MISSING databaseURL';
      if (!opts.quiet) log(e, 'red');
      return { ok: false, err: e };
    }
    connecting = true; setStatus('busy');
    try {
      fbApp = firebase.apps && firebase.apps.length
        ? (firebase.apps.find(a => a.options?.databaseURL === c.databaseURL) || firebase.initializeApp(c, 'virtus-' + (c.projectId || 'x')))
        : firebase.initializeApp(c, 'virtus-main');
      rtdb = firebase.database(fbApp);
      const root = rtdb.ref(`virtus/boards/${bd}`);
      entRef = root.child('entities');
      presRef = root.child('presence');

      // presence: announce myself, auto-remove on disconnect, count others
      meRef = presRef.child(san(myId));
      meRef.set({ name: operatorName() || 'OPERATOR', t: firebase.database.ServerValue.TIMESTAMP });
      meRef.onDisconnect().remove();
      presRef.on('value', s => {
        peerCount = s.numChildren ? s.numChildren() : 0;
        if (connected) setStatus('live');
      });

      // connection indicator
      connRef = rtdb.ref('.info/connected');
      connRef.on('value', s => { if (s.val() === false) setStatus('busy'); });

      await initialMergeAndAttach(bd);

      connected = true;
      setStatus('live');
      if (!opts.quiet) log(`LIVE SYNC — BOARD “${bd.toUpperCase()}”`, 'green');
      return { ok: true };
    } catch (e) {
      console.error('[sync]', e);
      connected = false; setStatus('err', (e && e.code === 'PERMISSION_DENIED') ? 'DB RULES DENIED ACCESS' : 'CONNECT FAILED');
      if (!opts.quiet) log('LIVE SYNC FAILED: ' + (e.message || e), 'red');
      return { ok: false, err: String(e) };
    } finally { connecting = false; }
  }

  function detach() {
    try {
      entRef && entRef.off();
      presRef && presRef.off();
      connRef && connRef.off();
      meRef && meRef.remove();
    } catch {}
    attached = false; entRef = presRef = meRef = connRef = null;
  }

  function disconnect() {
    detach();
    connected = false; lastSynced = {};
    setStatus('off');
  }

  /* ───────── initial merge + listeners ───────── */
  async function initialMergeAndAttach(bd) {
    const snap = await entRef.once('value');
    suppressDiff = true;
    try {
      const H = hooks(); if (!H) return;
      const st = H.state;
      let n = 0;
      const liveMaps = new Set();   // maps whose ACTIVE date layer arrived
      snap.forEach(ch => {
        const data = ch.val(); if (!data) return;
        const changed = String(ch.key).startsWith('tl@')
          ? applyTlSet(ch.key, data, liveMaps)
          : applyEntitySet(ch.key, data);
        if (changed) n++;
      });
      for (const mp of liveMaps) {
        const [m, part] = mp.split('|');
        applyBucketLive(st, m, part);
      }
      H.refreshAll();
      if (n) log(`BOARD “${bd.toUpperCase()}”: ${n} SHARED OBJECT${n === 1 ? '' : 'S'} LOADED`);
    } finally { suppressDiff = false; }

    // child listeners (with echo suppression via lastSynced + canon)
    entRef.on('child_added', s => {
      try { onRemoteEntity('set', s.key, s.val()); } catch (e) { console.error(e); }
    });
    entRef.on('child_changed', s => {
      try { onRemoteEntity('set', s.key, s.val()); } catch (e) { console.error(e); }
    });
    entRef.on('child_removed', s => {
      try { onRemoteEntity('del', s.key, null); } catch (e) { console.error(e); }
    });
    attached = true;
    schedulePush(250);   // upload anything that exists only locally
  }

  function stripMeta(data, mapId, type) {
    const ent = { ...data };
    delete ent.kind;
    if (type === 'character') ent.map = mapId;
    return ent;
  }

  /* apply one entity doc; returns true when local state changed.
     Positions & story pings route into the NO-DATE bucket whenever a
     real calendar date is active locally (entity docs = the dateless layer) */
  function applyEntitySet(key, data) {
    const { mapId, type, id } = parseDocId(key);
    const ln = listName[type]; if (!ln) return false;
    const st = hooks()?.state; if (!st) return false;
    const ent = stripMeta(data, mapId, type);
    delete ent.unplaced;
    const cj = canon(mapId, type, ent);
    if (lastSynced[key] === cj) return false;   // our own echo — ignore
    const prevCanon = lastSynced[key];
    lastSynced[key] = cj;
    let changed = prevCanon !== cj;
    const active = activeKeyOf(st);
    const d = (st.data[mapId] ||= { characters: [], pings: [], locations: [], shades: [] });
    const list = d[ln] ||= [];
    const i = list.findIndex(x => String(x.id) === String(id));
    if (type === 'character' && active !== '') {
      // roster fields update live; POSITION goes into the NO-DATE bucket
      const tb = noDateBucket(st);
      if (ent.x != null) (tb.posByMap[mapId] ||= {})[ent.id] = { x: ent.x, y: ent.y };
      else if (tb.posByMap[mapId]) delete tb.posByMap[mapId][ent.id];
      const prev = i >= 0 ? list[i] : null;
      const merged = { ...ent };
      // live position stays governed by the ACTIVE date layer — and so does
      // the unplaced flag: never resurrect coords for a char that is off-date
      if (prev && prev.x != null && !prev.unplaced) { merged.x = prev.x; merged.y = prev.y; }
      else { delete merged.x; delete merged.y; merged.unplaced = true; }
      if (prev) list[i] = merged; else list.push(merged);
    } else if (type === 'ping' && active !== '') {
      // story pings live per-date; the entity doc updates the NO-DATE layer
      const arr = (noDateBucket(st).pingsByMap[mapId] ||= []);
      const j = arr.findIndex(x => String(x.id) === String(id));
      if (j >= 0) arr[j] = ent; else arr.push(ent);
    } else {
      // locations (global) or the NO-DATE layer when no date is active
      if (type === 'character' && ent.x == null) ent.unplaced = true;
      if (i >= 0) list[i] = ent; else list.push(ent);
    }
    return changed;
  }

  function applyEntityDel(key) {
    const { mapId, type, id } = parseDocId(key);
    const ln = listName[type]; if (!ln) return false;
    const st = hooks()?.state; if (!st) return false;
    delete lastSynced[key];
    let changed = false;
    const list = st.data?.[mapId]?.[ln];
    if (list) {
      const i = list.findIndex(x => String(x.id) === String(id));
      if (i >= 0) { list.splice(i, 1); changed = true; }
    }
    // deleted from the board → gone from EVERY date's layer too
    for (const b of Object.values(st.timeline || {})) {
      if (type === 'character' && b.posByMap?.[mapId]?.[id] != null) { delete b.posByMap[mapId][id]; changed = true; }
      if (type === 'ping' && b.pingsByMap?.[mapId]) {
        const j = b.pingsByMap[mapId].findIndex(x => String(x.id) === String(id));
        if (j >= 0) { b.pingsByMap[mapId].splice(j, 1); changed = true; }
      }
    }
    return changed;
  }

  /* timeline-layer doc (tl@...). liveMaps collects map ids whose ACTIVE
     date layer changed so the caller can re-derive live working data. */
  function applyTlSet(key, data, liveMaps) {
    const P = parseTlDocId(key); if (!P) return false;
    if (!data || typeof data !== 'object' || !data.part) return false;
    const dk = (data.tl ?? '') || '';
    const nm = data.map, part = data.part;
    const cj = tlCanon(dk, nm, part, data.payload);
    if (lastSynced[key] === cj) return false;   // echo
    const prevCanon = lastSynced[key];
    lastSynced[key] = cj;
    const st = hooks()?.state; if (!st) return false;
    const b = tlBucket(st, dk);
    if (part === 'cpos') b.posByMap[nm] = data.payload || {};
    else b.pingsByMap[nm] = Array.isArray(data.payload) ? data.payload : [];
    if (dk === activeKeyOf(st) && liveMaps) liveMaps.add(nm + '|' + part);
    return prevCanon !== cj;
  }

  function applyTlDel(key, liveMaps) {
    const P = parseTlDocId(key); if (!P) return false;
    const st = hooks()?.state; if (!st) return false;
    delete lastSynced[key];
    const b = st.timeline?.[P.key];
    if (!b) return false;
    let changed = false;
    if (P.part === 'cpos' && b.posByMap?.[P.mapId]) { delete b.posByMap[P.mapId]; changed = true; }
    if (P.part === 'pings' && b.pingsByMap?.[P.mapId]) { delete b.pingsByMap[P.mapId]; changed = true; }
    if (P.key === activeKeyOf(st) && liveMaps) liveMaps.add(P.mapId + '|' + P.part);
    return changed;
  }

  function onRemoteEntity(op, key, data) {
    const H = hooks(); if (!H) return;
    const st = H.state;
    suppressDiff = true;
    try {
      const liveMaps = new Set();
      const changed = String(key).startsWith('tl@')
        ? (op === 'del' ? applyTlDel(key, liveMaps) : applyTlSet(key, data, liveMaps))
        : (op === 'del' ? applyEntityDel(key) : applyEntitySet(key, data));
      for (const mp of liveMaps) {
        const [m, part] = mp.split('|');
        applyBucketLive(st, m, part);
      }
      if (changed || liveMaps.size) H.applyRemote();
    } finally { suppressDiff = false; }
  }

  /* ───────── outgoing diff sync ───────── */
  function noteChange() {
    if (!connected || suppressDiff) return;
    schedulePush(300);
  }
  function schedulePush(ms) {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushDiff, ms);
  }

  function pushDiff() {
    if (!connected || !entRef) return;
    const now = snapshotFromState();
    const ups = [], dels = [];
    for (const [did, cj] of Object.entries(now)) {
      if (lastSynced[did] !== cj) ups.push(did);
    }
    for (const did of Object.keys(lastSynced)) {
      if (!(did in now)) dels.push(did);
    }
    if (!ups.length && !dels.length) return;
    setStatus('busy');
    const updates = {};
    for (const did of ups) {
      if (did.startsWith('tl@')) {
        // timeline docs push their self-describing wrapper verbatim
        updates[did] = JSON.parse(now[did]);
        continue;
      }
      const { mapId, type } = parseDocId(did);
      const ent = stripMeta(JSON.parse(now[did]), mapId, type);
      ent.kind = type;
      updates[did] = ent;
    }
    for (const did of dels) updates[did] = null;
    // RTDB multi-path update = one atomic round-trip
    entRef.update(updates).then(() => {
      for (const did of ups) lastSynced[did] = now[did];
      for (const did of dels) delete lastSynced[did];
      setStatus('live');
    }).catch(e => {
      console.error('[sync] push', e);
      setStatus('err', 'PUSH FAILED');
    });
  }

  /* ───────── public API ───────── */
  window.addEventListener('beforeunload', () => { try { pushDiff(); meRef && meRef.remove(); } catch {} });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { try { pushDiff(); } catch {} } });
  return {
    connect, disconnect, noteChange,
    cfg, boardId, saveCfg, usingBuiltin, operatorName, setOperatorName,
    isConnected: () => connected,
    peerCount: () => peerCount,
  };
})();
window.AppSync = AppSync;
