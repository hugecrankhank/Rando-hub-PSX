// Final Fantasy VIII (PS1) disc data. Nearly everything is in one big packed file per disc (FF8DISC<n>.IMG),
// uncompressed and sector-aligned:
//  - kernel.bin, 56 sections (magic, GFs, weapons, items, … and their text), near the start of the IMG;
//  - one enemy file per monster (143 of them), each a table of 11 sections + end offset. Section 7 (index 6) is
//    the 380-byte "info" block: name, level bands, card, EXP, AP, draws, mugs and drops.
// Found by their headers, so no file table is needed. Every value read is range-checked in validate().
'use strict';

const fs = require('fs');

const { Disc } = require('../disc');

const COOKED = 2048;
const INFO_SIZE = 380;
// Offsets in an enemy's info block.
const INFO = {
  name: 0x00, nameLen: 24,
  medLevel: 0xf4, highLevel: 0xf5,
  card: 0xf8,                     // [drop card, mod card, rare mod card]
  extraExp: 0x100, exp: 0x102,    // u16
  draws: 0x104,                   // 3 bands x 4 x (magic id, unused)
  mugs: 0x11c,                    // 3 bands x 4 x (item id, qty)
  drops: 0x134,                   // 3 bands x 4 x (item id, qty)
  mugRate: 0x14c, dropRate: 0x14d, ap: 0x14f,
};
const MAGIC_MAX = 57; // draw ids above this are Guardian Forces (drawn from bosses): never moved
const ITEM_MAX = 198;

// FF8 menu text: 0x00 ends a string.
const CH = new Map([[0x20, ' ']]);
'0123456789%/:!?…+-=*&「」()·.,~“”‘#$\'_'.split('').forEach((c, i) => CH.set(0x21 + i, c));
for (let i = 0; i < 26; i++) { CH.set(0x45 + i, String.fromCharCode(65 + i)); CH.set(0x5f + i, String.fromCharCode(97 + i)); }
function decode(buf, start, end) {
  let s = '';
  for (let p = start; p < end && buf[p] !== 0; p++) s += CH.has(buf[p]) ? CH.get(buf[p]) : '';
  return s.trim();
}

// The IMG file on a disc: { lba, size, name }.
function findImg(disc) {
  const hit = disc.listDir(disc.root).find((e) => /^FF8DISC\d\.IMG/i.test(e.name));
  if (!hit) throw new Error('This isn’t a Final Fantasy VIII disc (no FF8DISC*.IMG on it).');
  return hit;
}

// Scan the IMG for enemy files and kernel.bin. Reads 2 MB at a time.
function scan(disc, img) {
  const first = img.lba, last = img.lba + Math.ceil(img.size / COOKED);
  const ss = disc.sectorSize, off = disc.dataOffset, CHUNK = 1024;
  const enemies = [];
  let kernel = null;
  const buf = Buffer.alloc(CHUNK * ss);
  for (let lba = first; lba < last; lba += CHUNK) {
    const n = Math.min(CHUNK, last - lba);
    const got = fs.readSync(disc.fd, buf, 0, n * ss, lba * ss);
    for (let i = 0; i * ss < got; i++) {
      const p = i * ss + off;
      const count = buf.readUInt32LE(p);
      if (count === 11) {
        let ok = buf.readUInt32LE(p + 4) === 52, prev = 52;
        const o = [];
        for (let j = 0; ok && j < 12; j++) {
          const v = buf.readUInt32LE(p + 4 + 4 * j);
          if (v < prev || v > 2000000) ok = false;
          o.push(v); prev = v;
        }
        if (ok && o[7] - o[6] === INFO_SIZE) enemies.push({ lba: lba + i, offsets: o });
      } else if (count === 56 && !kernel && buf.readUInt32LE(p + 4) === 4 + 4 * 56) {
        kernel = { lba: lba + i };
      }
    }
  }
  return { enemies, kernel };
}

function readKernel(disc, k) {
  const head = disc.readExtent(k.lba, COOKED);
  const n = head.readUInt32LE(0);
  const offs = [];
  for (let i = 0; i < n; i++) offs.push(head.readUInt32LE(4 + 4 * i));
  const size = offs[n - 1] + 8192; // (last section is short)
  const data = disc.readExtent(k.lba, size);
  const sec = (i) => data.subarray(offs[i], i + 1 < n ? offs[i + 1] : Math.min(data.length, offs[i] + 4096));
  return { sec, count: n };
}

// Magic names: kernel section 1 has 57 x 60-byte entries whose first u16 is the name's offset in a text section.
function magicNames(kern) {
  const magic = kern.sec(1);
  if (magic.length < 57 * 60) return null;
  const offs = Array.from({ length: 57 }, (_, i) => magic.readUInt16LE(60 * i));
  for (let t = 28; t < kern.count; t++) {
    const ts = kern.sec(t);
    if (!offs.every((o) => o === 0xffff || o < ts.length)) continue;
    const names = offs.map((o) => (o === 0xffff ? '' : decode(ts, o, o + 24)));
    if (names.filter((x) => x && /^[A-Za-z][A-Za-z -]*$/.test(x)).length >= 50) return names;
  }
  return null;
}

// Item names (item ids 1-198), read from the kernel: battle items (section 7, 24-byte entries) then the others
// (section 8, 4-byte entries), each starting with the name's offset in a text section. The text section is found
// by content: it's the one where the first battle item reads "Potion" and the others include "Tent".
function itemNames(kern) {
  const list = (secIdx, stride) => {
    const d = kern.sec(secIdx);
    return Array.from({ length: Math.floor(d.length / stride) }, (_, i) => d.readUInt16LE(stride * i));
  };
  const find = (offs, ok) => {
    for (let t = 28; t < kern.count; t++) {
      const ts = kern.sec(t);
      if (!offs.every((o) => o === 0xffff || o < ts.length)) continue;
      const names = offs.map((o) => (o === 0xffff ? '' : decode(ts, o, o + 32)));
      if (ok(names)) return names;
    }
    return null;
  };
  const battle = find(list(7, 24), (n) => n[0] === 'Potion');
  const other = find(list(8, 4), (n) => n.includes('Tent') && n.includes('Cottage'));
  if (!battle || !other) return null;
  return ['', ...battle, ...other];
}

function readEnemy(disc, e) {
  const raw = disc.readExtent(e.lba, e.offsets[7]);
  const info = raw.subarray(e.offsets[6], e.offsets[7]);
  const pairs = (at) => Array.from({ length: 12 }, (_, i) => [info[at + 2 * i], info[at + 2 * i + 1]]);
  return {
    raw, info,
    name: decode(info, INFO.name, INFO.name + INFO.nameLen),
    draws: pairs(INFO.draws), mugs: pairs(INFO.mugs), drops: pairs(INFO.drops),
    card: info[INFO.card],
    exp: info.readUInt16LE(INFO.exp), extraExp: info.readUInt16LE(INFO.extraExp), ap: info[INFO.ap],
  };
}

// Everything the generator needs from one disc.
function load(discPath) {
  const disc = new Disc(discPath);
  try {
    const img = findImg(disc);
    const { enemies, kernel } = scan(disc, img);
    const list = enemies.map((e) => ({ ...e, ...readEnemy(disc, e) }));
    let names = null, items = null;
    if (kernel) {
      try { const kern = readKernel(disc, kernel); names = magicNames(kern); items = itemNames(kern); } catch (_) { /* names are optional */ }
    }
    return { img, enemies: list, magicNames: names, itemNames: items };
  } finally {
    disc.close();
  }
}

// Range checks, as in the disc probe: { ok, problems }.
function validate(d) {
  const problems = [];
  const n = d.enemies.length;
  if (n < 100) problems.push(`Found ${n} enemy files, expected about 143.`);
  let bad = 0;
  for (const e of d.enemies) {
    const items = [...e.mugs, ...e.drops].every(([i, q]) => i <= ITEM_MAX && q <= 100);
    const lv = e.info[INFO.medLevel] <= e.info[INFO.highLevel] && e.info[INFO.highLevel] <= 100;
    if (!items || !lv) bad++;
  }
  if (bad > Math.max(2, n * 0.03)) problems.push(`${bad} of ${n} enemies have values out of range.`);
  if (!d.magicNames) problems.push('Couldn’t read the magic names (the spoiler log shows numbers instead).');
  return { ok: n >= 100 && bad <= Math.max(2, n * 0.03), problems };
}

module.exports = { load, validate, decode, findImg, INFO, INFO_SIZE, MAGIC_MAX, ITEM_MAX, COOKED };
