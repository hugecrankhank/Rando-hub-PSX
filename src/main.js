'use strict';

const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { inspectDisc } = require('./disc');
const { Randomizer } = require('./randomizer');
const { prepareDiscZip } = require('./zipdisc');
const { loadMapModel } = require('./sotn-map');

const ROOT = path.join(__dirname, '..');
const UI_DIR = path.join(ROOT, 'ui');
const GAMES_DIR = path.join(ROOT, 'games');
const VENDOR_DIR = app.isPackaged ? path.join(process.resourcesPath, 'vendor') : path.join(ROOT, 'vendor');
const EJS_CDN = 'https://cdn.emulatorjs.org/stable/data/';

// Keep the emulator at full frame rate: don't let Chromium throttle timers or
// rendering when the window isn't focused, or slow down to save power.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('force_high_performance_gpu');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// ---------------------------------------------------------------- settings
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const DEFAULTS = () => ({
  biosPath: '',
  games: { sotn: { vanillaBin: '' } },
  seedsDir: path.join(app.getPath('userData'), 'seeds'),
  randomizerDir: path.join(VENDOR_DIR, 'sotn-randomizer'),
  emulatorData: 'cache', // 'cache' = download once then offline; 'cdn' = always refresh from CDN
  core: 'psx',
  autoTrack: true,
  seeds: [],
});

let settings;
function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'));
    settings = { ...DEFAULTS(), ...saved, games: { ...DEFAULTS().games, ...(saved.games || {}) } };
  } catch (_) {
    settings = DEFAULTS();
  }
}
function saveSettings() {
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2));
}

// ---------------------------------------------------------------- state
let win;
let currentGame = null; // { path, name, gameId, seedId }
const loadGameDef = (id) => JSON.parse(fs.readFileSync(path.join(GAMES_DIR, `${id}.json`), 'utf8'));
const randomizer = () => new Randomizer(settings.randomizerDir);

// ---------------------------------------------------------------- protocol
function fileResponse(p) {
  if (!p || !fs.existsSync(p)) return new Response('Not found', { status: 404 });
  return net.fetch(pathToFileURL(p).toString());
}

function safeJoin(base, rel) {
  const p = path.normalize(path.join(base, decodeURIComponent(rel)));
  return p.startsWith(base) ? p : null;
}

// EmulatorJS files: served from a bundled copy if present, else downloaded once from the
// EmulatorJS CDN and cached in the user folder so later sessions work offline.
const ejsInflight = new Map();
async function emulatorFile(rel) {
  const bundled = safeJoin(path.join(VENDOR_DIR, 'emulatorjs', 'data'), rel);
  if (bundled && fs.existsSync(bundled)) return fileResponse(bundled);
  const cacheRoot = path.join(app.getPath('userData'), 'emulatorjs-cache');
  const cached = safeJoin(cacheRoot, rel);
  if (!cached) return new Response('Bad path', { status: 400 });
  if (settings.emulatorData !== 'cdn' && fs.existsSync(cached)) return fileResponse(cached);
  if (!ejsInflight.has(cached)) {
    ejsInflight.set(cached, (async () => {
      const res = await net.fetch(EJS_CDN + rel);
      if (!res.ok) return { status: res.status };
      const buf = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(path.dirname(cached), { recursive: true });
      fs.writeFileSync(cached + '.part', buf);
      fs.renameSync(cached + '.part', cached);
      return { status: 200 };
    })().finally(() => setTimeout(() => ejsInflight.delete(cached), 1000)));
  }
  try {
    const r = await ejsInflight.get(cached);
    if (r.status !== 200) return new Response('Not found', { status: r.status });
    return fileResponse(cached);
  } catch (e) {
    return fs.existsSync(cached) ? fileResponse(cached) : new Response(String(e), { status: 502 });
  }
}

const srtDir = () => settings.srtDir || path.join(VENDOR_DIR, 'sotnrandotools');

function registerProtocol() {
  protocol.handle('app', (req) => {
    const url = new URL(req.url);
    const rel = url.pathname.replace(/^\/+/, '');
    switch (url.host) {
      case 'ui': return fileResponse(safeJoin(UI_DIR, rel || 'index.html'));
      case 'games': return fileResponse(safeJoin(GAMES_DIR, rel));
      case 'ejs': return emulatorFile(rel);
      case 'srt': return fileResponse(safeJoin(srtDir(), rel));
      case 'media':
        if (rel.startsWith('bios')) return fileResponse(settings.biosPath);
        if (rel.startsWith('gamezip')) {
          const z = currentGame && currentGame.zip;
          if (!z) return new Response('Not found', { status: 404 });
          return new Response(z.stream(), { headers: { 'Content-Type': 'application/zip', 'Content-Length': String(z.size) } });
        }
        if (rel.startsWith('game')) return fileResponse(currentGame && currentGame.path);
        return new Response('Not found', { status: 404 });
      default: return new Response('Not found', { status: 404 });
    }
  });
}

// ---------------------------------------------------------------- window
function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: '#0d0b10',
    title: 'PSX Rando Hub',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadURL('app://ui/index.html');
  if (process.argv.includes('--devtools')) win.webContents.openDevTools({ mode: 'detach' });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
}

// ---------------------------------------------------------------- helpers
function randomSeed() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(10), (b) => alphabet[b % alphabet.length]).join('');
}

function checkVanilla(gameId, p) {
  const def = loadGameDef(gameId);
  const info = inspectDisc(p);
  const ok = def.bootExeAliases.some((a) => a.toUpperCase() === info.exeName);
  return { ...info, matches: ok, expected: def.serial };
}

function sanitize(s) {
  return String(s).replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40);
}

// ---------------------------------------------------------------- IPC
function registerIpc() {
  ipcMain.handle('settings:get', () => ({ ...settings, vendorDir: VENDOR_DIR, ejsCdn: EJS_CDN }));
  ipcMain.handle('settings:set', (_e, patch) => {
    settings = { ...settings, ...patch, games: { ...settings.games, ...(patch.games || {}) } };
    saveSettings();
    return settings;
  });

  ipcMain.handle('dialog:file', async (_e, { title, filters }) => {
    const r = await dialog.showOpenDialog(win, { title, properties: ['openFile'], filters });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:dir', async (_e, { title }) => {
    const r = await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('bios:check', (_e, p) => {
    try {
      const size = fs.statSync(p).size;
      return { ok: size === 512 * 1024, size };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  ipcMain.handle('disc:check', (_e, { gameId, path: p }) => {
    try { return { ok: true, ...checkVanilla(gameId, p) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('game:def', (_e, id) => loadGameDef(id));

  // Point the emulator at a disc image and return what the tracker needs.
  ipcMain.handle('game:load', async (_e, { gameId, path: p, seedId }) => {
    if (!settings.biosPath || !fs.existsSync(settings.biosPath)) throw new Error('Pick your PlayStation BIOS in Settings first.');
    if (!p || !fs.existsSync(p)) throw new Error('Disc image not found.');
    const info = inspectDisc(p);
    currentGame = { path: p, gameId, seedId: seedId || null };
    const token = crypto.randomBytes(4).toString('hex'); // cache-buster per load
    // Beetle PSX won't open a bare .bin; give it bin + cue in one stored zip.
    const needsCue = /^mednafen_psx/.test(settings.core);
    if (needsCue) currentGame.zip = await prepareDiscZip(p, path.join(app.getPath('userData'), 'crc-cache.json'));
    return {
      gameUrl: needsCue
        ? `app://media/gamezip/${token}/game.zip`
        : `app://media/game/${token}/${path.basename(p).replace(/[^A-Za-z0-9._-]/g, '_')}`,
      // Served under a canonical name: the PS1 cores look for scphXXXX.bin in their system dir,
      // and fall back to a less compatible HLE BIOS if the name doesn't match.
      biosUrl: `app://media/bios/${token}/scph5501.bin`,
      saveName: seedId ? `${gameId}-${seedId}` : `${gameId}-vanilla`,
      probes: info.probes,
      exeName: info.exeName,
      core: settings.core,
      dataPath: 'app://ejs/',
    };
  });

  ipcMain.handle('rando:status', (_e, gameId) => {
    const def = loadGameDef(gameId);
    const r = randomizer();
    return {
      installed: r.isInstalled(),
      dir: settings.randomizerDir,
      presets: r.isInstalled() ? r.presets(def.randomizer.fallbackPresets) : def.randomizer.fallbackPresets,
      defaultPreset: def.randomizer.defaultPreset,
    };
  });

  ipcMain.handle('rando:randomSeed', () => randomSeed());
  ipcMain.handle('rando:options', async () => {
    try { return await randomizer().gameOptions(); } catch (_) { return []; }
  });

  // Map tracker: locations + logic for a preset (null preset = classic, no logic).
  ipcMain.handle('map:model', (_e, presetId) => {
    const dir = srtDir();
    const ok = fs.existsSync(path.join(dir, 'Extensions'));
    if (!ok) return { available: false };
    const model = loadMapModel({ srtDir: dir, randoPresetsDir: path.join(settings.randomizerDir, 'presets'), presetId });
    return {
      available: true,
      hasIcons: fs.existsSync(path.join(dir, 'Images', 'texture.png')),
      ...model,
    };
  });

  ipcMain.handle('rando:generate', async (e, opts) => {
    const vanilla = settings.games[opts.gameId] && settings.games[opts.gameId].vanillaBin;
    if (!vanilla || !fs.existsSync(vanilla)) throw new Error('Pick your vanilla SOTN Track 1 .bin in Settings first.');
    const seed = (opts.seed || '').trim() || randomSeed();
    const preset = opts.preset || 'safe';
    const id = `${sanitize(preset)}-${sanitize(seed)}-${Date.now().toString(36)}`;
    const dir = path.join(settings.seedsDir, id);
    const outBin = path.join(dir, `SOTN-${sanitize(preset)}-${sanitize(seed)}.bin`);
    const send = (line) => e.sender.send('rando:log', line);
    send(`Generating seed "${seed}" with preset "${preset}"…`);
    const res = await randomizer().generate({
      vanillaBin: vanilla, outBin, seed, preset,
      tournament: !!opts.tournament,
      spoilerLevel: opts.spoilerLevel,
      flags: Array.isArray(opts.flags) ? opts.flags : [],
      extraArgs: opts.extraArgs,
    }, send);
    fs.writeFileSync(path.join(dir, 'spoiler.txt'), res.log);
    // Optional .cue for use in other emulators (single data track).
    fs.writeFileSync(path.join(dir, path.basename(outBin, '.bin') + '.cue'),
      `FILE "${path.basename(outBin)}" BINARY\r\n  TRACK 01 MODE2/2352\r\n    INDEX 01 00:00:00\r\n`);
    const entry = {
      id, gameId: opts.gameId, seed, preset, tournament: !!opts.tournament,
      flags: Array.isArray(opts.flags) ? opts.flags : [],
      created: new Date().toISOString(), bin: outBin, dir,
    };
    settings.seeds = [entry, ...(settings.seeds || [])].slice(0, 200);
    saveSettings();
    send('Done.');
    return entry;
  });

  ipcMain.handle('seeds:list', () => (settings.seeds || []).filter((s) => fs.existsSync(s.bin)));
  ipcMain.handle('seeds:spoiler', (_e, id) => {
    const s = (settings.seeds || []).find((x) => x.id === id);
    if (!s) return '';
    try { return fs.readFileSync(path.join(s.dir, 'spoiler.txt'), 'utf8'); } catch (_) { return ''; }
  });
  ipcMain.handle('seeds:delete', async (_e, id) => {
    const s = (settings.seeds || []).find((x) => x.id === id);
    if (!s) return false;
    await fs.promises.rm(s.dir, { recursive: true, force: true });
    settings.seeds = settings.seeds.filter((x) => x.id !== id);
    saveSettings();
    return true;
  });
  ipcMain.handle('shell:show', (_e, p) => { if (p) shell.showItemInFolder(p); });
  ipcMain.handle('shell:open', (_e, url) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
  });
}

app.whenReady().then(() => {
  loadSettings();
  registerProtocol();
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
