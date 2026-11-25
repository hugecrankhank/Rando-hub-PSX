// FF8 seed generator tests on a made-up disc (see fake-ff8.js).
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildDisc, MAGIC, ENEMIES, ABILITY, GF_LISTS } = require('./fake-ff8');
const { PatchedImage, loadPatch } = require('../src/discpatch');
const { verifySector } = require('../src/cdsector');
const dd = require('../src/ff8/discdata');
const ff8 = require('../src/ff8/randomizer');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff8-test-'));
const discs = [1, 2, 3, 4].map((n) => { const p = path.join(tmp, `disc${n}.bin`); fs.writeFileSync(p, buildDisc({ n })); return p; });

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const bag = (list) => list.map((x) => JSON.stringify(x)).sort();

test('finds the IMG, kernel magic names and every enemy', () => {
  const d = dd.load(discs[0]);
  assert.strictEqual(d.enemies.length, ENEMIES);
  assert.strictEqual(d.magicNames[1], MAGIC[1]);
  assert.strictEqual(d.enemies[3].name, 'Monster D3');
  const r = ff8.inspect(discs[0]);
  assert.ok(r.ok, r.problems.join(' '));
  assert.strictEqual(r.exeName, 'SLUS_008.92');
});

test('a seed patches all four discs; draws/items shuffle within bands; GF draws stay; EXP/AP scale', async () => {
  const out = path.join(tmp, 's1');
  const res = await ff8.generate({ discs, outDir: out, seed: 'TEST', options: { draws: 'balanced', items: 'balanced', cards: 'shuffle', expMult: 2, apMult: 3 } });
  assert.strictEqual(res.discFiles.filter(Boolean).length, 4);
  const van = dd.load(discs[0]).enemies;
  for (let i = 0; i < 4; i++) {
    const exported = path.join(tmp, `p${i}.bin`);
    await new PatchedImage(discs[i], res.discFiles[i]).exportTo(exported);
    const got = dd.load(exported).enemies;
    assert.strictEqual(got.length, van.length);
    for (let b = 0; b < 3; b++) {
      const pick = (list, kind) => list.flatMap((e) => e[kind].slice(b * 4, b * 4 + 4));
      assert.deepStrictEqual(bag(pick(got, 'draws').map((x) => x[0])), bag(pick(van, 'draws').map((x) => x[0])), `draw band ${b} keeps its magic`);
      assert.deepStrictEqual(bag([...pick(got, 'mugs'), ...pick(got, 'drops')]), bag([...pick(van, 'mugs'), ...pick(van, 'drops')]), `item band ${b}`);
    }
    got.forEach((e, n) => {
      e.draws.forEach(([m], j) => {
        const was = van[n].draws[j][0];
        if (was > 57 || was === 0) assert.strictEqual(m, was, 'GF draws and empty entries stay put');
      });
      assert.strictEqual(e.exp, Math.min(65535, van[n].exp * 2));
      assert.strictEqual(e.ap, Math.min(255, van[n].ap * 3));
    });
    assert.deepStrictEqual(bag(got.map((e) => e.card)), bag(van.map((e) => e.card)), 'cards shuffled, none lost');
    assert.ok(got.some((e, n) => e.draws[0][0] !== van[n].draws[0][0]), 'draws actually changed');
    for (const s of loadPatch(res.discFiles[i]).sectors.values()) assert.ok(verifySector(Buffer.from(s)));
  }
  const sp = fs.readFileSync(path.join(out, 'spoiler.txt'), 'utf8');
  assert.ok(sp.includes('Monster') && sp.includes('Spell'), 'spoiler has enemy and magic names');
});

test('same seed + options = same patch; another seed differs; vanilla changes nothing', async () => {
  const o = { draws: 'random', items: 'shuffle', cards: 'shuffle' };
  const a = await ff8.generate({ discs: [discs[0]], outDir: path.join(tmp, 'a'), seed: 'X', options: o });
  const b = await ff8.generate({ discs: [discs[0]], outDir: path.join(tmp, 'b'), seed: 'X', options: o });
  const c = await ff8.generate({ discs: [discs[0]], outDir: path.join(tmp, 'c'), seed: 'Y', options: o });
  assert.ok(fs.readFileSync(a.discFiles[0]).equals(fs.readFileSync(b.discFiles[0])));
  assert.ok(!fs.readFileSync(a.discFiles[0]).equals(fs.readFileSync(c.discFiles[0])));
  const v = await ff8.generate({ discs: [discs[0]], outDir: path.join(tmp, 'v'), seed: 'X', options: { draws: 'vanilla', items: 'vanilla', cards: 'vanilla' } });
  assert.strictEqual(loadPatch(v.discFiles[0]).sectors.size, 0);
});

test('GF abilities: lists read; balanced keeps basic commands, moves the rest, no repeats, rest of kernel untouched', async () => {
  const d = dd.load(discs[0]);
  assert.deepStrictEqual(d.gfs, GF_LISTS);
  assert.strictEqual(d.abilityNames[97], 'T Mag-RF');
  assert.strictEqual(d.abilityNames[1], ABILITY[1]);
  assert.ok(ff8.inspect(discs[0]).gfOk);
  for (const mode of ['balanced', 'chaos']) {
    const res = await ff8.generate({ discs, outDir: path.join(tmp, `gf-${mode}`), seed: 'GF', options: { draws: 'vanilla', items: 'vanilla', cards: 'vanilla', gfAbilities: mode } });
    for (let i = 0; i < 4; i++) {
      const exported = path.join(tmp, `gf-${mode}-${i}.bin`);
      await new PatchedImage(discs[i], res.discFiles[i]).exportTo(exported);
      const g = dd.load(exported);
      const v = dd.load(discs[i]);
      assert.deepStrictEqual(bag(g.gfLists.flat()), bag(GF_LISTS.flat()), 'same abilities overall');
      assert.ok(g.gfLists.some((l, k) => JSON.stringify(l) !== JSON.stringify(GF_LISTS[k])), 'something moved');
      g.gfLists.forEach((l, k) => {
        const real = l.filter(Boolean);
        assert.strictEqual(new Set(real).size, real.length, 'no GF learns an ability twice');
        l.forEach((a, j) => { if (GF_LISTS[k][j] === 0) assert.strictEqual(a, 0, 'empty slots stay empty'); });
        if (mode === 'balanced') l.forEach((a, j) => { if (GF_LISTS[k][j] >= 20 && GF_LISTS[k][j] <= 23) assert.strictEqual(a, GF_LISTS[k][j]); });
      });
      // Only the ability ids changed: the kernel matches vanilla everywhere else, enemies untouched.
      const a = g.kernel.data, b = v.kernel.data;
      const ids = new Set();
      for (let k = 0; k < 16; k++) for (let j = 0; j < 21; j++) { const o = b.length && v.kernel.offs[2] + k * 132 + 0x18 + 4 * j + 2; ids.add(o); ids.add(o + 1); }
      for (let x = 0; x < b.length; x++) if (a[x] !== b[x]) assert.ok(ids.has(x), `kernel byte ${x} changed`);
      assert.deepStrictEqual(g.enemies.map((e) => e.raw.toString('hex')), v.enemies.map((e) => e.raw.toString('hex')));
      for (const s of loadPatch(res.discFiles[i]).sectors.values()) assert.ok(verifySector(Buffer.from(s)));
    }
    const sp = fs.readFileSync(path.join(tmp, `gf-${mode}`, 'spoiler.txt'), 'utf8');
    assert.ok(sp.includes('Guardian Force abilities') && sp.includes('Quezacotl: '));
  }
});

test('random draws only use magic that exists in the game\'s draw lists', async () => {
  const res = await ff8.generate({ discs: [discs[0]], outDir: path.join(tmp, 'r'), seed: 'R', options: { draws: 'random', items: 'vanilla', cards: 'vanilla' } });
  const out = path.join(tmp, 'r.bin');
  await new PatchedImage(discs[0], res.discFiles[0]).exportTo(out);
  const van = new Set(dd.load(discs[0]).enemies.flatMap((e) => e.draws.map((x) => x[0])));
  for (const e of dd.load(out).enemies) for (const [m] of e.draws) assert.ok(van.has(m));
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('ok -', name); } catch (e) { failed++; console.error('FAIL -', name, '\n', e); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failed) process.exit(1);
  console.log('ff8 tests passed');
})();
