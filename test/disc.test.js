// Builds a tiny synthetic Mode2/2352 PS1 disc in memory and checks the parser.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { inspectDisc } = require('../src/disc');

const RAW = 2352;

function dirRecord(name, lba, size, isDir) {
  const nameBuf = Buffer.from(name, 'latin1');
  let len = 33 + nameBuf.length;
  if (len % 2) len++;
  const r = Buffer.alloc(len);
  r[0] = len;
  r.writeUInt32LE(lba, 2); r.writeUInt32BE(lba, 6);
  r.writeUInt32LE(size, 10); r.writeUInt32BE(size, 14);
  r[25] = isDir ? 2 : 0;
  r[32] = nameBuf.length;
  nameBuf.copy(r, 33);
  return r;
}

function makeImage(exe, { exeName = 'SLUS_000.67;1' } = {}) {
  const cnf = Buffer.from(`BOOT = cdrom:\\${exeName}\r\nTCB = 4\r\nEVENT = 10\r\nSTACK = 801FFF00\r\n`);
  const ROOT_LBA = 20, CNF_LBA = 21, EXE_LBA = 22;
  const exeSectors = Math.ceil(exe.length / 2048);
  const total = EXE_LBA + exeSectors + 2;
  const sectors = Array.from({ length: total }, () => Buffer.alloc(2048));

  const pvd = sectors[16];
  pvd[0] = 1; pvd.write('CD001', 1, 'ascii'); pvd[6] = 1;
  pvd.write('SLUS_00067'.padEnd(32), 40, 'ascii');
  dirRecord('\u0000', ROOT_LBA, 2048, true).copy(pvd, 156);

  const root = Buffer.concat([
    dirRecord('\u0000', ROOT_LBA, 2048, true),
    dirRecord('\u0001', ROOT_LBA, 2048, true),
    dirRecord('SYSTEM.CNF;1', CNF_LBA, cnf.length, false),
    dirRecord(exeName, EXE_LBA, exe.length, false),
  ]);
  root.copy(sectors[ROOT_LBA]);
  cnf.copy(sectors[CNF_LBA]);
  for (let i = 0; i < exeSectors; i++) exe.copy(sectors[EXE_LBA + i], 0, i * 2048, Math.min(exe.length, (i + 1) * 2048));

  const raw = Buffer.alloc(total * RAW);
  sectors.forEach((data, lba) => {
    const off = lba * RAW;
    raw[off] = 0; raw.fill(0xff, off + 1, off + 11); raw[off + 11] = 0;
    raw[off + 15] = 2; // mode 2
    data.copy(raw, off + 24);
  });
  return raw;
}

function makeExe(textSize) {
  const exe = Buffer.alloc(0x800 + textSize);
  exe.write('PS-X EXE', 0, 'ascii');
  exe.writeUInt32LE(0x80010000 + 0x40, 0x10);
  exe.writeUInt32LE(0x80010000, 0x18);
  exe.writeUInt32LE(textSize, 0x1c);
  crypto.randomFillSync(exe, 0x800);
  return exe;
}

const exe = makeExe(0x40000);
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'disc-')), 'test (Track 1).bin');
fs.writeFileSync(file, makeImage(exe));

const info = inspectDisc(file);
assert.strictEqual(info.exeName, 'SLUS_000.67');
assert.strictEqual(info.sectorSize, 2352);
assert.strictEqual(info.header.tAddr, 0x80010000);
assert.strictEqual(info.header.tSize, 0x40000);
assert.ok(info.probes.length >= 3, 'expected several probes');
for (const p of info.probes) {
  const off = p.ramOffset - 0x10000;
  assert.deepStrictEqual(Buffer.from(p.bytes), exe.subarray(0x800 + off, 0x800 + off + 64));
  assert.strictEqual(p.ramOffset % 4, 0);
}
console.log('disc.test.js ok —', info.probes.length, 'probes');

module.exports = { makeExe, makeImage };
