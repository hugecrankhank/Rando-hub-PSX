#!/usr/bin/env node
// Downloads the open-source SotN Randomizer into vendor/sotn-randomizer and installs
// its dependencies. Uses only Node built-ins plus Windows' built-in tar (bsdtar),
// which can extract .zip files on Windows 10 1803+ and Windows 11.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor');
const def = JSON.parse(fs.readFileSync(path.join(ROOT, 'games', 'sotn.json'), 'utf8'));
const target = path.join(VENDOR, def.randomizer.vendorDir);
const force = process.argv.includes('--force');

async function main() {
  if (fs.existsSync(path.join(target, 'package.json')) && !force) {
    console.log(`SotN Randomizer already installed at ${target} (use --force to reinstall).`);
    return;
  }
  fs.mkdirSync(VENDOR, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sotn-rando-'));
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
