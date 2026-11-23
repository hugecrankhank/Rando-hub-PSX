/* global hub, PsxMemory, FF7Track */
'use strict';

// Final Fantasy VII page: emulator, our own seed generator and the auto-tracker.
const GAME_ID = 'ff7';
const $ = (id) => document.getElementById(id);
try { localStorage.setItem('lastGame', GAME_ID); } catch (_) { /* ignore */ }

const state = {
  settings: null, def: null, names: null, seeds: [], presets: null,
  current: null,           // { seedId, label, disc }
  emu: 'idle',
  auto: new Set(),         // tile names seen in RAM
  marked: new Set(),
  bosses: new Set(),
  timer: { running: false, start: 0, acc: 0 },
  live: null,
  saveBase: -1,
  discChecks: [],
};
const locator = new PsxMemory.RamLocator();
let polls = 0;

// ------------------------------------------------------------------ utils
function toast(msg, isError = false, ms = 4200) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  t.hidden = false;
  clearTimeout(toast._h);
  toast._h = setTimeout(() => { t.hidden = true; }, ms);
}
const cleanErr = (e) => String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
function setPill(id, st, text) { const e = $(id); e.dataset.state = st; e.textContent = text; }
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
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const allTiles = () => state.def.tracker.groups.flatMap((g) => g.items);
const trackerKey = () => `tracker:${GAME_ID}:${state.current ? state.current.seedId || 'vanilla' : 'none'}`;

$('gameSwitch').addEventListener('change', (e) => {
  if (state.emu === 'running' && !confirm('Switch game? The running game will stop.')) { e.target.value = GAME_ID; return; }
  saveTracker();
  localStorage.setItem('lastGame', e.target.value);
  location.href = e.target.value === 'sotn' ? 'index.html' : `${e.target.value}.html`;
});

document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
function showTab(name) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${name}`));
}

// ------------------------------------------------------------------ tracker
// Materia id for a tile, read from the player's own disc when we have it.
function tileId(t) {
  if (state.names && state.names.materia) {
    const i = state.names.materia.findIndex((n) => norm(n) === norm(t.name));
    if (i >= 0) return i;
  }
  return t.id;
}

function buildTracker() {
  const root = $('trackerGroups');
  root.innerHTML = '';
  for (const g of state.def.tracker.groups) {
    const grid = el('div', { class: 'grid' });
    for (const t of g.items) {
      grid.append(el('div', {
        class: 'tile' + (t.key ? ' key' : ''), 'data-id': t.name, title: t.name,
        onclick: () => { state.marked.has(t.name) ? state.marked.delete(t.name) : state.marked.add(t.name); renderTracker(); saveTracker(); },
        oncontextmenu: (e) => { e.preventDefault(); state.marked.delete(t.name); state.auto.delete(t.name); renderTracker(); saveTracker(); },
      }, el('div', { class: 'abbr' }, t.short), el('div', { class: 'name' }, t.name)));
    }
    root.append(el('div', { class: 'group' }, el('h4', {}, g.name), grid));
  }
  const bl = $('bossList');
  bl.innerHTML = '';
  const bosses = [...state.def.tracker.bosses, ...state.def.tracker.optionalBosses.map((b) => `${b} (optional)`)];
  for (const b of bosses) {
    const cb = el('input', { type: 'checkbox', onchange: (e) => { e.target.checked ? state.bosses.add(b) : state.bosses.delete(b); saveTracker(); } });
    bl.append(el('label', {}, cb, el('span', {}, b)));
  }
  const tiles = allTiles();
  $('materiaTotal').textContent = `/${tiles.length} materia`;
  $('keyTotal').textContent = `/${tiles.filter((t) => t.key).length} key`;
}

const owned = (t) => state.auto.has(t.name) || state.marked.has(t.name);

function renderTracker() {
  for (const t of allTiles()) {
    const tile = document.querySelector(`.tile[data-id="${CSS.escape(t.name)}"]`);
    if (!tile) continue;
    tile.classList.toggle('owned', state.auto.has(t.name));
    tile.classList.toggle('marked', !state.auto.has(t.name) && state.marked.has(t.name));
  }
  $('materiaCount').textContent = allTiles().filter(owned).length;
  $('keyCount').textContent = allTiles().filter((t) => t.key && owned(t)).length;
  document.querySelectorAll('#bossList label').forEach((l) => { l.querySelector('input').checked = state.bosses.has(l.textContent); });
  renderParty();
}

function fmtTime(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function renderParty() {
  const box = $('party');
  const live = state.live;
  if (!live) return;
  box.innerHTML = '';
  const wName = (i) => (state.names && state.names.weapons[i]) || '';
  const inParty = new Set(live.party);
  const row = (c, strong) => el('div', { class: 'member' + (strong ? ' in' : '') },
    el('b', {}, c.name), el('span', { class: 'lv' }, `Lv ${c.level}`), el('small', {}, wName(c.weapon)));
  box.append(el('h4', {}, 'Party'));
  for (const id of live.party) {
    const c = live.chars.find((x) => x.id === id) || live.chars[id];
    if (c) box.append(row(c, true));
  }
  const others = live.chars.filter((c) => !inParty.has(c.id));
  box.append(el('div', { class: 'others' }, others.map((c) => el('span', {}, `${c.defaultName} ${c.level}`))));
  $('gilCount').textContent = live.gil.toLocaleString();
  $('liveLine').textContent = `In-game time ${fmtTime(live.seconds)} · story progress ${live.progress}` +
    (state.current ? ` · Disc ${state.current.disc}` : '');
}

function saveTracker() {
  try {
    localStorage.setItem(trackerKey(), JSON.stringify({
      auto: [...state.auto], marked: [...state.marked], bosses: [...state.bosses], timer: { acc: currentElapsed() },
    }));
  } catch (_) { /* ignore */ }
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
  renderTracker(); renderTimer();
}

$('trackerReset').addEventListener('click', () => {
  if (!confirm('Clear the tracker for this game?')) return;
  state.auto.clear(); state.marked.clear(); state.bosses.clear();
  renderTracker(); saveTracker();
});
$('autoTrack').addEventListener('change', async (e) => {
  state.settings = await hub.setSettings({ autoTrack: e.target.checked });
  updateTrackPill();
});

// ------------------------------------------------------------------ memory polling
function updateTrackPill(st) {
  if (state.settings.autoTrack === false) return setPill('trackStatus', 'off', 'Manual tracking');
  if (state.emu !== 'running') return setPill('trackStatus', 'off', 'Tracking idle');
  if (!locator.ready) return setPill('trackStatus', 'searching', st === 'searching' ? 'Finding game RAM…' : 'Waiting for game…');
  if (state.saveBase < 0) return setPill('trackStatus', 'searching', 'Waiting for New Game / Continue…');
  return setPill('trackStatus', 'live', 'Auto-tracking live');
}

function emuHook() {
  try { return $('emuFrame').contentWindow.__psxHook; } catch (_) { return null; }
}

function pollMemory() {
  if (state.emu !== 'running' || state.settings.autoTrack === false) return;
  if (!locator.ready) {
    let st = 'waiting';
    const t0 = performance.now();
    do { st = locator.step(emuHook()); } while (st === 'searching' && performance.now() - t0 < 12);
    updateTrackPill(st);
    if (!locator.ready) return;
  }
  polls++;
  if (polls % 60 === 0 && !locator.stillValid()) { locator.invalidate(); state.saveBase = -1; updateTrackPill('searching'); return; }

  if (state.saveBase < 0) {
    if (polls % 4 !== 0) return; // full RAM scan: only every couple of seconds
    const ram = locator.read(0, PsxMemory.PSX_RAM_SIZE);
    if (!ram) return;
    state.saveBase = FF7Track.findSave(ram, -1);
    updateTrackPill();
    if (state.saveBase < 0) return;
    toast('Auto-tracking connected to your save data.');
  }
  const block = locator.read(state.saveBase, FF7Track.SAVE_SIZE);
  if (!block || !FF7Track.looksLikeSave(block, 0)) { state.saveBase = -1; updateTrackPill(); return; }
  state.live = FF7Track.readSave(block);

  let changed = false;
  for (const t of allTiles()) {
    if (state.auto.has(t.name) || !state.live.materia.has(tileId(t))) continue;
    state.auto.add(t.name);
    changed = true;
    const tile = document.querySelector(`.tile[data-id="${CSS.escape(t.name)}"]`);
    if (tile) { tile.classList.remove('flash'); void tile.offsetWidth; tile.classList.add('flash'); }
  }
  if (changed) saveTracker();
  renderTracker();
}
setInterval(pollMemory, 500);

// ------------------------------------------------------------------ timer
function currentElapsed() { return state.timer.acc + (state.timer.running ? performance.now() - state.timer.start : 0); }
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
$('timerReset').addEventListener('click', () => { state.timer = { running: false, start: 0, acc: 0 }; renderTimer(); saveTracker(); });
setInterval(() => { if (state.timer.running) $('timerDisplay').textContent = fmt(currentElapsed()); }, 100);

// ------------------------------------------------------------------ emulator
const displayHz = new Promise((resolve) => {
  let n = 0, t0 = 0;
  const tick = (t) => {
    if (!t0) t0 = t;
    if (++n >= 90) return resolve(Math.round(((n - 1) * 1000) / (t - t0)));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

async function play(seedId, label, disc = 1) {
  const sameRun = state.current && state.current.seedId === seedId;
  if (state.emu === 'running') saveTracker();
  try {
    const info = await hub.ff7.load(seedId, disc);
    state.current = { seedId, label, disc };
    if (!sameRun) loadTracker();
    locator.reset(info.probes);
    state.saveBase = -1;
    const hz = state.lastDisplayHz || await displayHz;
    const q = new URLSearchParams({
      core: info.core, game: info.gameUrl, bios: info.biosUrl, name: info.saveName, data: info.dataPath,
      hz, pacing: state.settings.framePacing === 'off' ? 'off' : 'auto',
    });
    const frame = $('emuFrame');
    frame.hidden = false;
    $('emptyState').hidden = true;
    frame.src = `emu.html?${q}`;
    frame.focus();
    state.emu = 'loading';
    setPill('emuStatus', 'loading', 'Loading…');
    $('nowPlaying').innerHTML = '';
    $('nowPlaying').append('Now playing: ', el('b', {}, label), ` · Disc ${disc}`);
    $('stopGame').disabled = false;
    $('fullscreen').disabled = false;
    renderDiscBtns();
    renderSeeds();
    showTab('tracker');
  } catch (e) {
    toast(cleanErr(e), true);
    if (/Settings/.test(cleanErr(e))) showTab('settings');
  }
}

function renderDiscBtns() {
  document.querySelectorAll('#discBtns .seg-btn').forEach((b) => {
    const n = Number(b.dataset.disc);
    b.disabled = !state.current || !state.settings.games.ff7.discs[n - 1];
    b.classList.toggle('active', !!state.current && state.current.disc === n);
  });
}
document.querySelectorAll('#discBtns .seg-btn').forEach((b) => b.addEventListener('click', () => {
  const n = Number(b.dataset.disc);
  if (!state.current || state.current.disc === n) return;
  if (!confirm(`Change to Disc ${n}?\n\nSave to your memory card in-game first. The emulator restarts with Disc ${n}; choose Continue on the title screen and load your save.`)) return;
  play(state.current.seedId, state.current.label, n);
}));

window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || !e.data) return;
  if (e.data.type === 'emu:started') { state.emu = 'running'; setPill('emuStatus', 'running', 'Running'); updateTrackPill(); }
  if (e.data.type === 'emu:ready') updateTrackPill();
  if (e.data.type === 'emu:display') {
    const { fps } = e.data;
    state.lastDisplayHz = fps;
    setPill('displayFps', fps < 50 ? 'error' : 'live', `Screen ${fps} Hz`);
  }
  if (e.data.type === 'emu:error') { state.emu = 'error'; setPill('emuStatus', 'error', 'Emulator failed to load'); }
});
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
  state.saveBase = -1;
  setPill('emuStatus', 'idle', 'Emulator idle');
  setPill('displayFps', 'off', 'Display — fps');
  updateTrackPill();
  $('nowPlaying').textContent = 'No game loaded';
  $('stopGame').disabled = true;
  $('fullscreen').disabled = true;
  renderDiscBtns();
  renderSeeds();
}
$('stopGame').addEventListener('click', () => { if (confirm('Stop the game? Progress not saved to the memory card is lost.')) stop(); });
$('fullscreen').addEventListener('click', () => $('emuFrame').requestFullscreen().catch(() => {}));
$('playVanilla').addEventListener('click', () => play(null, 'Vanilla', 1));
$('quickSeed').addEventListener('click', () => { showTab('seeds'); $('seedInput').value = ''; $('seedForm').requestSubmit(); });

// ------------------------------------------------------------------ seeds
const MULTS = [1, 1.5, 2, 3, 4];
function readOptions() {
  const o = {};
  document.querySelectorAll('[data-opt]').forEach((x) => {
    const k = x.dataset.opt;
    o[k] = x.type === 'checkbox' ? x.checked : /Mult$/.test(k) ? Number(x.value) : x.value;
  });
  return o;
}
function writeOptions(o) {
  document.querySelectorAll('[data-opt]').forEach((x) => {
    const v = o[x.dataset.opt];
    if (v === undefined) return;
    if (x.type === 'checkbox') x.checked = !!v; else x.value = String(v);
  });
}
function buildSeedForm() {
  document.querySelectorAll('select[data-opt$="Mult"]').forEach((s) => {
    s.innerHTML = '';
    for (const m of MULTS) s.append(el('option', { value: String(m) }, `×${m}`));
  });
  const sel = $('preset');
  sel.innerHTML = '';
  for (const [id, p] of Object.entries(state.presets.presets)) sel.append(el('option', { value: id }, p.label));
  sel.append(el('option', { value: 'custom' }, 'Custom'));
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('ff7:options') || 'null'); } catch (_) { /* ignore */ }
  const presetId = localStorage.getItem('ff7:preset') || 'standard';
  sel.value = presetId;
  writeOptions(presetId === 'custom' && saved ? saved : (state.presets.presets[presetId] || {}).options || state.presets.defaults);
  sel.addEventListener('change', () => {
    localStorage.setItem('ff7:preset', sel.value);
    if (sel.value !== 'custom') writeOptions(state.presets.presets[sel.value].options);
  });
  document.querySelectorAll('[data-opt]').forEach((x) => x.addEventListener('change', () => {
    sel.value = 'custom';
    localStorage.setItem('ff7:preset', 'custom');
    localStorage.setItem('ff7:options', JSON.stringify(readOptions()));
  }));
}

$('diceSeed').addEventListener('click', async () => { $('seedInput').value = await hub.randomSeed(); });

$('seedForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('generateBtn');
  const log = $('seedLog');
  log.hidden = false; log.textContent = '';
  btn.disabled = true; btn.textContent = 'Generating…';
  const off = hub.onRandoLog((line) => { log.textContent += line + '\n'; log.scrollTop = log.scrollHeight; });
  try {
    const sel = $('preset');
    const entry = await hub.ff7.generate({
      seed: $('seedInput').value,
      options: readOptions(),
      presetLabel: sel.options[sel.selectedIndex].textContent,
      spoiler: $('spoilerOn').checked,
    });
    await loadSeeds();
    toast(`Seed ${entry.seed} ready.`);
    play(entry.id, `${entry.preset} · ${entry.seed}`, 1);
  } catch (err) {
    const msg = cleanErr(err);
    log.textContent += '\n' + msg;
    toast(msg.split('\n')[0], true);
    if (/Settings/.test(msg)) showTab('settings');
  } finally {
    off();
    btn.disabled = false; btn.textContent = 'Generate seed';
  }
});

async function loadSeeds() { state.seeds = await hub.listSeeds(GAME_ID); renderSeeds(); }

function optionChips(o) {
  if (!o) return [];
  const c = [];
  if (o.startMateria !== 'vanilla') c.push(`Materia: ${o.startMateria}`);
  if (o.startGear !== 'vanilla') c.push(`Gear: ${o.startGear}`);
  if (o.drops !== 'vanilla') c.push(`Drops: ${o.drops}`);
  if (o.slots !== 'vanilla') c.push('Slots shuffled');
  for (const [k, l] of [['expMult', 'EXP'], ['apMult', 'AP'], ['gilMult', 'Gil']]) if (o[k] !== 1) c.push(`${l} ×${o[k]}`);
  return c;
}

function renderSeeds() {
  const ul = $('seedList');
  ul.innerHTML = '';
  if (!state.seeds.length) { ul.append(el('li', { class: 'empty-note' }, 'No seeds yet. Generate one above.')); return; }
  for (const s of state.seeds) {
    const isCur = state.current && state.current.seedId === s.id;
    const label = `${s.preset} · ${s.seed}`;
    ul.append(el('li', { class: isCur ? 'current' : '' },
      el('div', { class: 'meta' },
        el('div', {}, el('div', { class: 'seed-name' }, s.seed), el('div', { class: 'seed-preset' }, s.preset),
          el('div', { class: 'chips' }, optionChips(s.options).map((t) => el('span', { class: 'chip' }, t)))),
        el('div', { class: 'seed-date' }, new Date(s.created).toLocaleString())),
      el('div', { class: 'actions' },
        el('button', { class: 'btn small primary', onclick: () => play(s.id, label, 1) }, isCur ? 'Restart' : 'Play'),
        el('button', { class: 'btn small', onclick: () => openSpoiler(s) }, 'Spoiler'),
        el('button', { class: 'btn small', title: 'Save full patched .bin/.cue files for another emulator', onclick: async () => {
          const log = $('seedLog'); log.hidden = false; log.textContent = '';
          const off = hub.onRandoLog((line) => { log.textContent += line + '\n'; });
          try { const w = await hub.ff7.exportSeed(s.id); if (w && w.length) toast(`Saved ${w.length} disc(s).`); }
          catch (e) { toast(cleanErr(e), true); } finally { off(); }
        } }, 'Export'),
        el('button', { class: 'btn small', onclick: () => hub.showInFolder(`${s.dir}/disc1.prhp`) }, 'Folder'),
        el('button', { class: 'btn small ghost', onclick: async () => {
          if (isCur) return toast('Stop the game before deleting this seed.', true);
          if (!confirm(`Delete seed ${s.seed}?`)) return;
          await hub.deleteSeed(s.id); localStorage.removeItem(`tracker:${GAME_ID}:${s.id}`); loadSeeds();
        } }, 'Delete'))));
  }
}

async function openSpoiler(s) {
  const text = await hub.spoiler(s.id);
  $('spoilerTitle').textContent = `Spoiler log — ${s.preset} · ${s.seed}`;
  const pre = $('spoilerText');
  pre.textContent = text || '(No spoiler log — it was turned off for this seed.)';
  pre.classList.add('blurred');
  $('revealSpoiler').hidden = false;
  $('spoilerDialog').showModal();
}
$('revealSpoiler').addEventListener('click', () => { $('spoilerText').classList.remove('blurred'); $('revealSpoiler').hidden = true; });

// ------------------------------------------------------------------ settings
async function renderSettings() {
  const s = state.settings;
  $('biosPath').textContent = s.biosPath || 'Not set';
  $('seedsPath').textContent = s.seedsDir;
  $('coreSelect').value = s.core;
  $('autoTrack').checked = s.autoTrack !== false;

  const bb = $('biosBadge');
  if (s.biosPath) {
    const r = await hub.checkBios(s.biosPath);
    bb.className = 'badge ' + (r.ok ? 'ok' : 'warn');
    bb.textContent = r.ok ? 'OK' : (r.error ? 'Missing' : 'Unexpected size');
    state.biosOk = !!r.ok || !r.error;
  } else { bb.className = 'badge bad'; bb.textContent = 'Required'; state.biosOk = false; }

  const discs = s.games.ff7.discs;
  state.discChecks = await hub.ff7.checkDiscs();
  state.discChecks.forEach((r, i) => {
    const box = document.querySelector(`[data-disc-setting="${i + 1}"]`);
    box.querySelector('.path').textContent = discs[i] || 'Not set';
    const b = box.querySelector('.badge');
    b.title = '';
    if (!r.set) { b.className = 'badge ' + (i === 0 ? 'bad' : 'warn'); b.textContent = i === 0 ? 'Required' : 'Not set'; }
    else if (!r.ok) { b.className = 'badge bad'; b.textContent = 'Unreadable'; b.title = r.error; }
    else if (!r.matches) { b.className = 'badge warn'; b.textContent = `Found ${r.exeName}`; b.title = `Expected ${r.expected}`; }
    else { b.className = 'badge ok'; b.textContent = r.exeName; }
  });
  state.names = await hub.ff7.names();
  const d1 = state.discChecks[0];
  const note = $('featureNote');
  if (d1 && d1.ok && d1.features) {
    const off = Object.entries(d1.features).filter(([, v]) => !v).map(([k]) => k);
    note.textContent = off.length ? `Your Disc 1 didn't pass the checks for: ${off.join(', ')}. Those options will be skipped.` : '';
  } else note.textContent = '';
  renderChecklist();
}

function renderChecklist() {
  const ul = $('setupChecklist');
  ul.innerHTML = '';
  const d = state.discChecks;
  const discOk = (i) => d[i] && d[i].set && d[i].ok;
  const items = [
    [state.biosOk, 'PlayStation BIOS selected'],
    [discOk(0), 'Final Fantasy VII Disc 1 selected'],
    [discOk(1) && discOk(2), 'Discs 2 and 3 selected (needed later in the game)'],
  ];
  for (const [ok, label] of items) ul.append(el('li', { class: ok ? 'done' : '' }, label));
  const ready = state.biosOk && discOk(0);
  $('playVanilla').disabled = !ready;
  $('quickSeed').disabled = !ready;
}

$('pickBios').addEventListener('click', async () => {
  const p = await hub.pickFile('Choose PlayStation BIOS', [{ name: 'BIOS', extensions: ['bin', 'rom', 'BIN'] }, { name: 'All files', extensions: ['*'] }]);
  if (!p) return;
  state.settings = await hub.setSettings({ biosPath: p });
  renderSettings();
});
document.querySelectorAll('[data-disc-setting]').forEach((box) => {
  const n = Number(box.dataset.discSetting);
  box.querySelector('button').addEventListener('click', async () => {
    const p = await hub.pickFile(`Choose Final Fantasy VII Disc ${n}`, [{ name: 'Disc image', extensions: ['bin', 'iso', 'img', 'cue'] }, { name: 'All files', extensions: ['*'] }]);
    if (!p) return;
    const resolved = await hub.ff7.resolveCue(p).catch(() => p);
    const discs = [...state.settings.games.ff7.discs];
    discs[n - 1] = resolved;
    state.settings = await hub.setSettings({ games: { ff7: { ...state.settings.games.ff7, discs } } });
    renderSettings();
  });
});
$('coreSelect').addEventListener('change', async (e) => {
  state.settings = await hub.setSettings({ core: e.target.value });
  toast('Takes effect next time you start a game.');
});

window.addEventListener('beforeunload', () => saveTracker());

// ------------------------------------------------------------------ boot
(async function init() {
  state.settings = await hub.getSettings();
  if (!state.settings.games.ff7) state.settings.games.ff7 = { discs: ['', '', ''] };
  state.def = await hub.gameDef(GAME_ID);
  state.presets = await hub.ff7.presets();
  buildTracker();
  buildSeedForm();
  loadTracker();
  await renderSettings();
  await loadSeeds();
  renderDiscBtns();
  updateTrackPill();
})();
