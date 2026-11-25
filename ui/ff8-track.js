// FF8 auto-tracker: finds the save data block ("savemap") in PS1 RAM and reads the GFs, the 8 characters, the
// party, gil, items and play time from it. Read-only.
//
// Layout checked on a real USA Disc 1 run (New Game): savemap at RAM 0x077378, u16 0x08FF at +2, Squall's name at
// +0x18, 16 GF records (68 bytes) from +0x50, 8 character records (152 bytes) from +0x490, then shops, config,
// party, Griever's name, gil, limit/Angelo data, item battle order, 198 item slots (id, qty) and play time.
(function (root) {
  'use strict';

  const HINT = 0x077378;
  const S = {
    magic: 0x02, gfs: 0x50, gfSize: 68, chars: 0x490, charSize: 152,
    party: 0xaf4, griever: 0xafc, gil: 0xb0c, items: 0xb44, itemCount: 198, seconds: 0xcd0,
  };
  const G = { name: 0x00, exp: 0x0c, exists: 0x11, hp: 0x12 };
  const C = { hp: 0x00, exp: 0x04, model: 0x08, weapon: 0x09, exists: 0x94 };
  const CHAR_NAMES = ['Squall', 'Zell', 'Irvine', 'Quistis', 'Rinoa', 'Selphie', 'Seifer', 'Edea'];
  const GF_NAMES = ['Quezacotl', 'Shiva', 'Ifrit', 'Siren', 'Brothers', 'Diablos', 'Carbuncle', 'Leviathan', 'Pandemona', 'Cerberus', 'Alexander', 'Doomtrain', 'Bahamut', 'Cactuar', 'Tonberry', 'Eden'];
  const SIZE = S.seconds + 4;

  const u16 = (b, i) => b[i] | (b[i + 1] << 8);
  const u32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

  function looksLikeSave(ram, base) {
    if (base < 0 || base + SIZE > ram.length) return false;
    if (u16(ram, base + S.magic) !== 0x08ff) return false;
    // Character records: model id = slot for most of them (costume changes can move one or two).
    let models = 0;
    for (let i = 0; i < 8; i++) if (ram[base + S.chars + i * S.charSize + C.model] === i) models++;
    if (models < 6) return false;
    // Party: three character ids or 0xFF, then 0xFF.
    for (let i = 0; i < 3; i++) { const p = ram[base + S.party + i]; if (p !== 0xff && p > 7) return false; }
    // Items: ids 0..198, an empty slot has quantity 0.
    for (let j = 0; j < S.itemCount; j++) { const id = ram[base + S.items + 2 * j], q = ram[base + S.items + 2 * j + 1]; if (id > 198 || q > 100) return false; }
    return true;
  }

  // ram: PS1 main RAM (2 MB). Returns the savemap offset or -1.
  function findSave(ram, last) {
    if (last >= 0 && looksLikeSave(ram, last)) return last;
    if (looksLikeSave(ram, HINT)) return HINT;
    for (let base = 0; base + SIZE <= ram.length; base += 4) {
      if (ram[base + 2] !== 0xff || ram[base + 3] !== 0x08) continue;
      if (looksLikeSave(ram, base)) return base;
    }
    return -1;
  }

  const CH = ' 0123456789%/:!?…+-=*&「」()·.,~“”‘#$\'_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  function decodeName(b, at, len) {
    let s = '';
    for (let i = 0; i < len; i++) {
      const c = b[at + i];
      if (c === 0) break;
      if (c >= 0x20 && c - 0x20 < CH.length) s += CH[c - 0x20];
    }
    return s.trim();
  }

  function readSave(block) {
    const gfs = [];
    for (let g = 0; g < 16; g++) {
      const at = S.gfs + g * S.gfSize;
      gfs.push({ id: g, name: decodeName(block, at + G.name, 12) || GF_NAMES[g], owned: !!(block[at + G.exists] & 1), exp: u32(block, at + G.exp) });
    }
    const chars = [];
    for (let i = 0; i < 8; i++) {
      const at = S.chars + i * S.charSize;
      const exp = u32(block, at + C.exp);
      chars.push({ id: i, name: CHAR_NAMES[i], joined: block[at + C.exists] !== 0, exp, level: Math.min(100, Math.floor(exp / 1000) + 1), weapon: block[at + C.weapon] });
    }
    const party = [0, 1, 2].map((i) => block[S.party + i]).filter((p) => p !== 0xff);
    const items = new Map();
    for (let j = 0; j < S.itemCount; j++) {
      const id = block[S.items + 2 * j], q = block[S.items + 2 * j + 1];
      if (id && q) items.set(id, (items.get(id) || 0) + q);
    }
    return { gfs, chars, party, items, gil: u32(block, S.gil), seconds: u32(block, S.seconds), name: decodeName(block, 0x18, 12) };
  }

  const api = { findSave, looksLikeSave, readSave, SAVE: S, SAVE_SIZE: SIZE, HINT, CHAR_NAMES, GF_NAMES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FF8Track = api;
})(typeof window !== 'undefined' ? window : globalThis);
