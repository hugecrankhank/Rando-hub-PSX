/* global hub */
// Shared by the game pages: "Licensed to …" in the top bar, and the Updates block in Settings.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let last = null;

  function render(v) {
    last = v;
    const tag = $('licensedTo');
    if (tag) {
      tag.textContent = v.state === 'dev' ? 'Developer copy' : v.name ? `Licensed to ${v.name}${v.build ? ' · build ' + v.build : ''}` : '';
      tag.title = v.state === 'offline' ? v.reason : 'This copy was made for you. Please don’t share it.';
    }
    const box = $('updateSetting');
    if (!box) return;
    const u = v.update || {};
    const status = {
      checking: 'Checking…',
      downloading: `Downloading v${u.version}: ${u.progress || 0}%`,
      installing: `Installing v${u.version}…`,
      done: `v${u.version} is ready. Restarting…`,
      latest: 'You have the newest version.',
      failed: `Couldn’t update: ${u.error}`,
    }[u.state] || (v.latest && v.latest !== v.version && v.state === 'ok' ? `v${v.latest} is available.` : '');
    box.querySelector('.ver').textContent = `PSX Rando Hub v${v.version}`;
    box.querySelector('.status').textContent = status;
    box.querySelector('button').disabled = ['checking', 'downloading', 'installing', 'done'].includes(u.state);
  }

  function mount() {
    const box = $('updateSetting');
    if (box && !box.firstChild) {
      box.innerHTML = '<div class="setting-head"><b>Updates</b><span class="badge ver"></span></div>' +
        '<button class="btn small" type="button">Check for updates</button>' +
        '<p class="fine status"></p>' +
        '<p class="fine">PSX Rando Hub checks for a new version every time it starts and installs it by itself. Your settings, seeds and saves stay.</p>';
      box.querySelector('button').addEventListener('click', async () => {
        const playing = !document.getElementById('emuFrame').hidden;
        if (playing && !confirm('If there’s a new version, PSX Rando Hub restarts to install it and the game stops. Save first. Check now?')) return;
        render(await hub.license.checkForUpdates());
      });
    }
    hub.license.get().then(render);
    hub.license.onChange(render);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
  window.hubLicense = { get last() { return last; } };
})();
