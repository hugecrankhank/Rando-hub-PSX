#!/usr/bin/env node
// Downloads the open-source SotN Randomizer into vendor/sotn-randomizer and installs
// its dependencies. Uses only Node built-ins plus Windows' built-in tar (bsdtar),
// which can extract .zip files on Windows 10 1803+ and Windows 11.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor');
const def = JSON.parse(fs.readFileSync(path.join(ROOT, 'games', 'sotn.json'), 'utf8'));
const target = path.join(VENDOR, def.randomizer.vendorDir);
const force = process.argv.includes('--force');

// SotnRandoTools (MIT, github.com/TalicZealot/SotnRandoTools) ships the map-location
// data (Extensions/*.json) and the item icon sheet (Images/texture.png) that the
// hub's map tracker uses. We pull them from its latest release.
async function installRandoToolsData() {
  const dest = path.join(VENDOR, 'sotnrandotools');
  if (fs.existsSync(path.join(dest, 'Extensions')) && !force) {
    console.log(`SotnRandoTools data already installed at ${dest}.`);
    return;
  }
  console.log('Looking up the latest SotnRandoTools release…');
  const headers = { 'User-Agent': 'psx-rando-hub-setup', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const rel = await (await fetch('https://api.github.com/repos/TalicZealot/SotnRandoTools/releases/latest', { headers })).json();
  const asset = (rel.assets || []).find((a) => /^SotnRandoTools.*\.zip$/i.test(a.name)) || (rel.assets || []).find((a) => /\.zip$/i.test(a.name) && !/^Update/i.test(a.name));
  if (!asset) throw new Error('Could not find a SotnRandoTools release zip.');
  console.log(`Downloading ${asset.name} (${rel.tag_name})…`);
  const res = await fetch(asset.browser_download_url, { headers: { 'User-Agent': headers['User-Agent'] } });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  fs.mkdirSync(VENDOR, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(VENDOR, '.tmp-'));
  const zip = path.join(tmp, 'srt.zip');
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  const out = path.join(tmp, 'x');
  fs.mkdirSync(out);
  execFileSync('tar', ['-xf', zip, '-C', out], { stdio: 'inherit' });
  // Find the folder that contains Extensions/
  const find = (dir, depth = 0) => {
    if (fs.existsSync(path.join(dir, 'Extensions'))) return dir;
    if (depth > 4) return null;
    for (const d of fs.readdirSync(dir)) {
      const p = path.join(dir, d);
      if (fs.statSync(p).isDirectory()) { const r = find(p, depth + 1); if (r) return r; }
    }
    return null;
  };
  const root = find(out);
  if (!root) throw new Error('SotnRandoTools release has no Extensions folder.');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const sub of ['Extensions', 'Presets', 'Images']) {
    if (fs.existsSync(path.join(root, sub))) fs.cpSync(path.join(root, sub), path.join(dest, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(dest, 'VERSION.txt'), `${rel.tag_name}\nMIT License - https://github.com/TalicZealot/SotnRandoTools\n`);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`SotnRandoTools data installed to ${dest}`);
}

async function main() {
  await installRandoToolsData();
  if (fs.existsSync(path.join(target, 'package.json')) && !force) {
    console.log(`SotN Randomizer already installed at ${target} (use --force to reinstall).`);
    return;
  }
  fs.mkdirSync(VENDOR, { recursive: true });
  // Work inside vendor/ so the final rename never crosses drives (EXDEV on Windows).
  const tmp = fs.mkdtempSync(path.join(VENDOR, '.tmp-'));
  const zip = path.join(tmp, 'rando.zip');

  console.log(`Downloading ${def.randomizer.repoZip} …`);
  const res = await fetch(def.randomizer.repoZip);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));

  console.log('Extracting…');
  const out = path.join(tmp, 'x');
  fs.mkdirSync(out);
  execFileSync('tar', ['-xf', zip, '-C', out], { stdio: 'inherit' });
  const top = fs.readdirSync(out).find((d) => fs.statSync(path.join(out, d)).isDirectory());
  if (!top) throw new Error('Unexpected archive layout.');

  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(path.join(out, top), target);

  console.log('Installing randomizer dependencies (npm install)…');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npm, ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: target, stdio: 'inherit', shell: process.platform === 'win32' });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nSotN Randomizer installed to ${target}`);
}

main().catch((e) => {
  console.error('\nSetup failed:', e.message);
  console.error('You can also download SotN Randomizer yourself and pick its folder in the app (Settings → Seed generator).');
  process.exit(1);
});
