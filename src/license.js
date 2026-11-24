// PSX Rando Hub's license and updates (Hank, Nov 2026), the same way Crowd Control+ does it.
//
// A copy downloaded from Rando Hub (/download/, for a license Hank has authorized for PSX Rando Hub) has
// license.json next to the .exe: { name, build, token, server, site }. The app asks the server about that token
// (POST <server>/api/license/psx { token, version, build }) when it starts and every 30 minutes:
//   ok                   it works; the answer also says the newest version (installed by itself when the app starts)
//   not ok (turned off)  the app locks and says why, until a check says ok again
//   no answer (offline)  it keeps working for 3 days from its last good check, then locks until it can check again
// Nothing else is sent: the token, this copy's version and its build.
//
// An update (GET <server>/api/license/psx-download?token=…) is the same zip as the download: "PSX Rando Hub Setup.exe"
// with the same license.json beside it. It's unpacked to a temporary folder, then a small script waits for the app to
// close and runs the installer silently (/S --force-run: same folder as before, copies license.json, reopens the app).
// Settings, seeds and saves live in the user folder and stay.
//
// Running from the repository (npm start) needs no license.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const GRACE = 3 * 24 * 3600 * 1000;
const EVERY = 30 * 60 * 1000;
const SETUP = 'PSX Rando Hub Setup.exe';

const newer = (a, b) => {
  const x = String(a || '').split('.').map(Number), y = String(b || '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

/**
 * opts: { app, fetch, here, dev, version, onChange, log }
 * `here` is the folder with the .exe (and license.json); `fetch` is Electron's net.fetch (uses the system proxy).
 */
function createLicense({ app, fetch, here, dev, version, onChange = () => {}, log = () => {} }) {
  const file = path.join(here, 'license.json');
  const stateFile = path.join(app.getPath('userData'), 'license-state.json');
  let lic = null;
  const readLic = () => {
    try { const l = JSON.parse(fs.readFileSync(file, 'utf8')); lic = l && l.token && l.server ? l : null; } catch (_) { lic = null; }
  };
  readLic();
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {}; } catch (_) { /* first run */ }
  if (lic && saved.build && saved.build !== lic.build) saved = {}; // (a different copy's grace doesn't carry over)

  const st = {
    state: dev ? 'dev' : !lic ? 'missing' : saved.okAt && Date.now() - saved.okAt < GRACE ? 'ok' : 'checking',
    name: (lic && lic.name) || saved.name || '', build: (lic && lic.build) || '', server: (lic && lic.server) || '',
    reason: '', version, latest: '', checkedAt: 0, okAt: saved.okAt || 0,
    update: { state: '', version: '', error: '', progress: 0 }, // '' / checking / downloading / installing / done / failed / latest
  };
  if (st.state === 'missing') st.reason = 'This copy has no license. Download PSX Rando Hub from Rando Hub (the /download/ page on the site, signed in with your key).';

  const enabled = () => st.state === 'dev' || st.state === 'ok' || st.state === 'offline';
  const view = () => ({ ...st, update: { ...st.update }, enabled: enabled() });
  const changed = () => { try { onChange(view()); } catch (_) { /* ignore */ } };
  const setUpdate = (u) => { st.update = { state: '', version: '', error: '', progress: 0, ...u }; changed(); };

  let busy = null;
  async function check({ update = false } = {}) {
    if (st.state === 'dev') return view();
    readLic(); // (a new license.json dropped in)
    if (!lic) { st.state = 'missing'; changed(); return view(); }
    st.build = lic.build || ''; st.server = lic.server;
    if (busy) return busy;
    busy = (async () => {
      let r = null, err = '';
      try {
        const res = await fetch(new URL('/api/license/psx', st.server).toString(), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: lic.token, version, build: lic.build || '' }),
          signal: AbortSignal.timeout(15000),
        });
        r = await res.json();
      } catch (e) { err = e.name === 'TimeoutError' ? 'no answer' : (e.cause && e.cause.code) || e.message; }
      st.checkedAt = Date.now();
      const was = st.state;
      if (r && r.ok) {
        st.state = 'ok'; st.reason = ''; st.name = r.name || st.name; st.okAt = Date.now();
        st.latest = (r.latest && r.latest.version) || '';
        try { fs.writeFileSync(stateFile, JSON.stringify({ okAt: st.okAt, name: st.name, build: st.build })); } catch (_) { /* ignore */ }
      } else if (r) {
        st.state = 'off'; st.reason = r.reason || 'This license can’t use PSX Rando Hub.';
        st.okAt = 0;
        try { fs.unlinkSync(stateFile); } catch (_) { /* (no grace for a copy turned off) */ }
      } else if (st.okAt && Date.now() - st.okAt < GRACE) {
        st.state = 'offline';
        st.reason = `Couldn’t reach Rando Hub to check the license (${err}). It keeps working until ${new Date(st.okAt + GRACE).toLocaleString()}.`;
      } else {
        st.state = 'off';
        st.reason = `Couldn’t reach Rando Hub to check the license (${err}), and the last good check is more than 3 days old. Check your internet connection, then press Check again.`;
      }
      if (st.state !== was) log(st.state === 'ok' ? `license: ok (${st.name})` : `license: ${st.reason}`);
      changed();
      if (update && st.state === 'ok' && st.latest && newer(st.latest, version)) await install();
      return view();
    })();
    try { return await busy; } finally { busy = null; }
  }

  // The "Check for updates" button: a license check that installs a newer version.
  async function checkForUpdates() {
    if (st.state === 'dev') { setUpdate({ state: 'failed', error: 'This is the developer copy (npm start): it doesn’t update itself.' }); return view(); }
    setUpdate({ state: 'checking' });
    await check({ update: true });
    if (st.update.state === 'checking') {
      setUpdate(st.state === 'ok' || st.state === 'offline'
        ? (st.state === 'ok' ? { state: 'latest', version } : { state: 'failed', error: st.reason })
        : { state: 'failed', error: st.reason });
    }
    return view();
  }

  async function install() {
    const v = st.latest;
    if (process.platform !== 'win32') { setUpdate({ state: 'failed', version: v, error: 'Updates install on Windows only.' }); return; }
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'psx-rando-hub-update-'));
    try {
      setUpdate({ state: 'downloading', version: v });
      log(`update: downloading PSX Rando Hub ${v}…`);
      const res = await fetch(new URL('/api/license/psx-download?token=' + encodeURIComponent(lic.token), st.server).toString(), { signal: AbortSignal.timeout(15 * 60 * 1000) });
      if (!res.ok) throw new Error(`the download answered ${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      const zip = path.join(stage, 'update.zip');
      const out = fs.createWriteStream(zip);
      let got = 0, lastPct = -1;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
        const pct = total ? Math.floor((got / total) * 100) : 0;
        if (pct !== lastPct) { lastPct = pct; st.update.progress = pct; changed(); }
      }
      await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
      setUpdate({ state: 'installing', version: v, progress: 100 });
      // Windows 10/11 have tar (bsdtar), which opens zips.
      const x = path.join(stage, 'x');
      fs.mkdirSync(x);
      await new Promise((resolve, reject) => execFile('tar', ['-xf', zip, '-C', x], { windowsHide: true }, (e) => (e ? reject(new Error('couldn’t unpack the update: ' + e.message)) : resolve())));
      const src = path.join(x, 'PSX Rando Hub');
      const setup = path.join(src, SETUP);
      if (!fs.existsSync(setup)) throw new Error('the download isn’t the PSX Rando Hub installer');
      if (!fs.existsSync(path.join(src, 'license.json'))) throw new Error('the download has no license file');
      fs.rmSync(zip, { force: true });

      // The installer runs after we close: a running .exe can't be replaced.
      const script = path.join(stage, 'install-update.cmd');
      const logFile = path.join(app.getPath('userData'), 'last-update.log');
      fs.writeFileSync(script, [
        '@echo off',
        `:wait`,
        `tasklist /FI "PID eq ${process.pid}" 2>NUL | find "${process.pid}" >NUL && (timeout /t 1 /nobreak >NUL & goto wait)`,
        `echo Installing PSX Rando Hub ${v} > "${logFile}"`,
        `"${setup}" /S --force-run`,
        `echo Installer finished with code %ERRORLEVEL% >> "${logFile}"`,
        `timeout /t 5 /nobreak >NUL`,
        `rmdir /s /q "${stage}"`,
        '',
      ].join('\r\n'));
      spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      setUpdate({ state: 'done', version: v, progress: 100 });
      log(`update: PSX Rando Hub ${v} downloaded. Restarting…`);
      setTimeout(() => app.quit(), 1200);
    } catch (e) {
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch (_) { /* ignore */ }
      setUpdate({ state: 'failed', version: v, error: e.message });
      log('update failed: ' + e.message);
    }
  }

  function start() {
    if (st.state === 'dev') { log('license: developer copy (npm start), no license check'); return; }
    if (!lic) { log('license: ' + st.reason); return; }
    check({ update: true }); // at launch: license, and install a newer version
    setInterval(() => check({ update: false }), EVERY).unref();
  }

  return { view, enabled, check, checkForUpdates, start, newer };
}

module.exports = { createLicense, newer, GRACE, EVERY };
