// Sector patches for disc images. A seed stores only the sectors it changed
// (a few hundred KB) instead of a full copy of every disc, and the hub streams
// "vanilla disc + patch" to the emulator. Export writes a full patched .bin for
// other emulators.
'use strict';

const fs = require('fs');
const { Readable } = require('stream');
const { fixSector, verifySector } = require('./cdsector');

const MAGIC = 'PRHPATCH';
const COOKED = 2048;

class PatchBuilder {
  constructor(disc) {
    this.disc = disc;
    this.sectors = new Map(); // lba -> raw sector
    this.eccChecked = null;
  }

  rawSector(lba) {
    if (this.sectors.has(lba)) return Buffer.from(this.sectors.get(lba));
    const d = this.disc;
    return d._readAt(lba * d.sectorSize, d.sectorSize);
  }

  // Replace a file's contents. New data can't be longer than the sectors the
  // file already owns on the disc.
  writeFile(rec, data) {
    const d = this.disc;
    const room = Math.ceil(rec.size / COOKED) * COOKED;
    if (data.length > room) throw new Error(`${rec.name}: new data is ${data.length - room} bytes too big.`);
    for (let i = 0; i * COOKED < data.length; i++) {
      const lba = rec.lba + i;
      const raw = this.rawSector(lba);
      if (this.eccChecked === null && d.sectorSize === 2352) this.eccChecked = verifySector(raw);
      const chunk = data.subarray(i * COOKED, Math.min(data.length, (i + 1) * COOKED));
      const before = Buffer.from(raw);
      chunk.copy(raw, d.dataOffset);
      if (raw.equals(before)) continue;
      if (d.sectorSize === 2352) fixSector(raw);
      this.sectors.set(lba, raw);
    }
  }

  // Change a file's size in its directory record (both byte orders), e.g. after it grew into the spare room
  // of its last sector.
  setFileSize(rec, size) {
    if (rec.dirLba == null) throw new Error(`${rec.name}: directory record position unknown.`);
    if (size > Math.ceil(rec.size / COOKED) * COOKED) throw new Error(`${rec.name}: ${size} bytes is past its last sector.`);
    const d = this.disc, raw = this.rawSector(rec.dirLba);
    const at = d.dataOffset + rec.dirAt;
    raw.writeUInt32LE(size, at + 10);
    raw.writeUInt32BE(size, at + 14);
    if (d.sectorSize === 2352) fixSector(raw);
    this.sectors.set(rec.dirLba, raw);
  }

  get count() { return this.sectors.size; }

  save(file) {
    const lbas = [...this.sectors.keys()].sort((a, b) => a - b);
    const ss = this.disc.sectorSize;
    const head = Buffer.alloc(24);
    head.write(MAGIC, 0, 'ascii');
    head.writeUInt32LE(ss, 8);
    head.writeUInt32LE(lbas.length, 12);
    head.writeDoubleLE(this.disc.size, 16);
    const parts = [head];
    for (const lba of lbas) {
      const h = Buffer.alloc(4);
      h.writeUInt32LE(lba, 0);
      parts.push(h, this.sectors.get(lba));
    }
    fs.writeFileSync(file, Buffer.concat(parts));
  }
}

function loadPatch(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 8) !== MAGIC) throw new Error('Not a PSX Rando Hub patch file.');
  const sectorSize = buf.readUInt32LE(8);
  const count = buf.readUInt32LE(12);
  const discSize = buf.readDoubleLE(16);
  const sectors = new Map();
  let p = 24;
  for (let i = 0; i < count; i++) {
    const lba = buf.readUInt32LE(p);
    sectors.set(lba, buf.subarray(p + 4, p + 4 + sectorSize));
    p += 4 + sectorSize;
  }
  return { sectorSize, discSize, sectors };
}

// Vanilla image + optional patch, read as one stream.
class PatchedImage {
  constructor(binPath, patchFile) {
    this.path = binPath;
    this.size = fs.statSync(binPath).size;
    this.patch = patchFile ? loadPatch(patchFile) : null;
    if (this.patch && this.patch.discSize !== this.size) {
      throw new Error('This seed was made from a different copy of the disc. Pick the same disc image in Settings, or make a new seed.');
    }
  }

  async *chunks() {
    const ss = this.patch ? this.patch.sectorSize : 2352;
    const chunk = ss * 1024;
    const fh = await fs.promises.open(this.path, 'r');
    try {
      for (let pos = 0; pos < this.size; pos += chunk) {
        const len = Math.min(chunk, this.size - pos);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, pos);
        if (this.patch) {
          const first = pos / ss, last = (pos + len) / ss;
          for (const [lba, data] of this.patch.sectors) {
            if (lba >= first && lba < last) data.copy(buf, (lba - first) * ss);
          }
        }
        yield buf;
      }
    } finally {
      await fh.close();
    }
  }

  stream() { return Readable.from(this.chunks()); }
  webStream() { return Readable.toWeb(this.stream()); }

  async exportTo(out) {
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(out);
      this.stream().on('error', reject).pipe(ws).on('error', reject).on('finish', resolve);
    });
  }
}

module.exports = { PatchBuilder, PatchedImage, loadPatch };
