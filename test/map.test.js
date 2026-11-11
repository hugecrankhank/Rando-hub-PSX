// Map-tracker logic: extension chain, preset locks/allowed, reachability, markers.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadMapModel } = require('../src/sotn-map');
const SotnMap = require('../ui/sotn-map');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-'));
const w = (p, o) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), JSON.stringify(o)); };

w('Extensions/classic.json', { locations: [
  { location: 'Soul of Bat', x: 192, y: 66, secondCastle: false, rooms: [{ address: '0x06BCCF', values: '0x01' }] },
  { location: 'Form of Mist', x: 84, y: 70, secondCastle: false, rooms: [{ address: '0x06BCD9', values: '0x14' }] },
  { location: 'Holy glasses', x: 128, y: 106, secondCastle: false, rooms: [{ address: '0x06BD6C', values: '0x40' }] },
  { location: 'Eye of Vlad', x: 132, y: 57, secondCastle: true, rooms: [{ address: '0x06C0EC', values: '0x50' }] },
] });
w('Extensions/guarded.json', { extends: 'classic', locations: [
  { location: 'Crystal cloak', x: 160, y: 134, secondCastle: false, rooms: [{ address: '0x06BDDE', values: '0x40' }] },
] });
w('Presets/sequence-breaker.json', { metadata: { id: 'sequence-breaker' }, lockLocation: [
  { location: 'Soul of Bat', locks: ['Leap Stone'] },
] });
w('Presets/parent.json', { metadata: { id: 'parent' }, lockLocation: [
  { location: 'Crystal cloak', locks: ['Jewel of Open'] },
] });
w('Presets/safe.json', { metadata: { id: 'safe' }, inherits: 'parent', alias: [{ relic: 'Form of Mist', alias: 'Mist' }], lockLocation: [
  { location: 'Soul of Bat', locks: ['Mist'] },
  { location: 'Holy glasses', locks: ['Soul of Bat + Silver ring + Gold ring'] },
  { location: 'Form of Mist', locks: [] },
] });

const m = loadMapModel({ srtDir: dir, presetId: 'safe' });
assert.strictEqual(m.locations.length, 5, 'guarded extends classic');
const idx = (n) => m.locations.findIndex((l) => l.name === n);
const owned = new Set();
let colors = SotnMap.computeColors(m, owned, new Set());
assert.strictEqual(colors[idx('Form of Mist')], 'available', 'no locks = available');
assert.strictEqual(colors[idx('Soul of Bat')], 'unavailable', 'needs mist (alias)');
assert.strictEqual(colors[idx('Crystal cloak')], 'unavailable', 'inherited lock');
assert.strictEqual(colors[idx('Eye of Vlad')], 'available', 'unlocked location stays available');

owned.add(13); // Leap Stone -> sequence-breaker allows Soul of Bat out of logic
colors = SotnMap.computeColors(m, owned, new Set());
assert.strictEqual(colors[idx('Soul of Bat')], 'allowed');
owned.add(7); // Form of Mist
colors = SotnMap.computeColors(m, owned, new Set());
assert.strictEqual(colors[idx('Soul of Bat')], 'available');
assert.strictEqual(colors[idx('Holy glasses')], 'unavailable');
[0, 30, 31].forEach((a) => owned.add(a)); // bat + both rings
colors = SotnMap.computeColors(m, owned, new Set());
assert.strictEqual(colors[idx('Holy glasses')], 'available', 'key items in locks');

// Visited from RAM bits.
const ram = { 0x06bcd9: 0x04 };
const visited = SotnMap.visitedFromRam(m, (a) => ram[a] ?? 0);
assert.ok(visited.has(idx('Form of Mist')) && visited.size === 1);

// Markers: first castle hides visited + second-castle checks; second castle flips.
const first = SotnMap.markers(m, colors, visited, false);
assert.ok(!first.some((k) => k.name === 'Form of Mist' || k.name === 'Eye of Vlad'));
const bat = first.find((k) => k.name === 'Soul of Bat');
assert.deepStrictEqual([bat.x, bat.y, bat.w, bat.h], [192, 65, 5, 5]);
const inv = SotnMap.markers(m, colors, visited, true);
assert.deepStrictEqual(inv.map((k) => [k.name, k.x, k.y + 1]), [['Eye of Vlad', 120, 142]]);

// Unknown preset falls back to classic locations with no logic.
const none = loadMapModel({ srtDir: dir, presetId: 'nope' });
assert.strictEqual(none.locations.length, 4);
assert.ok(SotnMap.computeColors(none, new Set(), new Set()).every((c) => c === 'available'));

console.log('map.test.js ok');
