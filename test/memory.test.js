// Simulates an emulator heap with PS1 RAM somewhere inside it and checks that
// the locator finds it (and ignores a decoy copy of one probe).
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const { RamLocator, PSX_RAM_SIZE } = require('../ui/memory');
const { buildProbes, parsePsxExe } = require('../src/disc');

const textSize = 0x60000;
const exe = Buffer.alloc(0x800 + textSize);
exe.write('PS-X EXE', 0, 'ascii');
exe.writeUInt32LE(0x80010000, 0x18);
exe.writeUInt32LE(textSize, 0x1c);
crypto.randomFillSync(exe, 0x800);
const probes = buildProbes(exe, parsePsxExe(exe));

const memory = new WebAssembly.Memory({ initial: 256 }); // 16 MB heap
const heap = new Uint8Array(memory.buffer);
const RAM_BASE = 0x5a3010; // 16-byte aligned, like a malloc'd block
// "Load" the exe into RAM.
heap.set(exe.subarray(0x800), RAM_BASE + 0x10000);
// Relics: own Soul of Bat (0) and Form of Mist (7).
heap[RAM_BASE + 0x97964 + 0] = 1;
heap[RAM_BASE + 0x97964 + 7] = 3;
// Decoy: a copy of the first probe elsewhere (e.g. a CD sector cache).
heap.set(probes[0].bytes, 0x200040);
assert.ok(RAM_BASE + PSX_RAM_SIZE < heap.length);

const loc = new RamLocator();
loc.reset(probes);
const hook = { memories: [memory], exportsList: [] };
let st, steps = 0;
do { st = loc.step(hook); steps++; } while (st === 'searching' && steps < 1000);
assert.strictEqual(st, 'ready');
assert.strictEqual(loc.base, RAM_BASE);
const relics = loc.read(0x97964, 30);
assert.strictEqual(relics[0], 1);
assert.strictEqual(relics[7], 3);
assert.ok(loc.stillValid());

// Retro API path.
const loc2 = new RamLocator();
loc2.reset(probes);
const ex = { retro_get_memory_data: (id) => (id === 2 ? RAM_BASE : 0), retro_get_memory_size: (id) => (id === 2 ? PSX_RAM_SIZE : 0) };
assert.strictEqual(loc2.step({ memories: [memory], exportsList: [ex] }), 'ready');
assert.strictEqual(loc2.base, RAM_BASE);

console.log('memory.test.js ok — found RAM in', steps, 'steps');
