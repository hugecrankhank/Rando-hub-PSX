// INIT/KERNEL.BIN: a run of gzip sections, each with a 6-byte header
// (u16 compressed size, u16 uncompressed size, u16 type). Sections 0-8 are game
// data (we use init data, weapons, armor and materia); the rest are text.
//
// Every layout assumption here is checked against the player's own disc in
// validate(). Anything that doesn't check out is reported, and the seed
// generator turns that feature off instead of writing bad data.
'use strict';

const { readMember, writeMember } = require('./gzip');
const { decode, decodeTable } = require('./text');

const SECTION = { init: 3, items: 4, weapons: 5, armor: 6, accessories: 7, materia: 8 };
const TEXT = { itemNames: 19, weaponNames: 20, armorNames: 21, accessoryNames: 22, materiaNames: 23, keyItemNames: 24 };
const SIZES = { weapon: 44, armor: 36, accessory: 16, materia: 20, item: 28 };

// Character record (same layout as the save file).
const CHAR = {
  size: 0x84, id: 0x00, level: 0x01, name: 0x10,
  weapon: 0x1c, armor: 0x1d, accessory: 0x1e,
  weaponMateria: 0x40, armorMateria: 0x60,
};
// Init data = save file from 0x54 on: 9 characters, party, items, materia.
const INIT = { chars: 0x000, party: 0x4a4, items: 0x4a8, itemCount: 320, materia: 0x728, materiaCount: 200 };
const WEAPON = { growth: 0x06, equip: 0x0e, slots: 0x1c };
const ARMOR = { slots: 0x08, growth: 0x10 };
const SLOT_VALUES = new Set([0, 1, 2, 3, 5, 6, 7]);

function parse(buf) {
  const sections = [];
  let p = 0;
  while (p + 6 <= buf.length) {
    const comp = buf.readUInt16LE(p);
    const raw = buf.readUInt16LE(p + 2);
    const type = buf.readUInt16LE(p + 4);
    if (comp === 0 || p + 6 + comp > buf.length) break;
    if (buf[p + 6] !== 0x1f || buf[p + 7] !== 0x8b) break;
    const original = Buffer.from(buf.subarray(p + 6, p + 6 + comp));
    const m = readMember(original, 0);
    sections.push({ type, raw, original, header: m.header, data: m.data, dirty: false });
    p += 6 + comp;
  }
  if (sections.length < 25) throw new Error(`KERNEL.BIN: found ${sections.length} sections, expected 27.`);
  return { sections, length: buf.length, used: p };
}

function build(k) {
  const parts = [];
  for (const s of k.sections) {
    const body = s.dirty ? writeMember(s.header, s.data) : s.original;
    if (body.length > 0xffff) throw new Error('KERNEL.BIN section too large');
    const h = Buffer.alloc(6);
    h.writeUInt16LE(body.length, 0);
    h.writeUInt16LE(s.data.length, 2);
    h.writeUInt16LE(s.type, 4);
    parts.push(h, body);
  }
  const out = Buffer.concat(parts);
  if (out.length > k.length) {
    throw new Error(`KERNEL.BIN grew by ${out.length - k.length} bytes and won't fit on the disc.`);
  }
  // Same size as the original so the game's file table stays right; zero fill.
  return Buffer.concat([out, Buffer.alloc(k.length - out.length)]);
}

const sec = (k, i) => k.sections[i];
const names = (k, i) => (k.sections[i] ? decodeTable(k.sections[i].data) : []);

function allNames(k) {
  return {
    items: names(k, TEXT.itemNames),
    weapons: names(k, TEXT.weaponNames),
    armor: names(k, TEXT.armorNames),
    accessories: names(k, TEXT.accessoryNames),
    materia: names(k, TEXT.materiaNames),
    keyItems: names(k, TEXT.keyItemNames),
  };
}

// Unified item id (as used in drops, steals and the inventory): 0-127 items,
// 128-255 weapons, 256-287 armor, 288-319 accessories.
function itemName(n, id) {
  if (id < 128) return n.items[id] || `Item ${id}`;
  if (id < 256) return n.weapons[id - 128] || `Weapon ${id - 128}`;
  if (id < 288) return n.armor[id - 256] || `Armor ${id - 256}`;
  if (id < 320) return n.accessories[id - 288] || `Accessory ${id - 288}`;
  return `#${id}`;
}

function charRecord(k, i) {
  const d = sec(k, SECTION.init).data;
  return { buf: d, at: INIT.chars + i * CHAR.size };
}

function slotsOk(bytes) {
  let seenEmpty = false;
  for (const b of bytes) {
    if (!SLOT_VALUES.has(b)) return false;
    if (b === 0) seenEmpty = true;
    else if (seenEmpty) return false; // slots fill from the left
  }
  return true;
}

// Returns { ok: {init, weapons, armor, names}, problems: [] }
function validate(k) {
  const problems = [];
  const ok = { init: false, weapons: false, armor: false, names: false, equipMask: false };
  const n = allNames(k);
  const w = sec(k, SECTION.weapons), a = sec(k, SECTION.armor), m = sec(k, SECTION.materia), init = sec(k, SECTION.init);

  if (n.materia.length >= 90 && n.weapons.length >= 120 && n.armor.length >= 30 && n.items.length >= 120) ok.names = true;
  else problems.push(`Name tables look wrong (materia ${n.materia.length}, weapons ${n.weapons.length}).`);

  if (w && w.data.length === 128 * SIZES.weapon) {
    let bad = 0;
    for (let i = 0; i < 128; i++) if (!slotsOk(w.data.subarray(i * 44 + WEAPON.slots, i * 44 + WEAPON.slots + 8))) bad++;
    if (bad <= 4) ok.weapons = true; else problems.push(`Weapon materia slots don't parse (${bad} odd).`);
  } else problems.push('Weapon data section has an unexpected size.');

  if (a && a.data.length === 32 * SIZES.armor) {
    let bad = 0;
    for (let i = 0; i < 32; i++) if (!slotsOk(a.data.subarray(i * 36 + ARMOR.slots, i * 36 + ARMOR.slots + 8))) bad++;
    if (bad <= 2) ok.armor = true; else problems.push(`Armor materia slots don't parse (${bad} odd).`);
  } else problems.push('Armor data section has an unexpected size.');

  if (!m || m.data.length < 90 * SIZES.materia) problems.push('Materia data section has an unexpected size.');

  if (init && init.data.length >= INIT.materia + INIT.materiaCount * 4) {
    let good = 0;
    for (let i = 0; i < 9; i++) {
      const { buf, at } = charRecord(k, i);
      const id = buf[at + CHAR.id], lvl = buf[at + CHAR.level];
      if ((id === i || (i === 6 && id === 9) || (i === 7 && id === 10)) && lvl >= 1 && lvl <= 99) good++;
    }
    const first = decode(init.data, CHAR.name, CHAR.name + 12);
    if (good === 9) ok.init = true;
    else problems.push(`Starting characters don't parse (${good}/9, first name "${first}").`);
  } else problems.push('Init data section has an unexpected size.');

  // Equip masks: Cloud's starting weapon must be Cloud-only.
  if (ok.weapons && ok.init) {
    const { buf, at } = charRecord(k, 0);
    const wi = buf[at + CHAR.weapon];
    const mask = w.data.readUInt16LE(wi * 44 + WEAPON.equip);
    if (wi < 128 && (mask & 1) && !(mask & ~0x201 & 0x7ff)) ok.equipMask = true;
    else problems.push('Weapon equip masks don\'t check out.');
  }
  return { ok, problems };
}

const countSlots = (bytes) => bytes.filter((b) => b !== 0).length;

module.exports = {
  parse, build, validate, allNames, itemName, charRecord, countSlots, slotsOk,
  SECTION, TEXT, SIZES, CHAR, INIT, WEAPON, ARMOR,
};
