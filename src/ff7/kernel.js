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

// `room`: how far the file may grow (the end of its last sector on the disc); by default its original size.
function build(k, room = k.length) {
  const pack = (squeeze) => {
    const parts = [];
    for (const s of k.sections) {
      let body = s.dirty ? writeMember(s.header, s.data) : s.original;
      // Short of room: untouched sections are recompressed too, kept only where that comes out smaller.
      if (squeeze && !s.dirty) {
        const re = writeMember(s.header, s.data);
        if (re.length < body.length) body = re;
      }
      if (body.length > 0xffff) throw new Error('KERNEL.BIN section too large');
      const h = Buffer.alloc(6);
      h.writeUInt16LE(body.length, 0);
      h.writeUInt16LE(s.data.length, 2);
      h.writeUInt16LE(s.type, 4);
      parts.push(h, body);
    }
    return Buffer.concat(parts);
  };
  let out = pack(false);
  if (out.length > k.length) out = pack(true);
  if (out.length > room) {
    const e = new Error(`KERNEL.BIN grew by ${out.length - room} bytes more than there's room for on the disc.`);
    e.kernelTooBig = out.length - room;
    throw e;
  }
  // At least the original size (zero fill), so nothing else moves; longer only into the last sector's spare room.
  return out.length >= k.length ? out : Buffer.concat([out, Buffer.alloc(k.length - out.length)]);
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

// A materia slot list: slots fill from the left, and a linked pair is a "left" value (2 or 6) at an even
// position followed by a "right" value (3 or 7).
function slotsOk(bytes) {
  let seenEmpty = false;
  for (let j = 0; j < bytes.length; j++) {
    const b = bytes[j];
    if (!SLOT_VALUES.has(b)) return false;
    if (b === 0) { seenEmpty = true; continue; }
    if (seenEmpty) return false;
    if (b === 2 || b === 6) { if (j % 2 || (bytes[j + 1] !== 3 && bytes[j + 1] !== 7)) return false; }
    if (b === 3 || b === 7) { if (!(j % 2) || (bytes[j - 1] !== 2 && bytes[j - 1] !== 6)) return false; }
  }
  return true;
}

const named = (list, i) => !!(list[i] && list[i].trim());
const bits = (v) => { let c = 0; for (; v; v &= v - 1) c++; return c; };

// Where the materia slots sit in each record. The documented offset is tried first; if this disc's data doesn't
// fit it, every other offset is tried and the one where the slot lists make sense for (nearly) every named record
// wins. Returns { at, good, total } or null.
function findSlots(data, size, count, names, preferred) {
  const score = (off) => {
    let good = 0, used = 0, total = 0;
    for (let i = 0; i < count; i++) {
      if (!named(names, i)) continue;
      total++;
      const b = data.subarray(i * size + off, i * size + off + 8);
      if (slotsOk(b)) { good++; if (b[0]) used++; }
    }
    const ok = total > 0 && good >= total - Math.max(2, Math.floor(total * 0.05)) && used >= total * 0.6;
    return { at: off, good, used, total, ok };
  };
  const first = score(preferred);
  if (first.ok) return first;
  let best = null;
  for (let off = 0; off <= size - 8; off++) {
    const r = score(off);
    if (r.ok && (!best || r.good + r.used > best.good + best.used)) best = r;
  }
  return best ? best : { ...first, ok: false };
}

// A growth byte is 0-3 (none, normal, double, triple) on nearly every record.
function growthOk(data, size, count, names, at) {
  let n = 0, good = 0;
  for (let i = 0; i < count; i++) { if (!named(names, i)) continue; n++; if (data[i * size + at] <= 3) good++; }
  return n > 0 && good >= n * 0.9;
}

// Where the equip mask (u16, one bit per character) sits in a weapon record: each starting character's weapon
// must allow that character, and few others.
function findEquip(w, starts, preferred) {
  const score = (off) => starts.filter(({ c, wi }) => {
    const m = w.readUInt16LE(wi * SIZES.weapon + off);
    return (m & (1 << c)) && bits(m & 0x7ff) <= 2;
  }).length;
  const need = Math.max(5, starts.length - 1);
  if (score(preferred) >= need) return preferred;
  let best = -1, bestScore = 0;
  for (let off = 0; off <= SIZES.weapon - 2; off += 2) {
    const sc = score(off);
    if (sc >= need && sc > bestScore) { best = off; bestScore = sc; }
  }
  return best;
}

// Returns { ok: {init, weapons, armor, names, equipMask}, problems: [], layout }. The layout found is also kept
// on the kernel (k.layout) for the seed generator.
function validate(k) {
  const problems = [];
  const ok = { init: false, weapons: false, armor: false, names: false, equipMask: false };
  const layout = {
    weapon: { slots: WEAPON.slots, growth: WEAPON.growth, equip: WEAPON.equip },
    armor: { slots: ARMOR.slots, growth: ARMOR.growth },
    weaponBase: 0,
  };
  k.layout = layout;
  const n = allNames(k);
  const w = sec(k, SECTION.weapons), a = sec(k, SECTION.armor), m = sec(k, SECTION.materia), init = sec(k, SECTION.init);

  if (n.materia.length >= 90 && n.weapons.length >= 120 && n.armor.length >= 30 && n.items.length >= 120) ok.names = true;
  else problems.push(`Name tables look wrong (materia ${n.materia.length}, weapons ${n.weapons.length}, armor ${n.armor.length}, items ${n.items.length}).`);

  if (w && w.data.length === 128 * SIZES.weapon) {
    const r = findSlots(w.data, SIZES.weapon, 128, n.weapons, WEAPON.slots);
    if (r.ok) {
      ok.weapons = true;
      layout.weapon.slots = r.at;
      layout.weapon.growth = growthOk(w.data, SIZES.weapon, 128, n.weapons, WEAPON.growth) ? WEAPON.growth : null;
    } else problems.push(`Weapon materia slots don't parse (${r.good}/${r.total} records fit at 0x${r.at.toString(16)}, and no other offset fits).`);
  } else problems.push(`Weapon data section is ${w ? w.data.length : 0} bytes, expected ${128 * SIZES.weapon}.`);

  if (a && a.data.length === 32 * SIZES.armor) {
    const r = findSlots(a.data, SIZES.armor, 32, n.armor, ARMOR.slots);
    if (r.ok) {
      ok.armor = true;
      layout.armor.slots = r.at;
      layout.armor.growth = growthOk(a.data, SIZES.armor, 32, n.armor, ARMOR.growth) ? ARMOR.growth : null;
    } else problems.push(`Armor materia slots don't parse (${r.good}/${r.total} records fit at 0x${r.at.toString(16)}, and no other offset fits).`);
  } else problems.push(`Armor data section is ${a ? a.data.length : 0} bytes, expected ${32 * SIZES.armor}.`);

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

  // Equip masks, checked against each character's starting weapon. The starting weapon byte is the weapon's
  // number in the weapon list; some data counts weapons from 128 (their item number), so both are accepted.
  if (w && w.data.length === 128 * SIZES.weapon && ok.init) {
    const raw = [];
    for (let c = 0; c < 9; c++) { const { buf, at } = charRecord(k, c); raw.push(buf[at + CHAR.weapon]); }
    const real = raw.filter((v) => v !== 0xff);
    layout.weaponBase = real.length && real.every((v) => v >= 128) ? 128 : 0;
    // The equip bit is the character's own id, which isn't always the slot: at the start, slots 6 and 7 hold
    // Young Cloud (id 9) and Sephiroth (id 10) for the flashback.
    const starts = raw.map((v, slot) => { const { buf, at } = charRecord(k, slot); return { c: buf[at + CHAR.id], wi: v - layout.weaponBase }; })
      .filter((x) => x.wi >= 0 && x.wi < 128 && x.c <= 10);
    const at = findEquip(w.data, starts, WEAPON.equip);
    if (at >= 0) { ok.equipMask = true; layout.weapon.equip = at; }
    else problems.push(`Weapon equip masks don't check out (starting weapons ${raw.map((v) => '0x' + v.toString(16)).join(' ')}; at 0x${WEAPON.equip.toString(16)} the masks are ${starts.map(({ wi }) => '0x' + w.data.readUInt16LE(wi * SIZES.weapon + WEAPON.equip).toString(16)).join(' ')}).`);
  }
  return { ok, problems, layout };
}

const countSlots = (bytes) => bytes.filter((b) => b !== 0).length;

module.exports = {
  parse, build, validate, allNames, itemName, charRecord, countSlots, slotsOk,
  SECTION, TEXT, SIZES, CHAR, INIT, WEAPON, ARMOR,
};
