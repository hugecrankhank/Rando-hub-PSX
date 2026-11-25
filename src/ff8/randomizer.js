// The hub's own Final Fantasy VIII (PS1, USA) seed generator.
//
// It reads every enemy's info block from the player's discs (see discdata.js), plans the changes from Disc 1,
// applies the same plan to all four discs (each has its own identical copy of the enemy files), and saves a small
// sector patch per disc plus a spoiler log. All changes are in place and the same size: nothing is compressed,
// so nothing can run out of room. The vanilla images are never modified.
'use strict';

const fs = require('fs');
const path = require('path');
const { Disc, inspectDisc } = require('../disc');
const { PatchBuilder } = require('../discpatch');
const dd = require('./discdata');
const { makeRng } = require('../ff7/rng');

const VERSION = 1;
const SERIALS = ['SLUS_008.92', 'SLUS_009.08', 'SLUS_009.09', 'SLUS_009.10'];
const BANDS = ['low', 'mid', 'high'];

const DEFAULT_OPTIONS = {
  draws: 'balanced',   // vanilla | balanced | shuffle | random   (magic you can draw from enemies)
  items: 'balanced',   // vanilla | balanced | shuffle | random   (mugs and drops)
  cards: 'shuffle',    // vanilla | shuffle                       (the card an enemy gives, via Card or a win)
  gfAbilities: 'vanilla', // vanilla | balanced | chaos           (which abilities each Guardian Force can learn)
  expMult: 1,
  apMult: 1,
};
const PRESETS = {
  casual: { label: 'Casual', options: { draws: 'balanced', items: 'balanced', cards: 'shuffle', gfAbilities: 'vanilla', expMult: 1.5, apMult: 2 } },
  standard: { label: 'Standard', options: { draws: 'balanced', items: 'balanced', cards: 'shuffle', gfAbilities: 'balanced', expMult: 1, apMult: 1 } },
  wild: { label: 'Wild', options: { draws: 'shuffle', items: 'shuffle', cards: 'shuffle', gfAbilities: 'balanced', expMult: 1, apMult: 1 } },
  chaos: { label: 'Chaos', options: { draws: 'random', items: 'random', cards: 'shuffle', gfAbilities: 'chaos', expMult: 1, apMult: 1 } },
  draws: { label: 'Draws only', options: { draws: 'balanced', items: 'vanilla', cards: 'vanilla', gfAbilities: 'vanilla', expMult: 1, apMult: 1 } },
};

const inspect = (discPath) => {
  const info = inspectDisc(discPath);
  const d = dd.load(discPath);
  const v = dd.validate(d);
  const problems = [...v.problems];
  if (!d.gfs) problems.push('Couldn’t confirm the Guardian Forces’ ability lists, so GF ability shuffle is off.');
  return { exeName: info.exeName, enemies: d.enemies.length, ok: v.ok, gfOk: !!d.gfs, problems, magicNames: d.magicNames };
};
const features = (r) => ({ draws: r.ok, items: r.ok, cards: r.ok, mults: r.ok, gfAbilities: !!r.gfOk });

// ------------------------------------------------------------------ GF abilities
// Moves only ability ids between GFs' learn-list slots (each slot keeps its own unlock settings), never puts the
// same ability twice on one GF, and keeps a GF's empty slots empty. "balanced" leaves Magic, GF, Draw and Item
// (ids 20-23) where they are, so the first GFs still bring the basic commands; "chaos" moves everything.
const BASIC = new Set([20, 21, 22, 23]);
function planGfs(gfs, mode, rng) {
  const keep = (a) => a === 0 || (mode === 'balanced' && BASIC.has(a));
  for (let attempt = 0; attempt < 50; attempt++) {
    const pool = rng.shuffle(gfs.flatMap((l) => l.filter((a) => !keep(a))));
    const out = gfs.map((l) => l.map((a) => (keep(a) ? a : null)));
    let ok = true;
    for (let g = 0; g < out.length && ok; g++) {
      for (let j = 0; j < out[g].length && ok; j++) {
        if (out[g][j] !== null) continue;
        const k = pool.findIndex((a) => !out[g].includes(a));
        if (k < 0) { ok = false; break; }
        out[g][j] = pool.splice(k, 1)[0];
      }
    }
    if (ok) return out;
  }
  return null;
}

// ------------------------------------------------------------------ planning
// A "slot" is one (enemy, band, position) entry. Plans are keyed by enemy index, so they apply to every disc.

function shuffleSlots(slots, mode, rng, value, set) {
  const groups = mode === 'balanced' ? BANDS.map((_, b) => slots.filter((s) => s.band === b)) : [slots];
  for (const g of groups) {
    const vals = g.map(value);
    if (mode === 'random') g.forEach((s) => set(s, rng.pick(vals)));
    else { rng.shuffle(vals); g.forEach((s, n) => set(s, vals[n])); }
  }
}

function plan(enemies, opts, rng, log) {
  const p = enemies.map((e) => ({ draws: e.draws.map((x) => [...x]), mugs: e.mugs.map((x) => [...x]), drops: e.drops.map((x) => [...x]), card: e.card }));
  if (opts.draws !== 'vanilla') {
    // Only real magic moves (1-57). Empty entries stay empty, and Guardian Forces drawn from bosses stay put.
    const slots = [];
    enemies.forEach((e, i) => e.draws.forEach(([m], j) => { if (m >= 1 && m <= dd.MAGIC_MAX) slots.push({ i, j, band: Math.floor(j / 4) }); }));
    shuffleSlots(slots, opts.draws, rng, (s) => enemies[s.i].draws[s.j][0], (s, v) => { p[s.i].draws[s.j][0] = v; });
    log(`Planned ${opts.draws} draws: ${slots.length} magic draws on ${enemies.length} enemies (Guardian Force draws stay put).`);
  }
  if (opts.items !== 'vanilla') {
    // Mugs and drops move as (item, quantity) pairs; empty entries stay empty.
    const slots = [];
    enemies.forEach((e, i) => ['mugs', 'drops'].forEach((kind) => e[kind].forEach(([item], j) => {
      if (item >= 1 && item <= dd.ITEM_MAX) slots.push({ i, j, kind, band: Math.floor(j / 4) });
    })));
    shuffleSlots(slots, opts.items, rng, (s) => [...enemies[s.i][s.kind][s.j]], (s, v) => { p[s.i][s.kind][s.j] = [...v]; });
    log(`Planned ${opts.items} mugs & drops: ${slots.length} item entries.`);
  }
  if (opts.cards !== 'vanilla') {
    const idx = enemies.map((e, i) => i).filter((i) => enemies[i].card <= 110);
    const cards = rng.shuffle(idx.map((i) => enemies[i].card));
    idx.forEach((i, n) => { p[i].card = cards[n]; });
    log(`Shuffled the cards ${idx.length} enemies give.`);
  }
  return p;
}

// ------------------------------------------------------------------ applying

function applyEnemy(e, p, opts) {
  const info = Buffer.from(e.info);
  const put = (at, list) => list.forEach(([a, b], j) => { info[at + 2 * j] = a; info[at + 2 * j + 1] = b; });
  put(dd.INFO.draws, p.draws);
  put(dd.INFO.mugs, p.mugs);
  put(dd.INFO.drops, p.drops);
  info[dd.INFO.card] = p.card;
  const scale = (v, m, max) => (m === 1 ? v : Math.min(max, Math.round(v * m)));
  info.writeUInt16LE(scale(info.readUInt16LE(dd.INFO.exp), opts.expMult, 0xffff), dd.INFO.exp);
  info.writeUInt16LE(scale(info.readUInt16LE(dd.INFO.extraExp), opts.expMult, 0xffff), dd.INFO.extraExp);
  info[dd.INFO.ap] = scale(info[dd.INFO.ap], opts.apMult, 0xff);
  return info;
}

// Match Disc N's enemies to Disc 1's plan: same order and names (checked); otherwise by name and occurrence.
function matchEnemies(base, other) {
  if (other.length === base.length && other.every((e, i) => e.name === base[i].name)) return other.map((_, i) => i);
  const seen = new Map(), byName = new Map();
  base.forEach((e, i) => { const k = e.name; if (!byName.has(k)) byName.set(k, []); byName.get(k).push(i); });
  return other.map((e) => {
    const n = seen.get(e.name) || 0; seen.set(e.name, n + 1);
    const list = byName.get(e.name);
    return list && list[n] !== undefined ? list[n] : -1;
  });
}

// ------------------------------------------------------------------ spoiler

function spoilerText({ seed, opts, enemies, plans, magicNames, itemNames, notes, gfPlan, abilityNames }) {
  const L = [];
  const mag = (id) => (id >= 1 && id <= dd.MAGIC_MAX ? (magicNames && magicNames[id]) || `Magic #${id}` : id > dd.MAGIC_MAX ? `Guardian Force #${id}` : '');
  const item = ([id, q]) => (id ? `${(itemNames && itemNames[id]) || `Item #${id}`}${q > 1 ? ` x${q}` : ''}` : '');
  L.push('FINAL FANTASY VIII — PSX Rando Hub seed', `Seed: ${seed}`, `Generator version: ${VERSION}`, '');
  L.push('Options:');
  for (const [k, v] of Object.entries(opts)) L.push(`  ${k}: ${v}`);
  L.push('');
  if (notes.length) { L.push('Notes:'); notes.forEach((n) => L.push('  ' + n)); L.push(''); }
  L.push('Draws, mugs and drops are listed by enemy level band: low / mid / high.' + (itemNames ? '' : ' Item numbers follow the game\'s item list (1 = Potion).'), '');
  if (gfPlan) {
    const GF_NAMES = ['Quezacotl', 'Shiva', 'Ifrit', 'Siren', 'Brothers', 'Diablos', 'Carbuncle', 'Leviathan', 'Pandemona', 'Cerberus', 'Alexander', 'Doomtrain', 'Bahamut', 'Cactuar', 'Tonberry', 'Eden'];
    L.push('== Guardian Force abilities ==');
    gfPlan.forEach((l, g) => L.push(`${GF_NAMES[g] || `GF ${g + 1}`}: ${l.filter(Boolean).map((a) => (abilityNames && abilityNames[a]) || `#${a}`).join(', ')}`));
    L.push('');
  }
  L.push('== Enemies ==');
  const seen = new Set();
  enemies.forEach((e, i) => {
    if (!e.name || /^dummy$/i.test(e.name)) return;
    const p = plans[i];
    const key = e.name + JSON.stringify(p);
    if (seen.has(key)) return;
    seen.add(key);
    const band = (list, b, f) => list.slice(b * 4, b * 4 + 4).map(f).filter(Boolean);
    const parts = [];
    const dr = BANDS.map((b, k) => band(p.draws, k, ([m]) => mag(m)).join(', ')).map((s, k) => (s ? `${BANDS[k]}: ${s}` : '')).filter(Boolean);
    if (dr.length) parts.push(`Draw ${dr.join(' | ')}`);
    const mu = BANDS.map((b, k) => band(p.mugs, k, item).join(', ')).map((s, k) => (s ? `${BANDS[k]}: ${s}` : '')).filter(Boolean);
    if (mu.length) parts.push(`Mug ${mu.join(' | ')}`);
    const dp = BANDS.map((b, k) => band(p.drops, k, item).join(', ')).map((s, k) => (s ? `${BANDS[k]}: ${s}` : '')).filter(Boolean);
    if (dp.length) parts.push(`Drop ${dp.join(' | ')}`);
    if (p.card <= 110) parts.push(`Card #${p.card}`);
    L.push(`${e.name}:`);
    parts.forEach((x) => L.push(`   ${x}`));
  });
  return L.join('\n');
}

// ------------------------------------------------------------------ main entry

/**
 * opts: { discs: [path1..path4], outDir, seed, options, spoiler }
 * Writes outDir/disc1.prhp … disc4.prhp, spoiler.txt and seed.json.
 */
async function generate({ discs, outDir, seed, options, spoiler = true }, onLine = () => {}) {
  const opts = { ...DEFAULT_OPTIONS, ...(options || {}) };
  for (const k of ['expMult', 'apMult']) opts[k] = Math.max(0, Math.min(10, Number(opts[k]) || 1));
  const log = (s) => onLine(s);
  const notes = [];
  if (!discs || !discs[0]) throw new Error('Pick your Final Fantasy VIII Disc 1 in Settings first.');

  discs.forEach((p, i) => {
    if (!p) return;
    const info = inspectDisc(p);
    if (info.exeName !== SERIALS[i]) {
      const msg = `Disc ${i + 1} boots ${info.exeName}, expected ${SERIALS[i]} (USA). Results may not work.`;
      log('Warning: ' + msg); notes.push(msg);
    }
  });
  const missing = [1, 2, 3].filter((i) => !discs[i]).map((i) => `Disc ${i + 1}`);
  if (missing.length) {
    const msg = `${missing.join(', ')} not set: only discs you picked get the seed's changes.`;
    log('Warning: ' + msg); notes.push(msg);
  }

  log('Reading Disc 1 (finding the enemy files takes a few seconds)…');
  const d1 = dd.load(discs[0]);
  const v = dd.validate(d1);
  v.problems.forEach((p) => { log('Check: ' + p); notes.push(p); });
  if (!v.ok) {
    for (const k of ['draws', 'items', 'cards']) opts[k] = 'vanilla';
    opts.expMult = opts.apMult = 1;
    const msg = 'Turned off every option: this disc\'s enemy data didn\'t pass the safety checks.';
    log(msg); notes.push(msg);
  }
  log(`Found ${d1.enemies.length} enemies.`);

  if (opts.gfAbilities !== 'vanilla' && !d1.gfs) {
    const msg = 'Turned off GF ability shuffle: couldn’t confirm the GF ability lists on this disc.';
    log(msg); notes.push(msg); opts.gfAbilities = 'vanilla';
  }
  const rng = makeRng(`ff8|v${VERSION}|${seed}|${JSON.stringify(opts)}`);
  const plans = plan(d1.enemies, opts, rng, log);
  let gfPlan = null;
  if (opts.gfAbilities !== 'vanilla') {
    gfPlan = planGfs(d1.gfs, opts.gfAbilities, rng);
    if (gfPlan) log(`Shuffled the abilities 16 Guardian Forces learn (${opts.gfAbilities}).`);
    else { const msg = 'GF ability shuffle couldn’t find an arrangement; GFs keep their own abilities.'; log(msg); notes.push(msg); }
  }

  fs.mkdirSync(outDir, { recursive: true });
  const discFiles = [];
  for (let i = 0; i < 4; i++) {
    const p = discs[i];
    if (!p) { discFiles.push(null); continue; }
    log(`Patching Disc ${i + 1}…`);
    const d = i === 0 ? d1 : dd.load(p);
    const map = matchEnemies(d1.enemies, d.enemies);
    const unmatched = map.filter((x) => x < 0).length;
    if (unmatched) { const msg = `Disc ${i + 1}: ${unmatched} enemies didn't match Disc 1 and keep their vanilla data.`; log(msg); notes.push(msg); }
    const disc = new Disc(p);
    try {
      const pb = new PatchBuilder(disc);
      d.enemies.forEach((e, n) => {
        const j = map[n];
        if (j < 0) return;
        const info = applyEnemy(e, plans[j], opts);
        if (info.equals(e.info)) return;
        const file = Buffer.from(e.raw);
        info.copy(file, e.offsets[6]);
        pb.writeFile({ name: e.name || 'enemy', lba: e.lba, size: file.length }, file);
      });
      if (gfPlan) {
        if (!d.gfs || !d.kernel) { const msg = `Disc ${i + 1}: GF ability lists not found; that disc keeps vanilla GF abilities.`; log(msg); notes.push(msg); }
        else {
          // kernel.bin, rewritten in place (same size): only the ability ids in section 2 change.
          const kern = Buffer.from(d.kernel.data.subarray(0, d.kernel.offs[d.kernel.count - 1] + 4096));
          const base = d.kernel.offs[2];
          gfPlan.forEach((l, g) => l.forEach((a, j) => kern.writeUInt16LE(a, base + g * dd.GF.size + dd.GF.list + 4 * j + dd.GF.abilityAt)));
          pb.writeFile({ name: 'kernel.bin', lba: d.kernel.lba, size: kern.length }, kern);
        }
      }
      const out = path.join(outDir, `disc${i + 1}.prhp`);
      pb.save(out);
      discFiles.push(out);
      log(`Disc ${i + 1}: ${pb.count} sectors changed.`);
    } finally {
      disc.close();
    }
  }

  const text = spoilerText({ seed, opts, enemies: d1.enemies, plans, magicNames: d1.magicNames, itemNames: d1.itemNames, notes, gfPlan, abilityNames: d1.abilityNames });
  if (spoiler) fs.writeFileSync(path.join(outDir, 'spoiler.txt'), text);
  fs.writeFileSync(path.join(outDir, 'seed.json'), JSON.stringify({ version: VERSION, seed, options: opts, notes, discs: discs.map((x) => x || null) }, null, 2));
  return { discFiles, options: opts, notes, spoiler: spoiler ? text : '' };
}

module.exports = { generate, inspect, features, DEFAULT_OPTIONS, PRESETS, SERIALS, VERSION, DISCS: 4 };
