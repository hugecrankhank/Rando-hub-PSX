// Builds the SOTN map-tracker model: check locations (map x/y + room-visited bits)
// and the logic locks for a randomizer preset. Ported from SotnRandoTools
// (MIT, (c) TalicZealot — github.com/TalicZealot/SotnRandoTools), Tracker.LoadPreset.
'use strict';

const fs = require('fs');
const path = require('path');

// Ability indices (0-29 = relic order in RAM, then key items, then thrust sword).
const ABILITIES = [
  'Soul of Bat', 'Fire of Bat', 'Echo of Bat', 'Force of Echo', 'Soul of Wolf', 'Power of Wolf',
  'Skill of Wolf', 'Form of Mist', 'Power of Mist', 'Gas Cloud', 'Cube of Zoe', 'Spirit Orb',
  'Gravity Boots', 'Leap Stone', 'Holy Symbol', 'Faerie Scroll', 'Jewel of Open', 'Merman Statue',
  'Bat Card', 'Ghost Card', 'Faerie Card', 'Demon Card', 'Sword Card', 'Sprite Card', 'Nosedevil Card',
  'Heart of Vlad', 'Tooth of Vlad', 'Rib of Vlad', 'Ring of Vlad', 'Eye of Vlad',
  'Gold ring', 'Silver ring', 'Spike Breaker', 'Holy glasses', 'Thrust sword',
];
const ABILITY_INDEX = new Map(ABILITIES.map((n, i) => [n.toLowerCase(), i]));

const COLOR = { AVAILABLE: 'available', ALLOWED: 'allowed', UNAVAILABLE: 'unavailable' };
const MAP_START = 0x06bb74;

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function loadExtension(extDir, name, out, seen = new Set()) {
  if (!name || seen.has(name)) return;
  seen.add(name);
  const ext = readJson(path.join(extDir, `${String(name).toLowerCase()}.json`));
  if (!ext) return;
  if (ext.extends) loadExtension(extDir, ext.extends, out, seen);
  for (const l of ext.locations || []) {
    const key = l.location.toLowerCase();
    if (out.index.has(key)) continue;
    out.index.set(key, out.locations.length);
    out.locations.push({
      name: l.location,
      x: l.x | 0,
      y: l.y | 0,
      second: !!l.secondCastle,
      small: !!ext.smallIndicators,
      rooms: (l.rooms || []).map((r) => [parseInt(r.address, 16), parseInt(r.values, 16)]),
      color: COLOR.AVAILABLE,
    });
  }
}

function findPreset(dirs, id) {
  if (!id) return null;
  for (const d of dirs) {
    const p = readJson(path.join(d, `${id}.json`));
    if (p) return p;
  }
  return null;
}

function collectParents(dirs, preset, locks, allowed, depth = 0) {
  if (!preset || depth > 10) return;
  if (preset.inherits) collectParents(dirs, findPreset(dirs, preset.inherits), locks, allowed, depth + 1);
  for (const l of preset.lockLocation || []) locks.set(l.location, l);
  for (const l of preset.lockLocationAllowed || []) allowed.set(l.location, l);
}

function parseLockSet(str, aliases) {
  const abilities = [];
  for (const raw of String(str).split(' + ')) {
    const name = (aliases.get(raw.trim()) || raw.trim()).toLowerCase();
    if (ABILITY_INDEX.has(name)) abilities.push(ABILITY_INDEX.get(name));
  }
  return abilities;
}

/**
 * @param {object} o { srtDir, randoPresetsDir, presetId }
 * @returns model { locations, locks, allowed, progression, preset }
 */
function loadMapModel({ srtDir, randoPresetsDir, presetId }) {
  const extDir = path.join(srtDir, 'Extensions');
  const presetDirs = [path.join(srtDir, 'Presets'), randoPresetsDir].filter(Boolean);
  const out = { index: new Map(), locations: [] };
  const preset = findPreset(presetDirs, presetId);
  const speedrun = findPreset(presetDirs, 'sequence-breaker');

  if (!preset) {
    loadExtension(extDir, 'classic', out);
    return finish(out, [], [], new Set(), presetId);
  }

  const meta = preset.metadata || {};
  if (meta.id === 'glitch') loadExtension(extDir, 'equipment', out);
  const rle = preset.relicLocationsExtension;
  if (rle === false || rle === 'false') loadExtension(extDir, 'classic', out);
  else if (rle == null && meta.extension) loadExtension(extDir, meta.extension, out);
  else if (rle == null) loadExtension(extDir, 'guarded', out);
  else loadExtension(extDir, rle, out);
  if (!out.locations.length) loadExtension(extDir, 'classic', out);

  const aliases = new Map((preset.alias || []).map((a) => [a.alias, a.relic]));
  const uniqueLocks = new Map();
  const uniqueAllowed = new Map();
  for (const l of (speedrun && speedrun.lockLocation) || []) uniqueAllowed.set(l.location, l);
  if (preset.inherits) collectParents(presetDirs, findPreset(presetDirs, preset.inherits), uniqueLocks, uniqueAllowed);
  for (const l of preset.lockLocation || []) uniqueLocks.set(l.location, l);
  for (const l of preset.lockLocationAllowed || []) uniqueAllowed.set(l.location, l);

  const locks = [];
  const allowed = [];
  const progression = new Set();
  const idx = (name) => out.index.get(String(name).toLowerCase());

  for (const l of uniqueLocks.values()) {
    const i = idx(l.location);
    if (i === undefined) continue;
    const sets = l.locks || [];
    if (!sets.length) {
      out.locations[i].color = COLOR.AVAILABLE;
      locks.push({ loc: i, needs: [] });
      continue;
    }
    out.locations[i].color = COLOR.ALLOWED;
    for (const s of sets) {
      const needs = parseLockSet(s, aliases);
      needs.forEach((a) => { if (a < 30) progression.add(a); });
      locks.push({ loc: i, needs });
    }
  }
  for (const l of uniqueAllowed.values()) {
    const i = idx(l.location);
    if (i === undefined || out.locations[i].color === COLOR.AVAILABLE) continue;
    const sets = l.locks || [];
    if (!sets.length) {
      out.locations[i].color = COLOR.ALLOWED;
      allowed.push({ loc: i, needs: [] });
      continue;
    }
    out.locations[i].color = COLOR.UNAVAILABLE;
    for (const s of sets) {
      const needs = parseLockSet(s, aliases);
      needs.forEach((a) => { if (a < 30) progression.add(a); });
      allowed.push({ loc: i, needs });
    }
  }
  return finish(out, locks, allowed, progression, presetId);
}

function finish(out, locks, allowed, progression, presetId) {
  return {
    preset: presetId || null,
    mapStart: MAP_START,
    locations: out.locations,
    locks,
    allowed,
    progression: [...progression],
    abilities: ABILITIES,
  };
}

module.exports = { loadMapModel, ABILITIES, COLOR };
