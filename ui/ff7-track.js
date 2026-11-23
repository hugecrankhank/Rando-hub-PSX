// FF7 auto-tracker: finds the save data block in PS1 RAM and reads the party,
// levels, materia, gil and play time from it. Read-only.
//
// The save block's usual USA address is 0x8009C6E4, but rather than trust one
// address we look for its shape: nine 0x84-byte character records with ids
// 0..8 and sane levels. That also tells us when a game is actually loaded.
(function (root) {
  'use strict';

  const HINT = 0x09c6e4;
  const S = {
    chars: 0x54, charSize: 0x84, party: 0x4f8, items: 0x4fc, materia: 0x77c, materiaCount: 200,
    gil: 0xb7c, seconds: 0xb80, field: 0xb92, progress: 0xba4,
  };
  const C = { id: 0, level: 1, name: 0x10, weapon: 0x1c, armor: 0x1d, accessory: 0x1e, hp: 0x2c, maxHp: 0x38, wMat: 0x40, aMat: 0x60 };
  const CHAR_NAMES = ['Cloud', 'Barret', 'Tifa', 'Aeris', 'Red XIII', 'Yuffie', 'Cait Sith', 'Vincent', 'Cid', 'Young Cloud', 'Sephiroth'];
  const SIZE = S.progress + 2;

  function looksLikeSave(ram, base) {
    if (base < 0 || base + SIZE > ram.length) return false;
    for (let i = 0; i < 9; i++) {
      const at = base + S.chars + i * S.charSize;
      const id = ram[at + C.id], lvl = ram[at + C.level];
      if (!(id === i || (i === 6 && id === 9) || (i === 7 && id === 10))) return false;
      if (lvl < 1 || lvl > 99) return false;
      // Name: printable FF7 characters, then 0xFF.
      const n0 = ram[at + C.name];
      if (n0 === 0xff || n0 >= 0x60) return false;
    }
    // Party slots: character ids or 0xFF.
    for (let i = 0; i < 3; i++) {
      const p = ram[base + S.party + i];
      if (p !== 0xff && p > 10) return false;
    }
    return true;
  }

  // ram: Uint8Array view of PS1 main RAM (2 MB). Returns the save block offset or -1.
  function findSave(ram, last) {
    if (last >= 0 && looksLikeSave(ram, last)) return last;
    if (looksLikeSave(ram, HINT)) return HINT;
    for (let base = 0; base + SIZE <= ram.length; base += 4) {
      if (ram[base + S.chars] !== 0 || ram[base + S.chars + S.charSize] !== 1) continue;
      if (looksLikeSave(ram, base)) return base;
    }
    return -1;
  }

  const u16 = (b, i) => b[i] | (b[i + 1] << 8);
  const u32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

  function decodeName(b, at, len) {
    let s = '';
    for (let i = 0; i < len; i++) {
      const c = b[at + i];
      if (c === 0xff) break;
      if (c < 0x60) s += String.fromCharCode(c + 0x20);
    }
    return s.trim();
  }

  // Read everything the tracker shows. `block` starts at the save block.
  function readSave(block) {
    const chars = [];
    const materia = new Set();
    const addMat = (v) => { if (v !== 0xffffffff && (v & 0xff) !== 0xff) materia.add(v & 0xff); };
    for (let i = 0; i < 9; i++) {
      const at = S.chars + i * S.charSize;
      const id = block[at + C.id];
      const mats = [];
      for (let j = 0; j < 16; j++) {
        const v = u32(block, at + C.wMat + j * 4);
        addMat(v);
        if (v !== 0xffffffff) mats.push(v & 0xff);
      }
      chars.push({
        slot: i, id, defaultName: CHAR_NAMES[id] || CHAR_NAMES[i],
        name: decodeName(block, at + C.name, 12) || CHAR_NAMES[id] || CHAR_NAMES[i],
        level: block[at + C.level],
        weapon: block[at + C.weapon], armor: block[at + C.armor], accessory: block[at + C.accessory],
        materia: mats,
      });
    }
    for (let j = 0; j < S.materiaCount; j++) addMat(u32(block, S.materia + j * 4));
    const party = [0, 1, 2].map((i) => block[S.party + i]).filter((p) => p !== 0xff);
    const items = new Map();
    for (let j = 0; j < 320; j++) {
      const v = u16(block, S.items + j * 2);
      if (v === 0xffff) continue;
      const id = v & 0x1ff, qty = v >> 9;
      if (qty) items.set(id, (items.get(id) || 0) + qty);
    }
    return {
      chars, party, materia, items,
      gil: u32(block, S.gil),
      seconds: u32(block, S.seconds),
      field: u16(block, S.field),
      progress: u16(block, S.progress),
    };
  }

  const api = { findSave, looksLikeSave, readSave, SAVE: S, SAVE_SIZE: SIZE, HINT, CHAR_NAMES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FF7Track = api;
})(typeof window !== 'undefined' ? window : globalThis);
