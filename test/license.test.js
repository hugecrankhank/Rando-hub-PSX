// License checks with a fake server (no network).
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLicense, newer, GRACE } = require('../src/license');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lic-'));
const here = path.join(tmp, 'app'), ud = path.join(tmp, 'ud');
fs.mkdirSync(here); fs.mkdirSync(ud);
const app = { getPath: () => ud, quit() {} };
let answer = null; let calls = [];
const fetch = async (url, o) => {
  calls.push({ url, body: o && o.body && JSON.parse(o.body) });
  if (answer instanceof Error) throw answer;
  return { json: async () => answer };
};
const make = (extra = {}) => createLicense({ app, fetch, here, dev: false, version: '0.2.0', ...extra });

(async () => {
  assert.ok(newer('0.10.0', '0.9.9') && !newer('0.2.0', '0.2.0') && !newer('0.1.9', '0.2.0'));

  // No license.json: locked.
  let L = make();
  assert.strictEqual(L.view().state, 'missing');
  assert.ok(!L.enabled());

  // Developer copy: always on, never calls out.
  L = make({ dev: true });
  assert.ok(L.enabled());
  await L.check();
  assert.strictEqual(calls.length, 0);

  fs.writeFileSync(path.join(here, 'license.json'), JSON.stringify({ name: 'Kallax', build: 'ABC123', token: 't'.repeat(32), server: 'https://rando-hub.example' }));

  // First run: checking until the server answers.
  L = make();
  assert.strictEqual(L.view().state, 'checking');
  assert.ok(!L.enabled());
  answer = { ok: true, name: 'Kallax', latest: { version: '0.2.0' } };
  await L.check();
  assert.ok(L.enabled());
  assert.strictEqual(calls[0].url, 'https://rando-hub.example/api/license/psx');
  assert.deepStrictEqual(calls[0].body, { token: 't'.repeat(32), version: '0.2.0', build: 'ABC123' });

  // Next launch, offline: still works on the last good check.
  answer = new Error('offline');
  L = make();
  assert.ok(L.enabled(), 'grace at start');
  await L.check();
  assert.strictEqual(L.view().state, 'offline');
  assert.ok(L.enabled());

  // Grace runs out after 3 days.
  const sf = path.join(ud, 'license-state.json');
  fs.writeFileSync(sf, JSON.stringify({ okAt: Date.now() - GRACE - 1000, name: 'Kallax', build: 'ABC123' }));
  L = make();
  await L.check();
  assert.strictEqual(L.view().state, 'off');
  assert.ok(!L.enabled());

  // Turned off on the server: locks at once, and no grace next time.
  answer = { ok: true, name: 'Kallax' }; L = make(); await L.check(); assert.ok(L.enabled());
  answer = { ok: false, reason: 'PSX Rando Hub isn’t switched on for this license.' };
  await L.check();
  assert.ok(!L.enabled());
  assert.match(L.view().reason, /switched on/);
  answer = new Error('offline');
  L = make(); assert.ok(!L.enabled());

  // A different copy's state file doesn't grant grace.
  fs.writeFileSync(sf, JSON.stringify({ okAt: Date.now(), name: 'Someone', build: 'OTHER1' }));
  L = make(); assert.strictEqual(L.view().state, 'checking');

  // Check for updates when already newest.
  answer = { ok: true, name: 'Kallax', latest: { version: '0.2.0' } };
  L = make(); const v = await L.checkForUpdates();
  assert.strictEqual(v.update.state, 'latest');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('license.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
