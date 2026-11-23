// Builds a tiny made-up disc image laid out like FF7's (ISO9660, raw Mode 2
// sectors, INIT/KERNEL.BIN and BATTLE/SCENE.BIN in the real formats) so the
// seed generator can be tested without any game files. No real game data.
'use strict';

const zlib = require('zlib');
const { fixSector } = require('../src/cdsector');

const enc = (s) => Buffer.concat([Buffer.from([...s].map((c) => c.charCodeAt(0) - 0x20)), Buffer.from([0xff])]);

function textTable(strings) {
  const bodies = strings.map(enc);
  const head = Buffer.alloc(strings.length * 2);
  let off = head.length;
  bodies.forEach((b, i) => { head.writeUInt16LE(off, i * 2); off += b.length; });
  return Buffer.concat([head, ...bodies]);
}

// gzip with an FNAME header, like some tools write, to check headers are kept.
function gz(data, name) {
  const g = zlib.gzipSync(data);
  if (!name) return g;
  const hdr = Buffer.from(g.subarray(0, 10));
  hdr[3] |= 8;
  return Buffer.concat([hdr, Buffer.from(name + '\0', 'latin1'), g.subarray(10)]);
}

const MATERIA = Array.from({ length: 96 }, (_, i) => `Materia ${i}`);
Object.assign(MATERIA, { 49: 'Fire', 50: 'Ice', 52: 'Lightning', 53: 'Restore', 73: 'Master Magic', 89: 'Knights of Round', 37: 'Steal', 45: 'Enemy Skill', 74: 'Choco/Mog' });
MATERIA[16] = ''; MATERIA[23] = '';

function kernelSections() {
  const s = [];
  s[0] = Buffer.alloc(1000, 1); s[1] = Buffer.alloc(3000, 2); s[2] = Buffer.alloc(2000, 3);
  const init = Buffer.alloc(0xb80, 0);
  const names = ['Cloud', 'Barret', 'Tifa', 'Aeris', 'Red XIII', 'Yuffie', 'Cait Sith', 'Vincent', 'Cid'];
  for (let c = 0; c < 9; c++) {
    const at = c * 0x84;
    init[at] = c; init[at + 1] = c === 0 ? 6 : 1;
    const n = enc(names[c]); init.fill(0xff, at + 0x10, at + 0x1c); n.copy(init, at + 0x10, 0, Math.min(12, n.length));
    init[at + 0x1c] = c * 14; init[at + 0x1d] = 0; init[at + 0x1e] = 0xff;
    init.fill(0xff, at + 0x40, at + 0x80);
  }
  init.writeUInt32LE(50, 0x40); init.writeUInt32LE(52, 0x44); // Cloud: Ice, Lightning
  init.writeUInt32LE(53, 0x84 + 0x40); // Barret: Restore
  init.fill(0xff, 0x4a8, 0x4a8 + 640);
  init.fill(0xff, 0x728, 0x728 + 800);
  init.writeUInt32LE(49, 0x728); // one Fire in the list
  s[3] = init;
  s[4] = Buffer.alloc(128 * 28, 4);
  const w = Buffer.alloc(128 * 44, 0);
  for (let i = 0; i < 128; i++) {
    const at = i * 44;
    w[at + 4] = 10 + i;
    w[at + 6] = 1;
    const owner = Math.min(8, Math.floor(i / 14));
    w.writeUInt16LE(1 << owner, at + 0x0e);
    Buffer.from(i % 3 === 0 ? [2, 3, 1, 0, 0, 0, 0, 0] : i % 3 === 1 ? [1, 0, 0, 0, 0, 0, 0, 0] : [2, 3, 2, 3, 0, 0, 0, 0]).copy(w, at + 0x1c);
  }
  s[5] = w;
  const a = Buffer.alloc(32 * 36, 0);
  for (let i = 0; i < 32; i++) { a[i * 36 + 2] = i * 3; Buffer.from(i % 2 ? [1, 1, 0, 0, 0, 0, 0, 0] : [2, 3, 0, 0, 0, 0, 0, 0]).copy(a, i * 36 + 8); a[i * 36 + 0x10] = 1; }
  s[6] = a;
  s[7] = Buffer.alloc(32 * 16, 7);
  s[8] = Buffer.alloc(96 * 20, 8);
  for (let i = 9; i <= 18; i++) s[i] = textTable(['x', 'y']);
  s[19] = textTable(Array.from({ length: 128 }, (_, i) => `Item ${i}`));
  s[20] = textTable(Array.from({ length: 128 }, (_, i) => `Weapon ${i}`));
  s[21] = textTable(Array.from({ length: 32 }, (_, i) => `Armor ${i}`));
  s[22] = textTable(Array.from({ length: 32 }, (_, i) => `Accessory ${i}`));
  s[23] = textTable(MATERIA);
  s[24] = textTable(Array.from({ length: 64 }, (_, i) => `Key ${i}`));
  s[25] = textTable(['battle']); s[26] = textTable(['summon']);
  return s;
}

function kernelBin() {
  const parts = kernelSections().map((d, i) => {
    const g = gz(d, i === 3 ? 'init.bin' : null);
    const h = Buffer.alloc(6);
    h.writeUInt16LE(g.length, 0); h.writeUInt16LE(d.length, 2); h.writeUInt16LE(i, 4);
    return Buffer.concat([h, g]);
  });
  const k = Buffer.concat(parts);
  return Buffer.concat([k, Buffer.alloc(300)]); // slack, like a real file's tail
}

function sceneData(seedA, seedB) {
  const d = Buffer.alloc(7808, 0);
  d.fill(0xff, 0, 8);
  const ids = [seedA, seedB];
  ids.forEach((id, slot) => {
    d.writeUInt16LE(id, slot * 2);
    const at = 0x298 + slot * 184;
    d.fill(0xff, at, at + 32); enc(`Enemy ${id}`).copy(d, at);
    d[at + 0x20] = 1 + (id % 60);
    for (let j = 0; j < 4; j++) {
      d[at + 0x88 + j] = j === 0 ? 0x3f : j === 1 ? 0x88 : 0xff;
      d.writeUInt16LE(j < 2 ? (id * 7 + j) % 320 : 0xffff, at + 0x8c + j * 2);
    }
    d.writeUInt16LE(30 + id, at + 0x9e);
    d.writeUInt16LE(id % 4 === 0 ? (id * 3) % 128 : 0xffff, at + 0xa0);
    d.writeUInt32LE(100 + id, at + 0xa4); d.writeUInt32LE(50 + id, at + 0xa8); d.writeUInt32LE(20 + id, at + 0xac);
  });
  return d;
}

function sceneBin() {
  const blocks = [];
  let n = 0;
  for (let b = 0; b < 8; b++) {
    const blk = Buffer.alloc(0x2000, 0xff);
    let pos = 0x40;
    for (let i = 0; i < 16; i++, n++) {
      const g = gz(sceneData(n % 61, (n * 13 + 5) % 61));
      blk.writeUInt32LE(pos / 4, i * 4);
      g.copy(blk, pos);
      pos = (pos + g.length + 3) & ~3;
    }
    blocks.push(blk);
  }
  return Buffer.concat(blocks);
}

// ---- ISO9660 on raw Mode 2 Form 1 sectors
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

function buildDisc({ serial = 'SCUS_941.63' } = {}) {
  const files = {};
  const exe = Buffer.alloc(0x800 + 0x8000);
  exe.write('PS-X EXE', 0, 'ascii');
  exe.writeUInt32LE(0x80010000, 0x18); exe.writeUInt32LE(0x8000, 0x1c);
  for (let i = 0x800; i < exe.length; i++) exe[i] = (i * 2654435761) >>> 24;
  const cnf = Buffer.from(`BOOT = cdrom:\\${serial};1\r\nTCB = 4\r\n`);
  const kernel = kernelBin(), scene = sceneBin();
  // Layout: 16 empty, 17 PVD... (16 = PVD, 17 = terminator), 18 root, 19 INIT, 20 BATTLE, then files.
  let lba = 22;
  const place = (buf) => { const at = lba; lba += Math.ceil(buf.length / 2048) + 1; return at; };
  files.cnf = { lba: place(cnf), buf: cnf };
  files.exe = { lba: place(exe), buf: exe };
  files.kernel = { lba: place(kernel), buf: kernel };
  files.scene = { lba: place(scene), buf: scene };
  const total = lba + 4;

  const dir = (self, parent, entries) => {
    const d = Buffer.alloc(2048);
    let p = 0;
    for (const r of [dirRecord('\0', self, 2048, true), dirRecord('\x01', parent, 2048, true), ...entries]) { r.copy(d, p); p += r.length; }
    return d;
  };
  const root = dir(18, 18, [
    dirRecord('BATTLE', 20, 2048, true), dirRecord('INIT', 19, 2048, true),
    dirRecord(`${serial};1`, files.exe.lba, exe.length, false), dirRecord('SYSTEM.CNF;1', files.cnf.lba, cnf.length, false),
  ]);
  const init = dir(19, 18, [dirRecord('KERNEL.BIN;1', files.kernel.lba, kernel.length, false)]);
  const battle = dir(20, 18, [dirRecord('SCENE.BIN;1', files.scene.lba, scene.length, false)]);
  const pvd = Buffer.alloc(2048);
  pvd[0] = 1; pvd.write('CD001', 1, 'ascii'); pvd[6] = 1;
  pvd.write('FF7TEST'.padEnd(32), 40, 'ascii');
  dirRecord('\0', 18, 2048, true).copy(pvd, 156);
  const term = Buffer.alloc(2048); term[0] = 255; term.write('CD001', 1, 'ascii');

  const user = new Map([[16, pvd], [17, term], [18, root], [19, init], [20, battle]]);
  for (const f of Object.values(files)) {
    for (let i = 0; i * 2048 < f.buf.length; i++) {
      const s = Buffer.alloc(2048);
      f.buf.copy(s, 0, i * 2048, Math.min(f.buf.length, (i + 1) * 2048));
      user.set(f.lba + i, s);
    }
  }
  const img = Buffer.alloc(total * 2352);
  for (let l = 0; l < total; l++) {
    const s = img.subarray(l * 2352, (l + 1) * 2352);
    s[0] = 0; s.fill(0xff, 1, 11); s[11] = 0;
    const m = l + 150;
    const bcd = (v) => ((Math.floor(v / 10) << 4) | (v % 10));
    s[12] = bcd(Math.floor(m / 4500)); s[13] = bcd(Math.floor(m / 75) % 60); s[14] = bcd(m % 75); s[15] = 2;
    s[18] = s[22] = 0x08; // subheader: data
    (user.get(l) || Buffer.alloc(2048)).copy(s, 24);
    fixSector(s);
  }
  return img;
}

module.exports = { buildDisc, kernelSections, MATERIA };
