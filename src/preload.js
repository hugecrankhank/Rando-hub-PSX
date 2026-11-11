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
  generate: (opts) => invoke('rando:generate', opts),
  onRandoLog: (cb) => {
    const h = (_e, line) => cb(line);
    ipcRenderer.on('rando:log', h);
    return () => ipcRenderer.removeListener('rando:log', h);
  },
  listSeeds: () => invoke('seeds:list'),
  spoiler: (id) => invoke('seeds:spoiler', id),
  deleteSeed: (id) => invoke('seeds:delete', id),
  showInFolder: (p) => invoke('shell:show', p),
  openExternal: (url) => invoke('shell:open', url),
});
