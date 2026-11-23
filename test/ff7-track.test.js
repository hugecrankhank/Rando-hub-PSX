// FF7 auto-tracker: finds the save block in fake PS1 RAM and reads it.
'use strict';

const assert = require('assert');
const T = require('../ui/ff7-track');

function fakeRam(base) {
  const ram = new Uint8Array(0x200000);
  for (let i = 0; i < ram.length; i++) ram[i] = (i * 7) & 0xff; // noise
  const v = new DataView(ram.buffer);
  const names = ['Cloud', 'Barret', 'Tifa', 'Aeris', 'Red XIII', 'Yuffie', 'Cait Sith', 'Vincent', 'Cid'];
  for (let i = 0; i < 9; i++) {
    const at = base + 0x54 + i * 0x84;
    ram[at] = i; ram[at + 1] = 5 + i;
    ram.fill(0xff, at + 0x10, at + 0x1c);
    [...names[i]].forEach((c, j) => { ram[at + 0x10 + j] = c.charCodeAt(0) - 0x20; });
    ram[at + 0x1c] = i * 16;
    ram.fill(0xff, at + 0x40, at + 0x80);
  }
  v.setUint32(base + 0x54 + 0x40, 53, true);          // Cloud: Restore equipped
  ram[base + 0x4f8] = 0; ram[base + 0x4f9] = 1; ram[base + 0x4fa] = 0xff;
  ram.fill(0xff, base + 0x4fc, base + 0x4fc + 640);
  v.setUint16(base + 0x4fc, (3 << 9) | 0, true);       // 3 Potions
  ram.fill(0xff, base + 0x77c, base + 0x77c + 800);
  v.setUint32(base + 0x77c, 89 | (1234 << 8), true);   // KotR with AP
  v.setUint32(base + 0xb7c, 4321, true);
  v.setUint32(base + 0xb80, 3725, true);
  v.setUint16(base + 0xba4, 42, true);
  return ram;
}

// Usual address
let ram = fakeRam(T.HINT);
assert.strictEqual(T.findSave(ram, -1), T.HINT);
const s = T.readSave(ram.subarray(T.HINT, T.HINT + T.SAVE_SIZE));
assert.deepStrictEqual(s.party, [0, 1]);
assert.strictEqual(s.chars[0].name, 'Cloud');
assert.strictEqual(s.chars[3].level, 8);
assert.ok(s.materia.has(53) && s.materia.has(89) && !s.materia.has(255));
assert.strictEqual(s.items.get(0), 3);
assert.strictEqual(s.gil, 4321);
assert.strictEqual(s.seconds, 3725);
assert.strictEqual(s.progress, 42);

// Somewhere else in RAM (other region / version): found by scanning.
ram = fakeRam(0x0a1230);
assert.strictEqual(T.findSave(ram, -1), 0x0a1230);

// Nothing loaded yet
assert.strictEqual(T.findSave(new Uint8Array(0x200000), -1), -1);

console.log('ff7-track.test.js ok');
