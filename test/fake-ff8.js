// A tiny made-up disc laid out like FF8's: SYSTEM.CNF, the boot exe and FF8DISC<n>.IMG holding a kernel.bin
// (56 sections; magic names in section 32) and enemy files (11 sections + end; 380-byte info block in section 7).
// No real game data.
'use strict';

const { fixSector } = require('../src/cdsector');

const CH = new Map([[' ', 0x20]]);
for (let i = 0; i < 10; i++) CH.set(String(i), 0x21 + i);
for (let i = 0; i < 26; i++) { CH.set(String.fromCharCode(65 + i), 0x45 + i); CH.set(String.fromCharCode(97 + i), 0x5f + i); }
CH.set('-', 0x32);
const enc = (s) => Buffer.from([...[...s].map((c) => CH.get(c) || 0x20), 0]);

const MAGIC = Array.from({ length: 57 }, (_, i) => (i === 0 ? '' : `Spell ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(97 + (i % 7))}`));

function sections(list) {
  const head = Buffer.alloc(4 + 4 * list.length);
  head.writeUInt32LE(list.length, 0);
  let off = head.length;
  list.forEach((s, i) => { head.writeUInt32LE(off, 4 + 4 * i); off += s.length; });
  return Buffer.concat([head, ...list]);
}

// Abilities 0-115 in sections 11-17 (8-byte entries) with names in text sections 41-47. Three real ability names
// are used so the loader's "first GF looks right" check passes; the rest are made up.
const ABILITY_COUNTS = [20, 19, 19, 20, 5, 9, 24];
const L = (i) => String.fromCharCode(65 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26));
const ABILITY = Array.from({ length: 116 }, (_, i) => ({ 25: 'Card', 97: 'T Mag-RF', 115: 'Card Mod' })[i] || `Skill ${L(i)}`);
// GF g learns 21 abilities: GF 0 has the three real ones; the first four GFs bring the basic commands 20-23;
// the last slot of every other GF is empty.
const GF_LISTS = Array.from({ length: 16 }, (_, g) => {
  const l = g === 0 ? [25, 97, 115, 20] : g < 4 ? [20 + g] : [];
  for (let k = 0; l.length < 21; k++) { const a = 24 + ((g * 5 + k * 7) % 92); if (!l.includes(a) && ![25, 97, 115].includes(a)) l.push(a); }
  if (g % 2) l[20] = 0;
  return l;
});

function abilityTables(list) {
  let at = 0;
  ABILITY_COUNTS.forEach((n, k) => {
    const names = ABILITY.slice(at, at + n); at += n;
    const tbl = Buffer.alloc(8 * n); const txt = []; let pos = 0;
    names.forEach((nm, i) => { const b = enc(nm); tbl.writeUInt16LE(pos, 8 * i); txt.push(b); pos += b.length; });
    list[11 + k] = tbl; list[41 + k] = Buffer.concat(txt);
  });
  const gf = Buffer.alloc(16 * 132);
  GF_LISTS.forEach((l, g) => l.forEach((a, j) => { gf[g * 132 + 0x18 + 4 * j] = j + 1; gf.writeUInt16LE(a, g * 132 + 0x18 + 4 * j + 2); }));
  list[2] = gf;
}

function kernel() {
  const text = [];
  let pos = 0;
  const offs = MAGIC.map((m) => { const b = enc(m); const at = pos; text.push(b); pos += b.length; return at; });
  const magic = Buffer.alloc(57 * 60);
  offs.forEach((o, i) => magic.writeUInt16LE(i === 0 ? 0xffff : o, 60 * i));
  const list = Array.from({ length: 56 }, (_, i) => Buffer.alloc(16 + (i % 5) * 8, i));
  list[1] = magic;
  list[32] = Buffer.concat(text);
  abilityTables(list);
  return sections(list);
}

// Enemy n: draws, mugs, drops, card, EXP/AP made up from n. Enemies 7 and 20 draw a Guardian Force (id 64+).
function enemy(n) {
  const info = Buffer.alloc(380);
  enc(`Monster ${String.fromCharCode(65 + (n % 26))}${n}`).copy(info, 0);
  info[0xf4] = 20; info[0xf5] = 40;
  info[0xf8] = n % 5 === 0 ? 0xff : n % 110; info[0xf9] = 0xff; info[0xfa] = 0xff;
  info.writeUInt16LE(10 + n, 0x100); info.writeUInt16LE(100 + n, 0x102);
  for (let j = 0; j < 12; j++) {
    info[0x104 + 2 * j] = j % 4 === 3 ? 0 : 1 + ((n * 3 + j) % 57);
    info[0x11c + 2 * j] = j % 4 === 0 ? 1 + ((n + j) % 198) : 0; info[0x11d + 2 * j] = j % 4 === 0 ? 1 + (n % 3) : 0;
    info[0x134 + 2 * j] = j % 4 < 2 ? 1 + ((n * 5 + j) % 198) : 0; info[0x135 + 2 * j] = j % 4 < 2 ? 1 : 0;
  }
  if (n === 7 || n === 20) info[0x104 + 2 * 1] = 64 + (n % 16);
  info[0x14c] = 50; info[0x14d] = 100; info[0x14f] = 3 + (n % 10);
  return sections([...Array.from({ length: 6 }, (_, i) => Buffer.alloc(100 + i * 30 + n, i + 1)), info, ...Array.from({ length: 4 }, (_, i) => Buffer.alloc(64, 0x70 + i))]);
}
// (an end offset after the 11, like the real files)
function enemyFile(n) {
  const f = enemy(n);
  const head = Buffer.alloc(4 + 12 * 4);
  head.writeUInt32LE(11, 0);
  for (let i = 0; i < 11; i++) head.writeUInt32LE(f.readUInt32LE(4 + 4 * i) + 4, 4 + 4 * i);
  head.writeUInt32LE(f.length + 4, 4 + 44);
  return Buffer.concat([head, f.subarray(4 + 44)]);
}

const ENEMIES = 120;
function img() {
  const parts = [], at = (n) => Math.ceil(n / 2048) * 2048;
  let size = 0;
  const put = (buf) => { const pad = Buffer.alloc(at(buf.length) - buf.length); parts.push(buf, pad); size += buf.length + pad.length; };
  put(Buffer.alloc(5 * 2048, 0x11)); // (other files before the kernel)
  put(kernel());
  put(Buffer.alloc(30 * 2048, 0x22));
  for (let n = 0; n < ENEMIES; n++) put(enemyFile(n));
  put(Buffer.alloc(10 * 2048, 0x33));
  return Buffer.concat(parts);
}

function dirRecord(name, lba, size, isDir) {
  const nb = Buffer.from(name, 'latin1');
  const len = 33 + nb.length + (nb.length % 2 === 0 ? 1 : 0);
  const r = Buffer.alloc(len);
  r[0] = len;
  r.writeUInt32LE(lba, 2); r.writeUInt32BE(lba, 6);
  r.writeUInt32LE(size, 10); r.writeUInt32BE(size, 14);
  r[25] = isDir ? 2 : 0;
  r.writeUInt16LE(1, 28); r.writeUInt16BE(1, 30);
  r[32] = nb.length; nb.copy(r, 33);
  return r;
}

function buildDisc({ n = 1, serial = ['SLUS_008.92', 'SLUS_009.08', 'SLUS_009.09', 'SLUS_009.10'][n - 1] } = {}) {
  const exe = Buffer.alloc(0x800 + 0x8000);
  exe.write('PS-X EXE', 0, 'ascii');
  exe.writeUInt32LE(0x80010000, 0x18); exe.writeUInt32LE(0x8000, 0x1c);
  for (let i = 0x800; i < exe.length; i++) exe[i] = (i * 2654435761) >>> 24;
  const cnf = Buffer.from(`BOOT = cdrom:\\${serial};1\r\nTCB = 4\r\n`);
  const data = img();
  const files = [];
  let lba = 23;
  const place = (name, buf) => { files.push({ name, lba, buf }); lba += Math.ceil(buf.length / 2048); };
  place('SYSTEM.CNF;1', cnf);
  place(`${serial};1`, exe);
  place(`FF8DISC${n}.IMG;1`, data);
  const total = lba + 4;
  const root = Buffer.alloc(2048);
  let p = 0;
  for (const r of [dirRecord('\0', 22, 2048, true), dirRecord('\x01', 22, 2048, true), ...files.map((f) => dirRecord(f.name, f.lba, f.buf.length, false))]) { r.copy(root, p); p += r.length; }
  const pvd = Buffer.alloc(2048);
  pvd[0] = 1; pvd.write('CD001', 1, 'ascii'); pvd[6] = 1;
  dirRecord('\0', 22, 2048, true).copy(pvd, 156);
  const term = Buffer.alloc(2048); term[0] = 255; term.write('CD001', 1, 'ascii');
  const img2352 = Buffer.alloc(total * 2352);
  const user = (l) => {
    if (l === 16) return pvd; if (l === 17) return term; if (l === 22) return root;
    for (const f of files) if (l >= f.lba && l < f.lba + Math.ceil(f.buf.length / 2048)) {
      const s = Buffer.alloc(2048); f.buf.copy(s, 0, (l - f.lba) * 2048, Math.min(f.buf.length, (l - f.lba + 1) * 2048)); return s;
    }
    return null;
  };
  const bcd = (v) => ((Math.floor(v / 10) << 4) | (v % 10));
  for (let l = 0; l < total; l++) {
    const s = img2352.subarray(l * 2352, (l + 1) * 2352);
    s.fill(0xff, 1, 11);
    const m = l + 150;
    s[12] = bcd(Math.floor(m / 4500)); s[13] = bcd(Math.floor(m / 75) % 60); s[14] = bcd(m % 75); s[15] = 2;
    s[18] = s[22] = 0x08;
    const u = user(l); if (u) u.copy(s, 24);
    fixSector(s);
  }
  return img2352;
}

module.exports = { buildDisc, MAGIC, ENEMIES, ABILITY, GF_LISTS };
