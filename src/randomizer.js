// Bridge to the open-source SotN Randomizer (github.com/3snowp7im/SotN-Randomizer).
// The randomizer is a Node CLI; we run it with Electron's bundled Node
// (ELECTRON_RUN_AS_NODE=1) so the user doesn't need Node installed after build.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function runNode(script, args, cwd, onLine) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
    });
    let out = '';
    const feed = (d) => {
      const s = d.toString();
      out += s;
      if (onLine) s.split(/\r?\n/).filter(Boolean).forEach(onLine);
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', (e) => resolve({ code: -1, out: out + String(e) }));
    child.on('close', (code) => resolve({ code, out }));
  });
}

class Randomizer {
  constructor(dir) {
    this.dir = dir;
    this._argStyle = null;
  }

  isInstalled() {
    return !!this.entry();
  }

  entry() {
    if (!this.dir || !fs.existsSync(this.dir)) return null;
    for (const name of ['randomize', 'randomize.js']) {
      const p = path.join(this.dir, name);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    }
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(this.dir, 'package.json'), 'utf8'));
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && Object.values(pkg.bin)[0];
      if (bin && fs.existsSync(path.join(this.dir, bin))) return path.join(this.dir, bin);
    } catch (_) { /* ignore */ }
    return null;
  }

  presets(fallback = []) {
    const dir = path.join(this.dir || '', 'presets');
    try {
      const names = fs.readdirSync(dir)
        .filter((f) => /\.(json|js)$/i.test(f) && !/^index\./i.test(f))
        .map((f) => f.replace(/\.(json|js)$/i, ''));
      if (names.length) return names.sort();
    } catch (_) { /* fall through */ }
    return fallback;
  }

  async argStyle() {
    if (this._argStyle) return this._argStyle;
    const res = await runNode(this.entry(), ['--help'], this.dir);
    // Newer builds take --in-bin/-i and --out/-o; older builds patch a positional .bin in place.
    this._argStyle = /--in-bin|--out\b/.test(res.out) ? 'io' : 'inplace';
    this._help = res.out;
    return this._argStyle;
  }

  /**
   * Generate a seed.
   * opts: { vanillaBin, outBin, seed, preset, tournament, spoilerLevel, extraArgs }
   */
  async generate(opts, onLine) {
    const entry = this.entry();
    if (!entry) throw new Error('SotN Randomizer is not installed. Run "npm run setup" or pick its folder in Settings.');
    const style = await this.argStyle();

    const args = [];
    if (opts.seed) args.push('-s', String(opts.seed));
    if (opts.preset) args.push('-p', opts.preset);
    if (opts.tournament) args.push('-t');
    const v = Math.max(0, Math.min(3, opts.spoilerLevel ?? 2));
    if (v > 0) args.push('-' + 'v'.repeat(v));
    if (opts.extraArgs) args.push(...splitArgs(opts.extraArgs));

    fs.mkdirSync(path.dirname(opts.outBin), { recursive: true });
    if (style === 'io') {
      args.push('-i', opts.vanillaBin, '-o', opts.outBin);
    } else {
      onLine && onLine('Copying vanilla image…');
      await fs.promises.copyFile(opts.vanillaBin, opts.outBin);
      args.push(opts.outBin);
    }

    onLine && onLine(`> randomize ${args.map(quoteIfNeeded).join(' ')}`);
    const res = await runNode(entry, args, this.dir, onLine);
    if (res.code !== 0 || !fs.existsSync(opts.outBin)) {
      throw new Error(`Randomizer exited with code ${res.code}.\n${res.out.slice(-2000)}`);
    }
    return { log: res.out, args };
  }
}

function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function quoteIfNeeded(a) {
  return /\s/.test(a) ? `"${a}"` : a;
}

module.exports = { Randomizer, splitArgs };
