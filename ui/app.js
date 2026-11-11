/* global hub, PsxMemory */
'use strict';

const GAME_ID = 'sotn';
const $ = (id) => document.getElementById(id);

const state = {
  settings: null,
  def: null,
  seeds: [],
  current: null,          // { seedId, label, path }
  emu: 'idle',
  auto: new Set(),        // relic indexes seen owned in RAM
  marked: new Set(),      // item ids marked by hand
  bosses: new Set(),
  timer: { running: false, start: 0, acc: 0 },
};

const locator = new PsxMemory.RamLocator();
let relicOffset = 0;
let relicCount = 30;
let relicMax = 3;
let invalidStreak = 0;
let readCounter = 0;

// ------------------------------------------------------------------ utils
function toast(msg, isError = false, ms = 4200) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  t.hidden = false;
  clearTimeout(toast._h);
  toast._h = setTimeout(() => { t.hidden = true; }, ms);
}
function setPill(id, st, text) {
  const el = $(id);
  el.dataset.state = st;
  el.textContent = text;
}
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
}
const allItems = () => state.def.tracker.groups.flatMap((g) => g.items);
const trackerKey = () => `tracker:${GAME_ID}:${state.current ? state.current.seedId || 'vanilla' : 'none'}`;

// ------------------------------------------------------------------ tabs
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
function showTab(name) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${name}`));
}

// ------------------------------------------------------------------ tracker
// In-game item icon from the SotnRandoTools sheet (7 x 9 grid of 14px icons),
// or the text abbreviation if the sheet isn't installed.
function iconFor(it) {
  if (!state.hasIcons || it.icon === undefined) return el('div', { class: 'abbr' }, it.short);
  const col = it.icon % 7, row = Math.floor(it.icon / 7);
  return el('div', { class: 'icon', style: `background-position:${(col / 6) * 100}% ${(row / 8) * 100}%` });
}

function buildTracker() {
  const root = $('trackerGroups');
  root.innerHTML = '';
  for (const g of state.def.tracker.groups) {
    const grid = el('div', { class: 'grid' });
    for (const it of g.items) {
      const tile = el('div', {
        class: 'tile' + (it.key ? ' key' : ''),
        'data-id': it.id,
        title: it.label,
        onclick: () => { toggleMark(it.id); },
        oncontextmenu: (e) => { e.preventDefault(); state.marked.delete(it.id); if (abilityOf(it) !== undefined) state.auto.delete(abilityOf(it)); renderTracker(); saveTracker(); },
      }, iconFor(it), el('div', { class: 'name' }, it.label));
      grid.append(tile);
    }
    root.append(el('div', { class: 'group' }, el('h4', {}, g.name), grid));
  }
  const bl = $('bossList');
  bl.innerHTML = '';
  for (const b of state.def.tracker.bosses) {
    const cb = el('input', { type: 'checkbox', onchange: (e) => { e.target.checked ? state.bosses.add(b) : state.bosses.delete(b); saveTracker(); } });
    bl.append(el('label', {}, cb, el('span', {}, b)));
  }
  const keyTotal = allItems().filter((i) => i.key).length;
  $('keyTotal').textContent = `/${keyTotal} key`;
}

const abilityOf = (it) => (it.relic !== undefined ? it.relic : it.ability);
function isOwned(it) {
  const a = abilityOf(it);
  return state.marked.has(it.id) || (a !== undefined && state.auto.has(a));
}

function renderTracker() {
  for (const it of allItems()) {
    const tile = document.querySelector(`.tile[data-id="${it.id}"]`);
    if (!tile) continue;
    const a = abilityOf(it);
    const auto = a !== undefined && state.auto.has(a);
    tile.classList.toggle('owned', auto);
    tile.classList.toggle('marked', !auto && state.marked.has(it.id));
  }
  const items = allItems();
  $('relicCount').textContent = items.filter((i) => i.relic !== undefined && isOwned(i)).length;
  $('vladCount').textContent = items.filter((i) => i.vlad && isOwned(i)).length;
  $('keyCount').textContent = items.filter((i) => i.key && isOwned(i)).length;
  if (state.map) renderMap();
  document.querySelectorAll('#bossList label').forEach((l) => {
    l.querySelector('input').checked = state.bosses.has(l.textContent);
  });
}

function toggleMark(id) {
  state.marked.has(id) ? state.marked.delete(id) : state.marked.add(id);
  renderTracker();
  saveTracker();
}

function saveTracker() {
  try {
    localStorage.setItem(trackerKey(), JSON.stringify({
      auto: [...state.auto], marked: [...state.marked], bosses: [...state.bosses],
      timer: { acc: currentElapsed(), running: false },
    }));
  } catch (_) { /* storage unavailable */ }
}
function loadTracker() {
  state.auto = new Set(); state.marked = new Set(); state.bosses = new Set();
  state.timer = { running: false, start: 0, acc: 0 };
  try {
    const s = JSON.parse(localStorage.getItem(trackerKey()) || 'null');
    if (s) {
      state.auto = new Set(s.auto); state.marked = new Set(s.marked); state.bosses = new Set(s.bosses);
      state.timer.acc = (s.timer && s.timer.acc) || 0;
    }
  } catch (_) { /* ignore */ }
  renderTracker();
  renderTimer();
}

$('trackerReset').addEventListener('click', () => {
  if (!confirm('Clear the tracker for this game?')) return;
  state.auto.clear(); state.marked.clear(); state.bosses.clear();
  renderTracker(); saveTracker();
});

$('autoTrack').addEventListener('change', async (e) => {
  await hub.setSettings({ autoTrack: e.target.checked });
  state.settings.autoTrack = e.target.checked;
  updateTrackPill();
});

// ------------------------------------------------------------------ memory polling
function updateTrackPill(st) {
  if (!state.settings.autoTrack) return setPill('trackStatus', 'off', 'Manual tracking');
  if (state.emu !== 'running') return setPill('trackStatus', 'off', 'Tracking idle');
  if (st === 'ready' || locator.ready) return setPill('trackStatus', 'live', 'Auto-tracking live');
  if (st === 'searching') return setPill('trackStatus', 'searching', 'Finding game RAM…');
  return setPill('trackStatus', 'searching', 'Waiting for game…');
}

function emuHook() {
  try { return $('emuFrame').contentWindow.__psxHook; } catch (_) { return null; }
}

function pollMemory() {
  if (state.emu !== 'running' || !state.settings.autoTrack) return;
  const hook = emuHook();
  if (!locator.ready) {
    let st = 'waiting';
    const t0 = performance.now();
    do { st = locator.step(hook); } while (st === 'searching' && performance.now() - t0 < 12);
    updateTrackPill(st);
    if (!locator.ready) return;
    toast('Auto-tracking connected to the game.');
  }
  const mem = state.def.memory;
  const base = parseInt(mem.statusBlockStart, 16);
  const block = locator.read(base, parseInt(mem.statusBlockLength, 16));
  if (!block) { locator.invalidate(); return; }

  if (++readCounter % 40 === 0) {
    if (!locator.stillValid()) {
      if (++invalidStreak > 6) { locator.invalidate(); invalidStreak = 0; updateTrackPill('searching'); return; }
    } else invalidStreak = 0;
  }
  // Sanity: relic bytes are tiny flags. Anything bigger means we're not in-game yet.
  for (let i = 0; i < relicCount; i++) if (block[i] > relicMax) return;
  const at = (addr) => block[parseInt(addr, 16) - base];
  const slot = (name) => at(mem.slots[name]);

  const found = [];
  for (let i = 0; i < relicCount; i++) if (block[i]) found.push(i);
  const invBase = parseInt(mem.handQuantityStart, 16) - base;
  for (const k of mem.keyItems) {
    if (block[invBase + k.inventoryIndex] > 0 || k.slots.some((n) => slot(n) === k.value)) found.push(k.ability);
  }
  const ts = mem.thrustSwords;
  if (ts.inventoryIndexes.some((i) => block[invBase + i] > 0 || ts.slots.some((n) => slot(n) === i))) found.push(ts.ability);

  let changed = false;
  for (const a of found) {
    if (state.auto.has(a)) continue;
    state.auto.add(a);
    changed = true;
    const it = allItems().find((x) => abilityOf(x) === a);
    const tile = it && document.querySelector(`.tile[data-id="${it.id}"]`);
    if (tile) { tile.classList.remove('flash'); void tile.offsetWidth; tile.classList.add('flash'); }
  }
  if (changed) { renderTracker(); saveTracker(); }

  // Map tracker
  if (state.map) {
    const rStart = parseInt(mem.roomsStart, 16);
    const rooms = locator.read(rStart, parseInt(mem.roomsLength, 16));
    const stage = locator.read(parseInt(mem.stageId, 16), 1);
    const open = locator.read(parseInt(mem.mapOpen, 16), 1);
    if (rooms && stage && open) {
      state.mapLive = {
        visited: SotnMap.visitedFromRam(state.map, (addr) => {
          const o = addr - rStart;
          return o >= 0 && o < rooms.length ? rooms[o] : null;
        }),
        second: (stage[0] & parseInt(mem.secondCastleMask, 16)) !== 0,
        open: open[0] > 0,
      };
      renderMap();
    }
  }
}
setInterval(pollMemory, 250);

// ------------------------------------------------------------------ map tracker
async function loadMap(presetId) {
  const m = await hub.mapModel(presetId);
  state.hasIcons = !!(m && m.hasIcons);
  state.map = m && m.available ? m : null;
  state.mapLive = null;
  state.mapView = null; // null = follow the castle you're in
  $('mapSection').hidden = !state.map;
  if (state.map) $('mapPreset').textContent = presetId ? `Logic: ${presetId}` : 'Locations only (vanilla)';
  renderMap();
}

function ownedAbilities() {
  const owned = new Set(state.auto);
  for (const it of allItems()) if (state.marked.has(it.id) && abilityOf(it) !== undefined) owned.add(abilityOf(it));
  return owned;
}

function renderMap() {
  const model = state.map;
  if (!model) return;
  const live = state.mapLive || { visited: new Set(), second: false, open: false };
  const colors = SotnMap.computeColors(model, ownedAbilities(), live.visited);
  const second = state.mapView === null ? live.second : state.mapView;

  // Side panel map
  const cv = $('castleMap');
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#07060a';
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.strokeStyle = 'rgba(201,162,74,0.07)';
  for (let x = 0; x <= 256; x += 16) { ctx.beginPath(); ctx.moveTo(x * 2, 0); ctx.lineTo(x * 2, cv.height); ctx.stroke(); }
  for (let y = 0; y <= 208; y += 16) { ctx.beginPath(); ctx.moveTo(0, y * 2); ctx.lineTo(cv.width, y * 2); ctx.stroke(); }
  const list = SotnMap.markers(model, colors, live.visited, second);
  SotnMap.drawMarkers(ctx, list, 2, 2, 0, 0);
  state.mapMarkers = list;

  const inCastle = model.locations.filter((l) => l.second === second).length;
  const checked = model.locations.filter((l, i) => l.second === second && live.visited.has(i)).length;
  const avail = list.filter((m) => m.color === SotnMap.COLORS.available).length;
  $('mapStats').textContent = `${second ? 'Inverted' : 'First'} castle · ${checked}/${inCastle} checked · ${avail} in logic`;
  $('mapCastle1').classList.toggle('active', !second);
  $('mapCastle2').classList.toggle('active', second);

  // In-game overlay: only while the game's own map screen is open, like BizHawk.
  let overlay = null;
  try { overlay = $('emuFrame').contentWindow.__psxOverlay; } catch (_) { /* not loaded */ }
  if (overlay) {
    if (live.open && state.settings.mapOverlay !== false) {
      overlay.draw(SotnMap.markers(model, colors, live.visited, live.second), state.settings.mapCalib || {});
    } else overlay.clear();
  }
}

$('mapCastle1').addEventListener('click', () => { state.mapView = state.mapView === false ? null : false; renderMap(); });
$('mapCastle2').addEventListener('click', () => { state.mapView = state.mapView === true ? null : true; renderMap(); });
$('castleMap').addEventListener('mousemove', (e) => {
  const r = e.target.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * 256, y = ((e.clientY - r.top) / r.height) * 208;
  const hit = (state.mapMarkers || []).find((m) => x >= m.x - 1 && x <= m.x + m.w + 1 && y >= m.y - 1 && y <= m.y + m.h + 1);
  e.target.title = hit ? hit.name : '';
});

// ------------------------------------------------------------------ timer
function currentElapsed() {
  return state.timer.acc + (state.timer.running ? performance.now() - state.timer.start : 0);
}
function fmt(ms) {
  const t = Math.floor(ms / 100);
  const d = t % 10, s = Math.floor(t / 10) % 60, m = Math.floor(t / 600) % 60, h = Math.floor(t / 36000);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${d}`;
}
function renderTimer() {
  $('timerDisplay').textContent = fmt(currentElapsed());
  $('timerStart').textContent = state.timer.running ? 'Pause' : (state.timer.acc ? 'Resume' : 'Start');
}
$('timerStart').addEventListener('click', () => {
  if (state.timer.running) { state.timer.acc = currentElapsed(); state.timer.running = false; saveTracker(); }
  else { state.timer.start = performance.now(); state.timer.running = true; }
  renderTimer();
});
$('timerReset').addEventListener('click', () => {
  state.timer = { running: false, start: 0, acc: 0 };
  renderTimer(); saveTracker();
});
setInterval(() => { if (state.timer.running) $('timerDisplay').textContent = fmt(currentElapsed()); }, 100);

// ------------------------------------------------------------------ emulator
async function play(pathToBin, seedId, label) {
  if (state.emu === 'running') saveTracker();
  try {
    const info = await hub.loadGame(GAME_ID, pathToBin, seedId);
    state.current = { seedId, label, path: pathToBin };
    const seed = state.seeds.find((x) => x.id === seedId);
    await loadMap(seed ? seed.preset : null);
    loadTracker();
    locator.reset(info.probes);
    relicOffset = parseInt(state.def.memory.relicsOffset, 16);
    relicCount = state.def.memory.relicCount;
    relicMax = state.def.memory.relicMaxValidValue;

    const q = new URLSearchParams({ core: info.core, game: info.gameUrl, bios: info.biosUrl, name: info.saveName, data: info.dataPath });
    const frame = $('emuFrame');
    frame.hidden = false;
    $('emptyState').hidden = true;
    frame.src = `emu.html?${q}`;
    frame.focus();
    state.emu = 'loading';
    setPill('emuStatus', 'loading', 'Loading…');
    $('nowPlaying').innerHTML = '';
    $('nowPlaying').append('Now playing: ', el('b', {}, label));
    $('stopGame').disabled = false;
    $('fullscreen').disabled = false;
    renderSeeds();
    showTab('tracker');
  } catch (e) {
    toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true);
  }
}

window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || !e.data) return;
  if (e.data.type === 'emu:started' || e.data.type === 'emu:ready') {
    if (e.data.type === 'emu:started') { state.emu = 'running'; setPill('emuStatus', 'running', 'Running'); }
    updateTrackPill();
  }
  if (e.data.type === 'emu:display') {
    const { fps, made, shown } = e.data;
    const low = fps < 50;
    const frameInfo = made ? ` · game ${made} made / ${Math.min(shown, made)} shown` : '';
    const dropping = made >= 50 && shown < made * 0.8;
    setPill('displayFps', low || dropping ? 'error' : 'live', `Screen ${fps} Hz${frameInfo}`);
    if (low && !state.warnedLowFps && state.emu === 'running') {
      state.warnedLowFps = true;
      toast(`Windows is only showing ${fps} fps. If this is a laptop, plug it in and turn off Battery saver / set Power mode to Best performance.`, true, 9000);
    }
  }
  if (e.data.type === 'emu:error') { state.emu = 'error'; setPill('emuStatus', 'error', 'Emulator failed to load'); }
});

// EJS_onGameStart isn't fired by every EmulatorJS version; fall back to "running" once the frame has loaded.
$('emuFrame').addEventListener('load', () => {
  if ($('emuFrame').src.includes('emu.html')) setTimeout(() => {
    if (state.emu === 'loading') { state.emu = 'running'; setPill('emuStatus', 'running', 'Running'); updateTrackPill(); }
  }, 8000);
});

function stop() {
  saveTracker();
  const frame = $('emuFrame');
  frame.src = 'about:blank';
  frame.hidden = true;
  $('emptyState').hidden = false;
  state.emu = 'idle';
  state.current = null;
  locator.reset([]);
  setPill('emuStatus', 'idle', 'Emulator idle');
  setPill('displayFps', 'off', 'Display — fps');
  updateTrackPill();
  $('nowPlaying').textContent = 'No game loaded';
  $('stopGame').disabled = true;
  $('fullscreen').disabled = true;
  renderSeeds();
}
$('stopGame').addEventListener('click', () => { if (confirm('Stop the game? Unsaved progress (no save state / memory card save) is lost.')) stop(); });
$('fullscreen').addEventListener('click', () => $('emuFrame').requestFullscreen().catch(() => {}));

$('playVanilla').addEventListener('click', () => {
  const p = state.settings.games[GAME_ID].vanillaBin;
  if (!p) { showTab('settings'); return toast('Choose your Symphony of the Night disc in Settings first.', true); }
  play(p, null, 'Vanilla');
});
$('quickSeed').addEventListener('click', async () => {
  showTab('seeds');
  $('seedInput').value = '';
  $('seedForm').requestSubmit();
});

// ------------------------------------------------------------------ seeds
async function refreshRando() {
  const st = await hub.randoStatus(GAME_ID);
  const sel = $('preset');
  const prev = sel.value || localStorage.getItem('lastPreset') || st.defaultPreset;
  sel.innerHTML = '';
  for (const p of st.presets) sel.append(el('option', { value: p, selected: p === prev }, p));
  $('randoPath').textContent = st.dir;
  const b = $('randoBadge');
  b.className = 'badge ' + (st.installed ? 'ok' : 'bad');
  b.textContent = st.installed ? 'Installed' : 'Not installed';
  state.randoInstalled = st.installed;
  renderChecklist();
}

$('diceSeed').addEventListener('click', async () => { $('seedInput').value = await hub.randomSeed(); });

$('seedForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('generateBtn');
  const log = $('seedLog');
  log.hidden = false;
  log.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Generating…';
  localStorage.setItem('lastPreset', $('preset').value);
  const off = hub.onRandoLog((line) => { log.textContent += line + '\n'; log.scrollTop = log.scrollHeight; });
  try {
    const entry = await hub.generate({
      gameId: GAME_ID,
      seed: $('seedInput').value,
      preset: $('preset').value,
      tournament: $('tournament').checked,
      spoilerLevel: Number($('spoilerLevel').value),
      extraArgs: $('extraArgs').value,
    });
    await loadSeeds();
    toast(`Seed ${entry.seed} ready.`);
    play(entry.bin, entry.id, `${entry.preset} · ${entry.seed}`);
  } catch (err) {
    const msg = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    log.textContent += '\n' + msg;
    toast(msg.split('\n')[0], true);
    if (/Settings/.test(msg)) showTab('settings');
  } finally {
    off();
    btn.disabled = false;
    btn.textContent = 'Generate seed';
  }
});

async function loadSeeds() {
  state.seeds = await hub.listSeeds();
  renderSeeds();
}

function renderSeeds() {
  const ul = $('seedList');
  ul.innerHTML = '';
  if (!state.seeds.length) {
    ul.append(el('li', { class: 'empty-note' }, 'No seeds yet. Generate one above.'));
    return;
  }
  for (const s of state.seeds) {
    const isCur = state.current && state.current.seedId === s.id;
    ul.append(el('li', { class: isCur ? 'current' : '' },
      el('div', { class: 'meta' },
        el('div', {}, el('div', { class: 'seed-name' }, s.seed), el('div', { class: 'seed-preset' }, s.preset + (s.tournament ? ' · tournament' : ''))),
        el('div', { class: 'seed-date' }, new Date(s.created).toLocaleString())),
      el('div', { class: 'actions' },
        el('button', { class: 'btn small primary', onclick: () => play(s.bin, s.id, `${s.preset} · ${s.seed}`) }, isCur ? 'Restart' : 'Play'),
        el('button', { class: 'btn small', onclick: () => openSpoiler(s) }, 'Spoiler'),
        el('button', { class: 'btn small', onclick: () => hub.showInFolder(s.bin) }, 'Folder'),
        el('button', { class: 'btn small ghost', onclick: async () => {
          if (isCur) return toast('Stop the game before deleting this seed.', true);
          if (!confirm(`Delete seed ${s.seed}? This removes its .bin and spoiler log.`)) return;
          await hub.deleteSeed(s.id); localStorage.removeItem(`tracker:${GAME_ID}:${s.id}`); loadSeeds();
        } }, 'Delete'))));
  }
}

async function openSpoiler(s) {
  const text = await hub.spoiler(s.id);
  $('spoilerTitle').textContent = `Spoiler log — ${s.preset} · ${s.seed}`;
  const pre = $('spoilerText');
  pre.textContent = text || '(No spoiler output — the seed was generated with spoilers off or in tournament mode.)';
  pre.classList.add('blurred');
  $('revealSpoiler').hidden = false;
  $('spoilerDialog').showModal();
}
$('revealSpoiler').addEventListener('click', () => { $('spoilerText').classList.remove('blurred'); $('revealSpoiler').hidden = true; });

// ------------------------------------------------------------------ settings
async function renderSettings() {
  const s = state.settings;
  $('biosPath').textContent = s.biosPath || 'Not set';
  $('discPath').textContent = s.games[GAME_ID].vanillaBin || 'Not set';
  $('seedsPath').textContent = s.seedsDir;
  document.querySelectorAll('input[name="ejs"]').forEach((r) => { r.checked = r.value === s.emulatorData; });
  $('coreSelect').value = s.core;
  $('autoTrack').checked = s.autoTrack !== false;
  $('mapOverlay').checked = s.mapOverlay !== false;
  const c = s.mapCalib || {};
  $('calib-dx').value = c.dx || 0; $('calib-dy').value = c.dy || 0; $('calib-scale').value = c.scale || 1;

  const bb = $('biosBadge');
  if (s.biosPath) {
    const r = await hub.checkBios(s.biosPath);
    bb.className = 'badge ' + (r.ok ? 'ok' : 'warn');
    bb.textContent = r.ok ? 'OK' : (r.error ? 'Missing' : 'Unexpected size');
    state.biosOk = !!r.ok || (!r.error);
  } else { bb.className = 'badge bad'; bb.textContent = 'Required'; state.biosOk = false; }

  const db = $('discBadge');
  if (s.games[GAME_ID].vanillaBin) {
    const r = await hub.checkDisc(GAME_ID, s.games[GAME_ID].vanillaBin);
    if (!r.ok) { db.className = 'badge bad'; db.textContent = 'Unreadable'; state.discOk = false; db.title = r.error; }
    else if (!r.matches) { db.className = 'badge warn'; db.textContent = `Found ${r.exeName}`; db.title = `Expected ${r.expected}`; state.discOk = true; }
    else { db.className = 'badge ok'; db.textContent = r.exeName; db.title = ''; state.discOk = true; }
  } else { db.className = 'badge bad'; db.textContent = 'Required'; state.discOk = false; }
  renderChecklist();
}

function renderChecklist() {
  const ul = $('setupChecklist');
  ul.innerHTML = '';
  const items = [
    [state.biosOk, 'PlayStation BIOS selected'],
    [state.discOk, 'Symphony of the Night Track 1 .bin selected'],
    [state.randoInstalled, 'Seed generator installed'],
  ];
  for (const [ok, label] of items) ul.append(el('li', { class: ok ? 'done' : '' }, label));
  const ready = state.biosOk && state.discOk;
  $('playVanilla').disabled = !ready;
  $('quickSeed').disabled = !(ready && state.randoInstalled);
}

$('pickBios').addEventListener('click', async () => {
  const p = await hub.pickFile('Choose PlayStation BIOS', [{ name: 'BIOS', extensions: ['bin', 'rom', 'BIN'] }, { name: 'All files', extensions: ['*'] }]);
  if (!p) return;
  state.settings = await hub.setSettings({ biosPath: p });
  renderSettings();
});
$('pickDisc').addEventListener('click', async () => {
  const p = await hub.pickFile('Choose Symphony of the Night (Track 1) .bin', [{ name: 'Disc image', extensions: ['bin', 'iso', 'img'] }, { name: 'All files', extensions: ['*'] }]);
  if (!p) return;
  state.settings = await hub.setSettings({ games: { [GAME_ID]: { ...state.settings.games[GAME_ID], vanillaBin: p } } });
  renderSettings();
});
$('pickRando').addEventListener('click', async () => {
  const p = await hub.pickDir('Choose your SotN Randomizer folder');
  if (!p) return;
  state.settings = await hub.setSettings({ randomizerDir: p });
  refreshRando();
});
$('pickSeedsDir').addEventListener('click', async () => {
  const p = await hub.pickDir('Choose where seeds are saved');
  if (!p) return;
  state.settings = await hub.setSettings({ seedsDir: p });
  renderSettings();
});
document.querySelectorAll('input[name="ejs"]').forEach((r) => r.addEventListener('change', async () => {
  state.settings = await hub.setSettings({ emulatorData: r.value });
  toast('Takes effect next time you start a game.');
}));
$('coreSelect').addEventListener('change', async (e) => {
  state.settings = await hub.setSettings({ core: e.target.value });
  toast('Takes effect next time you start a game.');
});

$('mapOverlay').addEventListener('change', async (e) => {
  state.settings = await hub.setSettings({ mapOverlay: e.target.checked });
  renderMap();
});
for (const k of ['dx', 'dy', 'scale']) {
  $(`calib-${k}`).addEventListener('input', async (e) => {
    const calib = { ...(state.settings.mapCalib || {}), [k]: Number(e.target.value) };
    state.settings = await hub.setSettings({ mapCalib: calib });
    renderMap();
  });
}

$('srtLink').addEventListener('click', (e) => { e.preventDefault(); hub.openExternal('https://github.com/TalicZealot/SotnRandoTools'); });

window.addEventListener('beforeunload', () => saveTracker());

// ------------------------------------------------------------------ boot
(async function init() {
  state.settings = await hub.getSettings();
  state.def = await hub.gameDef(GAME_ID);
  $('gameTitle').textContent = state.def.title;
  await loadMap(null);
  buildTracker();
  loadTracker();
  await renderSettings();
  await refreshRando();
  await loadSeeds();
  updateTrackPill();
})();
