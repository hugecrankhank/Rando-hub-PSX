'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, arg) => ipcRenderer.invoke(ch, arg);

contextBridge.exposeInMainWorld('hub', {
  getSettings: () => invoke('settings:get'),
  setSettings: (patch) => invoke('settings:set', patch),
  pickFile: (title, filters) => invoke('dialog:file', { title, filters }),
  pickDir: (title) => invoke('dialog:dir', { title }),
  checkBios: (p) => invoke('bios:check', p),
  checkDisc: (gameId, p) => invoke('disc:check', { gameId, path: p }),
  gameDef: (id) => invoke('game:def', id),
  loadGame: (gameId, p, seedId) => invoke('game:load', { gameId, path: p, seedId }),
  randoStatus: (gameId) => invoke('rando:status', gameId),
  randomSeed: () => invoke('rando:randomSeed'),
  mapModel: (presetId) => invoke('map:model', presetId),
  gameOptions: () => invoke('rando:options'),
  generate: (opts) => invoke('rando:generate', opts),
  onRandoLog: (cb) => {
    const h = (_e, line) => cb(line);
    ipcRenderer.on('rando:log', h);
    return () => ipcRenderer.removeListener('rando:log', h);
  },
  listSeeds: (gameId) => invoke('seeds:list', gameId),
  license: {
    get: () => invoke('license:get'),
    check: () => invoke('license:check'),
    checkForUpdates: () => invoke('license:updates'),
    onChange: (cb) => ipcRenderer.on('license:state', (_e, v) => cb(v)),
  },
  // Multi-disc games with our own generators: hub.ff7, hub.ff8 (same calls, own channels).
  ff7: {
    checkDiscs: () => invoke('ff7:checkDiscs'),
    names: () => invoke('ff7:names'),
    presets: () => invoke('ff7:presets'),
    resolveCue: (p) => invoke('ff7:resolveCue', p),
    generate: (opts) => invoke('ff7:generate', opts),
    load: (seedId, disc) => invoke('ff7:load', { seedId, disc }),
    exportSeed: (seedId) => invoke('ff7:export', seedId),
  },
  ff8: {
    checkDiscs: () => invoke('ff8:checkDiscs'),
    names: () => invoke('ff8:names'),
    presets: () => invoke('ff8:presets'),
    resolveCue: (p) => invoke('ff8:resolveCue', p),
    generate: (opts) => invoke('ff8:generate', opts),
    load: (seedId, disc) => invoke('ff8:load', { seedId, disc }),
    exportSeed: (seedId) => invoke('ff8:export', seedId),
  },
  spoiler: (id) => invoke('seeds:spoiler', id),
  deleteSeed: (id) => invoke('seeds:delete', id),
  openPopout: () => invoke('popout:open'),
  sendPopoutState: (st) => ipcRenderer.send('popout:state', st),
  getPopout: () => invoke('popout:get'),
  setPopoutPrefs: (p) => invoke('popout:prefs', p),
  onPopoutState: (cb) => ipcRenderer.on('popout:state', (_e, st) => cb(st)),
  onPopoutClosed: (cb) => ipcRenderer.on('popout:closed', () => cb()),
  showInFolder: (p) => invoke('shell:show', p),
  openExternal: (url) => invoke('shell:open', url),
});
