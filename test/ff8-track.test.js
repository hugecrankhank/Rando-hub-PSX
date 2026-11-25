// FF8 auto-tracker and disc pictures, on made-up data.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('../ui/ff8-track');
const art = require('../src/ff8/art');
const { buildDisc } = require('./fake-ff8');

const S = T.SAVE;
function fakeRam(base, { gfsOwned = [], joined = [0], party = [0xff, 0, 0xff], items = [[1, 6], [7, 4]], gil = 5000, seconds = 815 } = {}) {
  const ram = Buffer.alloc(0x200000);
  ram.fill(0xaa, 0, 0x1000); // noise before
  const b = base;
  ram.writeUInt16LE(0x08ff, b + S.magic);
  for (let g = 0; g < 16; g++) { const at = b + S.gfs + g * S.gfSize; ram[at] = 0x45 + g; ram[at + 0x11] = gfsOwned.includes(g) ? 1 : 0; ram.writeUInt16LE(9999, at + 0x12); }
  for (let i = 0; i < 8; i++) { const at = b + S.chars + i * S.charSize; ram.writeUInt32LE(6500 + i * 1000, at + 4); ram[at + 8] = i; ram[at + 0x94] = joined.includes(i) ? 15 : 0; }
  party.forEach((p, i) => { ram[b + S.party + i] = p; }); ram[b + S.party + 3] = 0xff;
  items.forEach(([id, q], j) => { ram[b + S.items + 2 * j] = id; ram[b + S.items + 2 * j + 1] = q; });
  ram.writeUInt32LE(gil, b + S.gil); ram.writeUInt32LE(seconds, b + S.seconds);
  return ram;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('finds the save at its usual address and reads it', () => {
  const ram = fakeRam(T.HINT, { gfsOwned: [0, 1], joined: [0, 3], party: [0xff, 0, 3] });
  assert.strictEqual(T.findSave(ram, -1), T.HINT);
  const s = T.readSave(ram.subarray(T.HINT, T.HINT + T.SAVE_SIZE));
  assert.deepStrictEqual(s.gfs.filter((g) => g.owned).map((g) => g.id), [0, 1]);
  assert.deepStrictEqual(s.chars.filter((c) => c.joined).map((c) => c.name), ['Squall', 'Quistis']);
  assert.strictEqual(s.chars[0].level, 7);
  assert.deepStrictEqual(s.party, [0, 3]);
  assert.deepStrictEqual([...s.items], [[1, 6], [7, 4]]);
  assert.strictEqual(s.gil, 5000);
  assert.strictEqual(s.seconds, 815);
});

test('finds the save somewhere else; nothing before New Game', () => {
  const ram = fakeRam(0x123450);
  assert.strictEqual(T.findSave(ram, -1), 0x123450);
  assert.strictEqual(T.findSave(Buffer.alloc(0x200000), -1), -1);
  const bad = fakeRam(T.HINT); bad[T.HINT + S.items] = 250; // item id out of range
  assert.strictEqual(T.findSave(bad, -1), -1);
});

test('pictures: TIM decode + PNG; a disc without them gives no pictures, no error', () => {
  // made-up 8-bit TIM, 4 x 2, palette of 256 grey-ish colours
  const clut = Buffer.alloc(512); for (let i = 0; i < 256; i++) clut.writeUInt16LE(i ? (i & 31) | 0x8000 : 0, 2 * i);
  const tim = Buffer.concat([Buffer.from([0x10, 0, 0, 0, 9, 0, 0, 0]), Buffer.from(new Uint32Array([12 + 512]).buffer), Buffer.alloc(4), Buffer.from(new Uint16Array([256, 1]).buffer), clut,
    Buffer.from(new Uint32Array([12 + 8]).buffer), Buffer.alloc(4), Buffer.from(new Uint16Array([2, 2]).buffer), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7])]);
  const t = art.parseTim(tim);
  assert.ok(t && t.w === 4 && t.h === 2);
  const px = art.toRgba(t);
  assert.strictEqual(px[3], 0, 'colour 0 is see-through');
  assert.strictEqual(px[7], 255);
  const png = art.png(4, 2, px);
  assert.ok(png.subarray(1, 4).toString() === 'PNG');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff8-art-'));
  const p = path.join(tmp, 'd1.bin'); fs.writeFileSync(p, buildDisc({ n: 1 }));
  const a = art.load(p);
  assert.ok(a && !a.faces && !a.gfs && !a.map && a.cards.every((c) => !c));
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok - ${name}`); } catch (e) { failed++; console.log(`FAIL - ${name}\n`, e); }
  }
  if (failed) process.exit(1);
  console.log('ff8-track tests passed');
})();
