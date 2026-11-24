// FF7 seed generator tests on a made-up disc (see fake-ff7.js).
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildDisc } = require('./fake-ff7');
const { Disc } = require('../src/disc');
const { PatchedImage, loadPatch } = require('../src/discpatch');
const { verifySector } = require('../src/cdsector');
const kernel = require('../src/ff7/kernel');
const scene = require('../src/ff7/scene');
const ff7 = require('../src/ff7/randomizer');
const { decode } = require('../src/ff7/text');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff7-test-'));
const discs = [1, 2, 3].map((n) => {
  const p = path.join(tmp, `disc${n}.bin`);
  fs.writeFileSync(p, buildDisc({ serial: ff7.SERIALS[n - 1] }));
  return p;
});

function filesOf(binPath) {
  const d = new Disc(binPath);
  try {
    const k = d.findFile('INIT/KERNEL.BIN'), s = d.findFile('BATTLE/SCENE.BIN');
    return { kernel: kernel.parse(d.readExtent(k.lba, k.size)), scene: scene.parse(d.readExtent(s.lba, s.size)) };
  } finally { d.close(); }
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('kernel + scene parse and pass validation', () => {
  const info = ff7.inspect(discs[0]);
  assert.strictEqual(info.exeName, 'SCUS_941.63');
  assert.deepStrictEqual(info.kernel.problems, []);
  assert.ok(Object.values(info.kernel.ok).every(Boolean), JSON.stringify(info.kernel.ok));
  assert.ok(info.scene.ok);
  assert.strictEqual(info.names.materia[53], 'Restore');
  assert.strictEqual(info.names.weapons[5], 'Weapon 5');
});

test('unchanged kernel rebuilds byte-for-byte', () => {
  const { kernel: k } = filesOf(discs[0]);
  const d = new Disc(discs[0]);
  const rec = d.findFile('INIT/KERNEL.BIN');
  const orig = d.readExtent(rec.lba, rec.size);
  d.close();
  assert.ok(kernel.build(k).equals(orig));
});

test('generate patches all three discs and the result reads back', async () => {
  const out = path.join(tmp, 'seed1');
  const res = await ff7.generate({
    discs, outDir: out, seed: 'TESTSEED',
    options: { startMateria: 'random', startGear: 'fair', drops: 'shuffle', slots: 'shuffle', expMult: 2, apMult: 1, gilMult: 1 },
  });
  assert.strictEqual(res.discFiles.filter(Boolean).length, 3);
  assert.ok(fs.readFileSync(path.join(out, 'spoiler.txt'), 'utf8').includes('Starting party'));

  const vanilla = filesOf(discs[0]);
  for (let i = 0; i < 3; i++) {
    const exported = path.join(tmp, `patched${i + 1}.bin`);
    await new PatchedImage(discs[i], res.discFiles[i]).exportTo(exported);
    assert.strictEqual(fs.statSync(exported).size, fs.statSync(discs[i]).size);
    const got = filesOf(exported);

    // Starting materia: valid ids, never Master/KotR, and fits the slots.
    const names = kernel.allNames(got.kernel);
    const w = got.kernel.sections[kernel.SECTION.weapons].data;
    for (let c = 0; c < 9; c++) {
      const { buf, at } = kernel.charRecord(got.kernel, c);
      const wi = buf[at + kernel.CHAR.weapon];
      kernel.validate(got.kernel);
      const mask = w.readUInt16LE(wi * 44 + got.kernel.layout.weapon.equip);
      assert.ok(mask & (1 << buf[at]), `char ${c} got a weapon they can't equip`);
      const slots = kernel.countSlots([...w.subarray(wi * 44 + 0x1c, wi * 44 + 0x24)]);
      for (let j = 0; j < 8; j++) {
        const v = buf.readUInt32LE(at + 0x40 + j * 4);
        if (v === 0xffffffff) continue;
        assert.ok(j < slots, `materia in slot ${j} but weapon has ${slots}`);
        const name = names.materia[v & 0xff];
        assert.ok(name && !/^Master|Knights/.test(name), `bad materia ${name}`);
      }
    }
    // Drops shuffled: same multiset of items as vanilla.
    const items = (s) => {
      const seen = new Map();
      for (const { scene: sc } of scene.scenes(s)) for (const e of scene.enemies(sc)) {
        if (seen.has(e.id)) continue;
        seen.set(e.id, scene.readEnemy(sc.data, e.at));
      }
      return seen;
    };
    const vi = items(vanilla.scene), gi = items(got.scene);
    const flat = (m) => [...m.values()].flatMap((e) => e.slots.map((x) => x.item)).sort((a, b) => a - b);
    assert.deepStrictEqual(flat(gi), flat(vi));
    // EXP doubled everywhere, AP unchanged.
    for (const [id, e] of gi) {
      assert.strictEqual(e.exp, vi.get(id).exp * 2);
      assert.strictEqual(e.ap, vi.get(id).ap);
    }
    // Every patched sector has valid error codes.
    const p = loadPatch(res.discFiles[i]);
    for (const s of p.sectors.values()) assert.ok(verifySector(Buffer.from(s)));
  }
});

test('same seed + options = identical patches; different seed differs', async () => {
  const opts = { startMateria: 'chaos', startGear: 'chaos', drops: 'random', slots: 'shuffle' };
  const a = await ff7.generate({ discs, outDir: path.join(tmp, 'a'), seed: 'SAME', options: opts });
  const b = await ff7.generate({ discs, outDir: path.join(tmp, 'b'), seed: 'SAME', options: opts });
  const c = await ff7.generate({ discs, outDir: path.join(tmp, 'c'), seed: 'OTHER', options: opts });
  assert.ok(fs.readFileSync(a.discFiles[0]).equals(fs.readFileSync(b.discFiles[0])));
  assert.ok(!fs.readFileSync(a.discFiles[0]).equals(fs.readFileSync(c.discFiles[0])));
});

test('random materia always includes a Restore', async () => {
  for (const seed of ['R1', 'R2', 'R3', 'R4', 'R5']) {
    const res = await ff7.generate({ discs: [discs[0]], outDir: path.join(tmp, seed), seed, options: { startMateria: 'random', drops: 'vanilla' } });
    const exported = path.join(tmp, `${seed}.bin`);
    await new PatchedImage(discs[0], res.discFiles[0]).exportTo(exported);
    const init = filesOf(exported).kernel.sections[kernel.SECTION.init].data;
    const all = [];
    for (let c = 0; c < 9; c++) for (let j = 0; j < 16; j++) all.push(init.readUInt32LE(c * 0x84 + 0x40 + j * 4));
    for (let j = 0; j < 200; j++) all.push(init.readUInt32LE(0x728 + j * 4));
    assert.ok(all.some((v) => v === 53), `no Restore in seed ${seed}`);
  }
});

test('vanilla options change nothing', async () => {
  const res = await ff7.generate({ discs: [discs[0]], outDir: path.join(tmp, 'v'), seed: 'X', options: { startMateria: 'vanilla', startGear: 'vanilla', drops: 'vanilla', slots: 'vanilla' } });
  assert.strictEqual(loadPatch(res.discFiles[0]).sectors.size, 0);
});

test('patch refuses a different disc image', () => {
  const res = path.join(tmp, 'seed1', 'disc1.prhp');
  const other = path.join(tmp, 'short.bin');
  fs.writeFileSync(other, fs.readFileSync(discs[0]).subarray(0, 2352 * 30));
  assert.throws(() => new PatchedImage(other, res), /different copy/);
});

test('finds weapon/armor fields that sit somewhere else on the disc', async () => {
  const odd = path.join(tmp, 'odd.bin');
  // Equip mask at 0x10, armor slots at 0x14, starting weapons stored as item numbers (128+).
  fs.writeFileSync(odd, buildDisc({ layout: { equipAt: 0x10, armorSlotsAt: 0x14, weaponBase: 128 } }));
  const info = ff7.inspect(odd);
  assert.deepStrictEqual(info.kernel.problems, []);
  assert.ok(Object.values(ff7.features(info.kernel, info.scene)).every(Boolean), 'every feature on');
  const res = await ff7.generate({ discs: [odd], outDir: path.join(tmp, 'odd'), seed: 'ODD', options: { startGear: 'chaos', slots: 'shuffle', drops: 'vanilla' } });
  assert.ok(!res.notes.some((n) => /Turned off/.test(n)), res.notes.join(' | '));
  const exported = path.join(tmp, 'odd-out.bin');
  await new PatchedImage(odd, res.discFiles[0]).exportTo(exported);
  const k = filesOf(exported).kernel;
  kernel.validate(k);
  assert.strictEqual(k.layout.weapon.equip, 0x10);
  assert.strictEqual(k.layout.armor.slots, 0x14);
  const w = k.sections[kernel.SECTION.weapons].data;
  for (let c = 0; c < 9; c++) {
    const { buf, at } = kernel.charRecord(k, c);
    assert.ok(buf[at + 0x1c] >= 128, 'starting weapon kept as an item number');
    assert.ok(w.readUInt16LE((buf[at + 0x1c] - 128) * 44 + 0x10) & (1 << buf[at]), `char ${c} can equip their weapon`);
  }
});

test('a disc whose slots fit nowhere turns the option off and says why', () => {
  const k = kernel.parse(require('./fake-ff7').kernelBinForTest({}));
  const w = k.sections[kernel.SECTION.weapons].data;
  for (let i = 0; i < w.length; i++) w[i] = 9; // nothing in here looks like materia slots
  const v = kernel.validate(k);
  assert.ok(!v.ok.weapons);
  assert.ok(v.problems.some((p) => /Weapon materia slots don't parse/.test(p)));
});

test('flashback characters (Young Cloud, Sephiroth) keep their gear and materia', async () => {
  const res = await ff7.generate({ discs: [discs[0]], outDir: path.join(tmp, 'fb'), seed: 'FB', options: { startMateria: 'chaos', startGear: 'chaos', slots: 'shuffle', drops: 'vanilla' } });
  assert.ok(!res.notes.some((n) => /Turned off/.test(n)), res.notes.join(' | '));
  const out = path.join(tmp, 'fb.bin');
  await new PatchedImage(discs[0], res.discFiles[0]).exportTo(out);
  const init = filesOf(out).kernel.sections[kernel.SECTION.init].data;
  assert.strictEqual(init[7 * 0x84 + 0x1c], 127, 'Sephiroth keeps his weapon');
  assert.strictEqual(init.readUInt32LE(7 * 0x84 + 0x40), 49, 'Sephiroth keeps his materia');
  assert.strictEqual(init[6 * 0x84 + 0x1c], 0, 'Young Cloud keeps his weapon');
});

test('a kernel that would grow too big drops options one at a time instead of failing', async () => {
  // A disc whose KERNEL.BIN has no room to spare at all, with data that compresses well when vanilla.
  const tight = path.join(tmp, 'tight.bin');
  fs.writeFileSync(tight, buildDisc({ layout: { noSlack: true } }));
  const res = await ff7.generate({ discs: [tight], outDir: path.join(tmp, 'tight'), seed: 'TIGHT', options: { startMateria: 'chaos', startGear: 'chaos', slots: 'shuffle', drops: 'shuffle' } });
  assert.ok(res.discFiles[0], 'a seed was made');
  const out = path.join(tmp, 'tight-out.bin');
  await new PatchedImage(tight, res.discFiles[0]).exportTo(out);
  filesOf(out); // reads back
  const off = res.notes.filter((n) => /Turned off .*too big/.test(n));
  console.log('   (tight disc notes:', off.join(' | ') || 'none needed', ')');
});

test('when KERNEL.BIN still doesn\'t fit, slots then gear are turned off and the seed is still made', async () => {
  const real = kernel.build;
  let calls = 0;
  // Pretend the first two plans (with slots, then with gear) are 50 bytes too big.
  kernel.build = (k) => {
    const shuffled = k.sections[kernel.SECTION.weapons].dirty, gear = k.sections[kernel.SECTION.init].dirty;
    calls++;
    if (shuffled || (gear && calls < 3)) { const e = new Error('too big'); e.kernelTooBig = 50; throw e; }
    return real(k);
  };
  try {
    const res = await ff7.generate({ discs: [discs[0]], outDir: path.join(tmp, 'fall'), seed: 'FALL', options: { startMateria: 'random', startGear: 'chaos', slots: 'shuffle', drops: 'vanilla' } });
    assert.ok(res.discFiles[0]);
    assert.strictEqual(res.options.slots, 'vanilla');
    assert.ok(res.notes.some((n) => /Turned off materia slot shuffle/.test(n)), res.notes.join(' | '));
  } finally { kernel.build = real; }
});

test('KERNEL.BIN can grow into its last sector\'s spare room, and its size on the disc follows', async () => {
  const tight = path.join(tmp, 'grow.bin');
  fs.writeFileSync(tight, buildDisc({ layout: { noSlack: true } }));
  const d0 = new Disc(tight); const rec0 = d0.findFile('INIT/KERNEL.BIN'); d0.close();
  // Pretend the original file was 40 bytes shorter, so the seed's KERNEL.BIN has to grow past it.
  const real = kernel.parse;
  kernel.parse = (buf) => { const k = real(buf); if (buf.length === rec0.size) k.length = rec0.size - 40; return k; };
  try {
    const res = await ff7.generate({ discs: [tight], outDir: path.join(tmp, 'grow'), seed: 'GROW', options: { startMateria: 'random', slots: 'shuffle', drops: 'vanilla' } });
    assert.ok(!res.notes.some((n) => /Turned off/.test(n)), res.notes.join(' | '));
    const out = path.join(tmp, 'grow-out.bin');
    await new PatchedImage(tight, res.discFiles[0]).exportTo(out);
    const d = new Disc(out); const rec = d.findFile('INIT/KERNEL.BIN');
    const k = real(d.readExtent(rec.lba, rec.size)); d.close();
    assert.ok(k.sections.length >= 27, 'whole kernel readable at its new size');
    assert.ok(rec.size <= Math.ceil(rec0.size / 2048) * 2048, 'stays inside its sectors');
  } finally { kernel.parse = real; }
});

test('kernel build refuses to go past the last sector', () => {
  const k = kernel.parse(require('./fake-ff7').kernelBinForTest({ noSlack: true }));
  k.sections[kernel.SECTION.weapons].dirty = true;
  k.length = 1; // (so the result is exactly as long as the packed sections)
  const len = kernel.build(k, 1e6).length;
  assert.throws(() => kernel.build(k, len - 1), (e) => e.kernelTooBig === 1);
  assert.strictEqual(kernel.build(k, len).length, len);
});

test('text decoder', () => {
  assert.strictEqual(decode(Buffer.from([0x23, 0x4c, 0x4f, 0x55, 0x44, 0xff])), 'Cloud');
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('ok -', name); } catch (e) { failed++; console.error('FAIL -', name, '\n', e); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failed) process.exit(1);
  console.log('ff7 tests passed');
})();
