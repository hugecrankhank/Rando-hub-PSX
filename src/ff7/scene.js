// BATTLE/SCENE.BIN: blocks of 0x2000 bytes. Each block starts with 16 u32
// offsets (in 4-byte units, 0xFFFFFFFF = unused) to gzip'd scenes. A scene is
// one battle setup: up to 3 enemy ids, formations, and the 3 enemies' data.
// We only ever change enemy data, and every scene stays in its own block, so
// the game's scene lookup table needs no change.
'use strict';

const { readMember, writeMember } = require('./gzip');
const { decode } = require('./text');

const BLOCK = 0x2000;
const SCENE_SIZE = 7808;
const ENEMY_IDS = 0x0000;
const ENEMY_DATA = 0x0298;
const ENEMY_SIZE = 184;
// Offsets inside one enemy record.
const E = {
  name: 0x00, level: 0x20,
  rates: 0x88, items: 0x8c,      // 4 drop/steal slots: rate byte + u16 item id
  ap: 0x9e, morph: 0xa0,
  hp: 0xa4, exp: 0xa8, gil: 0xac,
};

function parse(buf) {
  const blocks = [];
  for (let b = 0; b * BLOCK < buf.length; b++) {
    const blk = buf.subarray(b * BLOCK, (b + 1) * BLOCK);
    const offs = [];
    for (let i = 0; i < 16; i++) {
      const o = blk.readUInt32LE(i * 4);
      if (o === 0xffffffff) break;
      offs.push(o * 4);
    }
    const scenes = [];
    for (const o of offs) {
      if (o >= BLOCK || blk[o] !== 0x1f) throw new Error(`SCENE.BIN block ${b}: bad scene offset.`);
      const m = readMember(blk, o);
      if (m.data.length !== SCENE_SIZE) throw new Error(`SCENE.BIN block ${b}: scene is ${m.data.length} bytes, expected ${SCENE_SIZE}.`);
      scenes.push({ header: m.header, original: Buffer.from(blk.subarray(o, o + m.length)), data: m.data, dirty: false });
    }
    blocks.push({ scenes });
  }
  return { blocks, length: buf.length };
}

// Returns { buf, reverted: [sceneIndex...] } — scenes that no longer fit in
// their block are put back to vanilla.
function build(s) {
  const out = Buffer.alloc(s.length, 0xff);
  const reverted = [];
  let idx = 0;
  s.blocks.forEach((blk, b) => {
    const tryLayout = (useNew) => {
      const bodies = blk.scenes.map((sc, i) => (useNew[i] ? writeMember(sc.header, sc.data) : sc.original));
      let pos = 0x40;
      const offs = [];
      for (const body of bodies) {
        offs.push(pos);
        pos += body.length;
        pos = (pos + 3) & ~3;
      }
      return { bodies, offs, size: pos };
    };
    const useNew = blk.scenes.map((sc) => sc.dirty);
    let lay = tryLayout(useNew);
    // Too big: revert the dirty scenes one at a time, last first.
    for (let i = blk.scenes.length - 1; lay.size > BLOCK && i >= 0; i--) {
      if (!useNew[i]) continue;
      useNew[i] = false;
      reverted.push(idx + i);
      lay = tryLayout(useNew);
    }
    const base = b * BLOCK;
    for (let i = 0; i < 16; i++) out.writeUInt32LE(i < lay.offs.length ? lay.offs[i] / 4 : 0xffffffff, base + i * 4);
    lay.bodies.forEach((body, i) => body.copy(out, base + lay.offs[i]));
    idx += blk.scenes.length;
  });
  return { buf: out, reverted };
}

function* scenes(s) {
  let idx = 0;
  for (const blk of s.blocks) for (const sc of blk.scenes) yield { index: idx++, scene: sc };
}

// Enemies in a scene: [{ id, at }] where `at` is the record offset in scene.data.
function enemies(sc) {
  const out = [];
  for (let i = 0; i < 3; i++) {
    const id = sc.data.readUInt16LE(ENEMY_IDS + i * 2);
    if (id === 0xffff) continue;
    out.push({ id, at: ENEMY_DATA + i * ENEMY_SIZE });
  }
  return out;
}

function readEnemy(d, at) {
  const slots = [];
  for (let i = 0; i < 4; i++) {
    slots.push({ rate: d[at + E.rates + i], item: d.readUInt16LE(at + E.items + i * 2) });
  }
  return {
    name: decode(d, at + E.name, at + E.name + 32),
    level: d[at + E.level],
    slots,
    morph: d.readUInt16LE(at + E.morph),
    ap: d.readUInt16LE(at + E.ap),
    hp: d.readUInt32LE(at + E.hp),
    exp: d.readUInt32LE(at + E.exp),
    gil: d.readUInt32LE(at + E.gil),
  };
}

// Sanity check across the whole file. Item ids must be empty (0xFFFF) or < 320.
function validate(s) {
  let total = 0, bad = 0;
  for (const { scene } of scenes(s)) {
    for (const e of enemies(scene)) {
      total++;
      const r = readEnemy(scene.data, e.at);
      const itemsOk = r.slots.every((x) => x.item === 0xffff || x.item < 320) && (r.morph === 0xffff || r.morph < 320);
      if (!itemsOk || r.level > 99) bad++;
    }
  }
  const ok = total > 100 && bad <= total * 0.02;
  return { ok, total, bad, problems: ok ? [] : [`Enemy data doesn't parse (${bad}/${total} odd records).`] };
}

module.exports = { parse, build, validate, scenes, enemies, readEnemy, E, BLOCK, SCENE_SIZE, ENEMY_DATA, ENEMY_SIZE };
