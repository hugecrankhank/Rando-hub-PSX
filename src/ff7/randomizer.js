// The hub's own Final Fantasy VII (PS1, USA) seed generator.
//
// It reads KERNEL.BIN and SCENE.BIN from the player's discs, plans every change
// from disc 1's data, applies the same plan to all three discs (each disc has
// its own copy of these files and loads them at boot), and saves a small sector
// patch per disc plus a spoiler log. The vanilla images are never modified.
'use strict';

const fs = require('fs');
const path = require('path');
const { Disc, inspectDisc } = require('../disc');
const { PatchBuilder } = require('../discpatch');
const kernel = require('./kernel');
const scene = require('./scene');
const { makeRng } = require('./rng');
const { norm } = require('./text');

const VERSION = 1;
const SERIALS = ['SCUS_941.63', 'SCUS_941.64', 'SCUS_941.65'];
const FILES = { kernel: 'INIT/KERNEL.BIN', scene: 'BATTLE/SCENE.BIN' };

const DEFAULT_OPTIONS = {
  startMateria: 'random',   // vanilla | random | chaos
  startGear: 'vanilla',     // vanilla | fair | chaos
  drops: 'balanced',        // vanilla | balanced | shuffle | random
  morphs: true,             // include Morph items with drops
  slots: 'vanilla',         // vanilla | shuffle   (weapon + armor materia slots)
  expMult: 1,
  apMult: 1,
  gilMult: 1,
};

const PRESETS = {
  casual: { label: 'Casual', options: { startMateria: 'random', startGear: 'fair', drops: 'balanced', morphs: true, slots: 'vanilla', expMult: 2, apMult: 2, gilMult: 2 } },
  standard: { label: 'Standard', options: { startMateria: 'random', startGear: 'fair', drops: 'balanced', morphs: true, slots: 'shuffle', expMult: 1, apMult: 1.5, gilMult: 1 } },
  wild: { label: 'Wild', options: { startMateria: 'chaos', startGear: 'chaos', drops: 'shuffle', morphs: true, slots: 'shuffle', expMult: 1, apMult: 1, gilMult: 1 } },
  chaos: { label: 'Chaos', options: { startMateria: 'chaos', startGear: 'chaos', drops: 'random', morphs: true, slots: 'shuffle', expMult: 1, apMult: 1, gilMult: 1 } },
  drops: { label: 'Drops only', options: { startMateria: 'vanilla', startGear: 'vanilla', drops: 'balanced', morphs: true, slots: 'vanilla', expMult: 1, apMult: 1, gilMult: 1 } },
};

// Never handed out by "random": these make the early game trivial.
const STRONG_MATERIA = new Set([
  'Knights of Round', 'Bahamut ZERO', 'Neo Bahamut', 'Hades', 'Typoon', 'Ultima', 'Full Cure',
  'W-Summon', 'W-Magic', 'W-Item', 'Mega All', 'Quadra Magic', 'HP Absorb', 'MP Absorb',
  'Mime', 'Counter', 'Magic Counter', 'Contain', 'Comet', 'Shield', 'Destruct', 'Bahamut',
].map(norm));
const isMaster = (name) => /^master/.test(norm(name));
const CHAR_NAMES = ['Cloud', 'Barret', 'Tifa', 'Aeris', 'Red XIII', 'Yuffie', 'Cait Sith', 'Vincent', 'Cid'];

// ------------------------------------------------------------------ reading

function readGameFiles(discPath) {
  const disc = new Disc(discPath);
  try {
    const krec = disc.findFile(FILES.kernel);
    const srec = disc.findFile(FILES.scene);
    if (!krec) throw new Error(`${FILES.kernel} not found on ${path.basename(discPath)}`);
    if (!srec) throw new Error(`${FILES.scene} not found on ${path.basename(discPath)}`);
    return {
      kernelRec: krec, sceneRec: srec,
      kernelBuf: disc.readExtent(krec.lba, krec.size),
      sceneBuf: disc.readExtent(srec.lba, srec.size),
    };
  } finally {
    disc.close();
  }
}

// What a disc offers. Used by Settings and before generating.
function inspect(discPath) {
  const info = inspectDisc(discPath);
  const f = readGameFiles(discPath);
  const k = kernel.parse(f.kernelBuf);
  const kv = kernel.validate(k);
  const s = scene.parse(f.sceneBuf);
  const sv = scene.validate(s);
  return { exeName: info.exeName, kernel: kv, scene: sv, names: kernel.allNames(k) };
}

// Which features this disc supports, from the validation results.
function features(kv, sv) {
  return {
    startMateria: kv.ok.init && kv.ok.names,
    startGear: kv.ok.init && kv.ok.equipMask && kv.ok.armor && kv.ok.names,
    slots: kv.ok.weapons && kv.ok.armor && kv.ok.equipMask,
    drops: sv.ok,
    mults: sv.ok,
  };
}

// ------------------------------------------------------------------ planning

function planSlots(k, names, rng, opts, log) {
  if (opts.slots !== 'shuffle') return null;
  const w = k.sections[kernel.SECTION.weapons].data;
  const a = k.sections[kernel.SECTION.armor].data;
  const plan = { weapons: new Map(), armor: new Map() };
  const take = (d, i, size, so, go) => ({ slots: Buffer.from(d.subarray(i * size + so, i * size + so + 8)), growth: d[i * size + go] });

  const byMask = new Map();
  for (let i = 0; i < 128; i++) {
    if (!names.weapons[i] || !names.weapons[i].trim()) continue;
    if (!kernel.slotsOk(w.subarray(i * 44 + kernel.WEAPON.slots, i * 44 + kernel.WEAPON.slots + 8))) continue;
    const mask = w.readUInt16LE(i * 44 + kernel.WEAPON.equip);
    if (!byMask.has(mask)) byMask.set(mask, []);
    byMask.get(mask).push(i);
  }
  for (const list of byMask.values()) {
    const vals = rng.shuffle(list.map((i) => take(w, i, 44, kernel.WEAPON.slots, kernel.WEAPON.growth)));
    list.forEach((i, n) => plan.weapons.set(i, vals[n]));
  }
  const armors = [];
  for (let i = 0; i < 32; i++) {
    if (!names.armor[i] || !names.armor[i].trim()) continue;
    if (!kernel.slotsOk(a.subarray(i * 36 + kernel.ARMOR.slots, i * 36 + kernel.ARMOR.slots + 8))) continue;
    armors.push(i);
  }
  const avals = rng.shuffle(armors.map((i) => take(a, i, 36, kernel.ARMOR.slots, kernel.ARMOR.growth)));
  armors.forEach((i, n) => plan.armor.set(i, avals[n]));
  log(`Shuffled materia slots on ${plan.weapons.size} weapons and ${plan.armor.size} armors.`);
  return plan;
}

function slotCountAfter(k, slotPlan, kind, idx) {
  if (slotPlan && slotPlan[kind].has(idx)) return kernel.countSlots([...slotPlan[kind].get(idx).slots]);
  const d = k.sections[kind === 'weapons' ? kernel.SECTION.weapons : kernel.SECTION.armor].data;
  const size = kind === 'weapons' ? 44 : 36;
  const so = kind === 'weapons' ? kernel.WEAPON.slots : kernel.ARMOR.slots;
  return kernel.countSlots([...d.subarray(idx * size + so, idx * size + so + 8)]);
}

function planGear(k, names, rng, opts) {
  if (opts.startGear === 'vanilla') return null;
  const w = k.sections[kernel.SECTION.weapons].data;
  const a = k.sections[kernel.SECTION.armor].data;
  const plan = new Map();
  const armors = [];
  for (let i = 0; i < 32; i++) if (names.armor[i] && names.armor[i].trim()) armors.push({ i, def: a[i * 36 + 2] });
  armors.sort((x, y) => x.def - y.def);
  for (let c = 0; c < 9; c++) {
    const { buf, at } = kernel.charRecord(k, c);
    const cur = buf[at + kernel.CHAR.weapon];
    if (cur >= 128) continue;
    const mine = [];
    for (let i = 0; i < 128; i++) {
      if (!names.weapons[i] || !names.weapons[i].trim()) continue;
      const mask = w.readUInt16LE(i * 44 + kernel.WEAPON.equip);
      if (mask & (1 << c)) mine.push({ i, atk: w[i * 44 + 4] });
    }
    if (!mine.length) continue;
    mine.sort((x, y) => x.atk - y.atk);
    const wPool = opts.startGear === 'fair' ? mine.slice(0, Math.max(1, Math.ceil(mine.length / 2))) : mine;
    const aPool = opts.startGear === 'fair' ? armors.slice(0, Math.max(1, Math.ceil(armors.length / 2))) : armors;
    plan.set(c, { weapon: rng.pick(wPool).i, armor: aPool.length ? rng.pick(aPool).i : buf[at + kernel.CHAR.armor] });
  }
  return plan;
}

function planMateria(k, names, rng, opts, gearPlan, slotPlan, log) {
  if (opts.startMateria === 'vanilla' && !gearPlan && !slotPlan) return null;
  const init = k.sections[kernel.SECTION.init].data;
  const pool = [];
  names.materia.forEach((n, id) => {
    if (!n || !n.trim() || isMaster(n)) return;
    if (opts.startMateria === 'random' && STRONG_MATERIA.has(norm(n))) return;
    pool.push(id);
  });
  if (!pool.length) throw new Error('No materia names found on the disc.');
  let bag = [];
  const draw = () => { if (!bag.length) bag = rng.shuffle([...pool]); return bag.pop(); };
  const restoreId = names.materia.findIndex((n) => norm(n) === 'restore');

  const plan = { chars: [], inventory: [] };
  const spill = [];
  for (let c = 0; c < 9; c++) {
    const { buf, at } = kernel.charRecord(k, c);
    const g = gearPlan && gearPlan.get(c);
    const weapon = g ? g.weapon : buf[at + kernel.CHAR.weapon];
    const armor = g ? g.armor : buf[at + kernel.CHAR.armor];
    const wSlots = weapon < 128 ? slotCountAfter(k, slotPlan, 'weapons', weapon) : 8;
    const aSlots = armor < 32 ? slotCountAfter(k, slotPlan, 'armor', armor) : 8;
    const read = (base) => Array.from({ length: 8 }, (_, j) => buf.readUInt32LE(at + base + j * 4));
    const fix = (list, room) => list.map((v, j) => {
      if (v === 0xffffffff) return v;
      const nv = opts.startMateria === 'vanilla' ? v : draw();
      if (j >= room) { spill.push(nv); return 0xffffffff; }
      return nv;
    });
    plan.chars[c] = {
      weaponMateria: fix(read(kernel.CHAR.weaponMateria), wSlots),
      armorMateria: fix(read(kernel.CHAR.armorMateria), aSlots),
    };
  }
  const inv = Array.from({ length: kernel.INIT.materiaCount }, (_, j) => init.readUInt32LE(kernel.INIT.materia + j * 4));
  plan.inventory = inv.map((v) => (v === 0xffffffff || opts.startMateria === 'vanilla' ? v : draw()));
  for (const v of spill) {
    const free = plan.inventory.indexOf(0xffffffff);
    if (free >= 0) plan.inventory[free] = v;
  }
  if (spill.length) log(`${spill.length} starting materia moved to the materia list (not enough slots).`);

  // Make sure there's a Restore somewhere so the early game is survivable.
  if (opts.startMateria !== 'vanilla' && restoreId >= 0) {
    const all = [...plan.chars.flatMap((x) => [...x.weaponMateria, ...x.armorMateria]), ...plan.inventory];
    if (!all.some((v) => (v & 0xff) === restoreId)) {
      const slot = plan.chars[0].weaponMateria.findIndex((v) => v !== 0xffffffff);
      if (slot >= 0) plan.chars[0].weaponMateria[slot] = restoreId;
      else {
        const free = plan.inventory.indexOf(0xffffffff);
        if (free >= 0) plan.inventory[free] = restoreId;
      }
    }
  }
  return plan;
}

// Unique enemies (first copy of each id) from disc 1's SCENE.BIN.
function enemyTable(s) {
  const map = new Map();
  for (const { scene: sc } of scene.scenes(s)) {
    for (const e of scene.enemies(sc)) {
      if (map.has(e.id)) continue;
      map.set(e.id, { id: e.id, ...scene.readEnemy(sc.data, e.at) });
    }
  }
  return [...map.values()];
}

function planDrops(s, rng, opts, log) {
  if (opts.drops === 'vanilla') return null;
  const enemies = enemyTable(s);
  const slotsOf = (e) => e.slots.map((x, j) => ({ e, j })).filter((r) => r.e.slots[r.j].item !== 0xffff);
  const plan = new Map(enemies.map((e) => [e.id, { slots: e.slots.map((x) => ({ ...x })), morph: e.morph }]));

  const assign = (refs, getItem, setItem) => {
    const items = refs.map(getItem);
    if (opts.drops === 'random') {
      refs.forEach((r) => setItem(r, rng.pick(items)));
    } else {
      rng.shuffle(items);
      refs.forEach((r, n) => setItem(r, items[n]));
    }
  };
  const groups = (list) => {
    if (opts.drops !== 'balanced') return [list];
    const sorted = [...list].sort((x, y) => x.e.level - y.e.level);
    const out = [];
    for (let i = 0; i < sorted.length; i += 40) out.push(sorted.slice(i, i + 40));
    return out;
  };

  const dropRefs = enemies.flatMap(slotsOf);
  for (const g of groups(dropRefs)) {
    assign(g, (r) => r.e.slots[r.j].item, (r, item) => { plan.get(r.e.id).slots[r.j].item = item; });
  }
  let morphs = 0;
  if (opts.morphs) {
    const morphRefs = enemies.filter((e) => e.morph !== 0xffff).map((e) => ({ e }));
    morphs = morphRefs.length;
    for (const g of groups(morphRefs)) {
      assign(g, (r) => r.e.morph, (r, item) => { plan.get(r.e.id).morph = item; });
    }
  }
  log(`Planned ${opts.drops} drops/steals for ${dropRefs.length} item slots on ${enemies.length} enemies` + (opts.morphs ? `, ${morphs} Morph items.` : '.'));
  return plan;
}

// ------------------------------------------------------------------ applying

function applyKernel(k, plans) {
  const { slotPlan, gearPlan, materiaPlan } = plans;
  if (slotPlan) {
    const w = k.sections[kernel.SECTION.weapons];
    const a = k.sections[kernel.SECTION.armor];
    for (const [i, v] of slotPlan.weapons) { v.slots.copy(w.data, i * 44 + kernel.WEAPON.slots); w.data[i * 44 + kernel.WEAPON.growth] = v.growth; }
    for (const [i, v] of slotPlan.armor) { v.slots.copy(a.data, i * 36 + kernel.ARMOR.slots); a.data[i * 36 + kernel.ARMOR.growth] = v.growth; }
    w.dirty = a.dirty = true;
  }
  if (gearPlan || materiaPlan) {
    const init = k.sections[kernel.SECTION.init];
    for (let c = 0; c < 9; c++) {
      const { buf, at } = kernel.charRecord(k, c);
      const g = gearPlan && gearPlan.get(c);
      if (g) { buf[at + kernel.CHAR.weapon] = g.weapon; buf[at + kernel.CHAR.armor] = g.armor; }
      const m = materiaPlan && materiaPlan.chars[c];
      if (m) {
        m.weaponMateria.forEach((v, j) => buf.writeUInt32LE(v >>> 0, at + kernel.CHAR.weaponMateria + j * 4));
        m.armorMateria.forEach((v, j) => buf.writeUInt32LE(v >>> 0, at + kernel.CHAR.armorMateria + j * 4));
      }
    }
    if (materiaPlan) materiaPlan.inventory.forEach((v, j) => init.data.writeUInt32LE(v >>> 0, kernel.INIT.materia + j * 4));
    init.dirty = true;
  }
}

function scaled(v, mult, max) {
  return mult === 1 ? v : Math.min(max, Math.round(v * mult));
}

function applyScene(s, plans, opts) {
  const { dropPlan } = plans;
  const mults = opts.expMult !== 1 || opts.apMult !== 1 || opts.gilMult !== 1;
  for (const { scene: sc } of scene.scenes(s)) {
    const d = sc.data;
    const before = Buffer.from(d);
    for (const e of scene.enemies(sc)) {
      const p = dropPlan && dropPlan.get(e.id);
      if (p) {
        p.slots.forEach((x, j) => {
          const cur = d.readUInt16LE(e.at + scene.E.items + j * 2);
          if (cur !== 0xffff && x.item !== 0xffff) d.writeUInt16LE(x.item, e.at + scene.E.items + j * 2);
        });
        const curMorph = d.readUInt16LE(e.at + scene.E.morph);
        if (curMorph !== 0xffff && p.morph !== 0xffff) d.writeUInt16LE(p.morph, e.at + scene.E.morph);
      }
      if (mults) {
        d.writeUInt32LE(scaled(d.readUInt32LE(e.at + scene.E.exp), opts.expMult, 0xffffffff), e.at + scene.E.exp);
        d.writeUInt16LE(scaled(d.readUInt16LE(e.at + scene.E.ap), opts.apMult, 0xffff), e.at + scene.E.ap);
        d.writeUInt32LE(scaled(d.readUInt32LE(e.at + scene.E.gil), opts.gilMult, 0xffffffff), e.at + scene.E.gil);
      }
    }
    if (!d.equals(before)) sc.dirty = true;
  }
}

// ------------------------------------------------------------------ spoiler

function spoilerText({ seed, opts, names, k, plans, enemies, notes }) {
  const L = [];
  const mName = (v) => (v === 0xffffffff ? null : names.materia[v & 0xff] || `Materia ${v & 0xff}`);
  L.push('FINAL FANTASY VII — PSX Rando Hub seed', `Seed: ${seed}`, `Generator version: ${VERSION}`, '');
  L.push('Options:');
  for (const [key, v] of Object.entries(opts)) L.push(`  ${key}: ${v}`);
  L.push('');
  if (notes.length) { L.push('Notes:'); notes.forEach((n) => L.push('  ' + n)); L.push(''); }

  if (plans.gearPlan || plans.materiaPlan) {
    L.push('== Starting party ==');
    for (let c = 0; c < 9; c++) {
      const { buf, at } = kernel.charRecord(k, c);
      const g = plans.gearPlan && plans.gearPlan.get(c);
      const wi = g ? g.weapon : buf[at + kernel.CHAR.weapon];
      const ai = g ? g.armor : buf[at + kernel.CHAR.armor];
      L.push(`${CHAR_NAMES[c]}: ${names.weapons[wi] || '-'} / ${names.armor[ai] || '-'}`);
      const m = plans.materiaPlan && plans.materiaPlan.chars[c];
      if (m) {
        const wm = m.weaponMateria.map(mName).filter(Boolean);
        const am = m.armorMateria.map(mName).filter(Boolean);
        if (wm.length) L.push(`   weapon materia: ${wm.join(', ')}`);
        if (am.length) L.push(`   armor materia: ${am.join(', ')}`);
      }
    }
    if (plans.materiaPlan) {
      const inv = plans.materiaPlan.inventory.map(mName).filter(Boolean);
      if (inv.length) L.push(`Materia list: ${inv.join(', ')}`);
    }
    L.push('');
  }
  if (plans.slotPlan) {
    L.push('== Weapon materia slots ==');
    const show = (v) => [...v.slots].map((b) => ({ 0: '', 1: 'o', 2: 'o=', 3: 'o', 5: 'x', 6: 'x=', 7: 'x' }[b] ?? '?')).join(' ').trim() + (v.growth === 0 ? ' (no growth)' : ` (growth x${v.growth})`);
    for (const [i, v] of plans.slotPlan.weapons) L.push(`${names.weapons[i]}: ${show(v)}`);
    L.push('', '== Armor materia slots ==');
    for (const [i, v] of plans.slotPlan.armor) L.push(`${names.armor[i]}: ${show(v)}`);
    L.push('');
  }
  if (plans.dropPlan) {
    L.push('== Enemy drops, steals and Morphs ==');
    for (const e of [...enemies].sort((x, y) => x.name.localeCompare(y.name))) {
      const p = plans.dropPlan.get(e.id);
      const parts = [];
      p.slots.forEach((x, j) => {
        if (e.slots[j].item === 0xffff) return;
        const rate = e.slots[j].rate;
        const kind = rate & 0x80 ? 'Steal' : 'Drop';
        parts.push(`${kind} ${kernel.itemName(names, x.item)}`);
      });
      if (e.morph !== 0xffff && p.morph !== 0xffff) parts.push(`Morph ${kernel.itemName(names, p.morph)}`);
      if (parts.length) L.push(`${e.name.trim() || `Enemy ${e.id}`} [Lv ${e.level}]: ${parts.join(' · ')}`);
    }
    L.push('');
  }
  return L.join('\n');
}

// ------------------------------------------------------------------ main entry

/**
 * opts: { discs: [path1, path2, path3], outDir, seed, options, spoiler }
 * Writes outDir/disc1.prhp … disc3.prhp, spoiler.txt and seed.json.
 */
async function generate({ discs, outDir, seed, options, spoiler = true }, onLine = () => {}) {
  const opts = { ...DEFAULT_OPTIONS, ...(options || {}) };
  for (const k of ['expMult', 'apMult', 'gilMult']) opts[k] = Math.max(0, Math.min(10, Number(opts[k]) || 1));
  const log = (s) => onLine(s);
  const notes = [];
  if (!discs || !discs[0]) throw new Error('Pick your Final Fantasy VII Disc 1 in Settings first.');

  // Check discs are the right ones.
  discs.forEach((p, i) => {
    if (!p) return;
    const info = inspectDisc(p);
    if (info.exeName !== SERIALS[i]) {
      const msg = `Disc ${i + 1} boots ${info.exeName}, expected ${SERIALS[i]} (USA). Results may not work.`;
      log('Warning: ' + msg); notes.push(msg);
    }
  });
  const missing = [1, 2].filter((i) => !discs[i]).map((i) => `Disc ${i + 1}`);
  if (missing.length) {
    const msg = `${missing.join(' and ')} not set: only discs you picked get the seed's changes.`;
    log('Warning: ' + msg); notes.push(msg);
  }

  // Plan from disc 1.
  log('Reading Disc 1…');
  const f1 = readGameFiles(discs[0]);
  const k1 = kernel.parse(f1.kernelBuf);
  const s1 = scene.parse(f1.sceneBuf);
  const kv = kernel.validate(k1), sv = scene.validate(s1);
  [...kv.problems, ...sv.problems].forEach((p) => { log('Check: ' + p); notes.push(p); });
  const can = features(kv, sv);
  const want = {
    startMateria: opts.startMateria !== 'vanilla', startGear: opts.startGear !== 'vanilla',
    slots: opts.slots !== 'vanilla', drops: opts.drops !== 'vanilla',
    mults: opts.expMult !== 1 || opts.apMult !== 1 || opts.gilMult !== 1,
  };
  for (const [f, on] of Object.entries(want)) {
    if (on && !can[f]) {
      const msg = `Turned off "${f}": this disc's data didn't pass the safety checks.`;
      log(msg); notes.push(msg);
      if (f === 'startMateria') opts.startMateria = 'vanilla';
      if (f === 'startGear') opts.startGear = 'vanilla';
      if (f === 'slots') opts.slots = 'vanilla';
      if (f === 'drops') opts.drops = 'vanilla';
      if (f === 'mults') opts.expMult = opts.apMult = opts.gilMult = 1;
    }
  }

  const names = kernel.allNames(k1);
  const rng = makeRng(`ff7|v${VERSION}|${seed}|${JSON.stringify(opts)}`);
  const plans = {};
  plans.slotPlan = planSlots(k1, names, rng, opts, log);
  plans.gearPlan = planGear(k1, names, rng, opts);
  plans.materiaPlan = planMateria(k1, names, rng, opts, plans.gearPlan, plans.slotPlan, log);
  plans.dropPlan = planDrops(s1, rng, opts, log);
  const enemies = enemyTable(s1);

  fs.mkdirSync(outDir, { recursive: true });
  const discFiles = [];
  for (let i = 0; i < 3; i++) {
    const p = discs[i];
    if (!p) { discFiles.push(null); continue; }
    log(`Patching Disc ${i + 1}…`);
    const f = i === 0 ? f1 : readGameFiles(p);
    const k = kernel.parse(f.kernelBuf);
    const s = scene.parse(f.sceneBuf);
    applyKernel(k, plans);
    applyScene(s, plans, opts);
    const kOut = kernel.build(k);
    const sOut = scene.build(s);
    if (sOut.reverted.length) {
      const msg = `Disc ${i + 1}: ${sOut.reverted.length} battle(s) kept vanilla data because the changes didn't fit.`;
      log(msg); notes.push(msg);
    }
    // Self-check: what we're about to write must read back the same.
    const k2 = kernel.parse(kOut);
    k.sections.forEach((sec, n) => { if (!k2.sections[n].data.equals(sec.data)) throw new Error(`Self-check failed on KERNEL.BIN section ${n}.`); });
    scene.parse(sOut.buf);

    const disc = new Disc(p);
    try {
      const pb = new PatchBuilder(disc);
      pb.writeFile(f.kernelRec, kOut);
      pb.writeFile(f.sceneRec, sOut.buf);
      if (pb.eccChecked === false) log(`Note: Disc ${i + 1}'s sectors have non-standard error codes; that's fine for emulators.`);
      const out = path.join(outDir, `disc${i + 1}.prhp`);
      pb.save(out);
      discFiles.push(out);
      log(`Disc ${i + 1}: ${pb.count} sectors changed.`);
    } finally {
      disc.close();
    }
  }

  const text = spoilerText({ seed, opts, names, k: k1, plans, enemies, notes });
  if (spoiler) fs.writeFileSync(path.join(outDir, 'spoiler.txt'), text);
  const meta = { version: VERSION, seed, options: opts, notes, discs: discs.map((d) => d || null) };
  fs.writeFileSync(path.join(outDir, 'seed.json'), JSON.stringify(meta, null, 2));
  return { discFiles, options: opts, notes, spoiler: spoiler ? text : '' };
}

module.exports = { generate, inspect, features, DEFAULT_OPTIONS, PRESETS, SERIALS, VERSION, readGameFiles };
