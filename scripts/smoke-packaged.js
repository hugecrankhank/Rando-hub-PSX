// CI smoke test: run inside the PACKAGED app in node mode, e.g.
//   ELECTRON_RUN_AS_NODE=1 "dist/win-unpacked/PSX Rando Hub.exe" scripts/smoke-packaged.js
// This reproduces exactly how the installed hub launches the randomizer, and does a
// dry-run seed (no -i/-o), so no game files are needed.
'use strict';
const path = require('path');
const { Randomizer, runNode } = require('../src/randomizer');

(async () => {
  console.log('electron', process.versions.electron, 'defaultApp', process.defaultApp);
  const dir = path.join(__dirname, '..', 'vendor', 'sotn-randomizer');
  const r = new Randomizer(dir);
  if (!r.isInstalled()) throw new Error('randomizer not found at ' + dir);
  const res = await runNode(r.entry(), ['-s', 'SMOKETEST', '-p', 'safe', '-vv'], dir);
  console.log(res.out.slice(0, 3000));
  if (res.code !== 0) { console.error('FAILED with code', res.code); process.exit(1); }
  if (/not url seed/.test(res.out)) { console.error('FAILED: argv bug'); process.exit(1); }
  console.log('Packaged randomizer smoke test passed.');
})().catch((e) => { console.error(e); process.exit(1); });
