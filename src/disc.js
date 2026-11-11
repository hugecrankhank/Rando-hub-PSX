// Minimal ISO9660 reader for raw PS1 disc images (.bin, 2352-byte sectors) and
// plain .iso images (2048-byte sectors). Used to:
//   1. validate that a file is the expected game (boot executable name)
//   2. pull byte "probes" out of the boot executable so the renderer can locate
//      PS1 main RAM inside the emulator's WebAssembly heap (auto-tracking).
'use strict';

const fs = require('fs');

const RAW = 2352;
const COOKED = 2048;

class Disc {
  constructor(filePath) {
    this.path = filePath;
    this.fd = fs.openSync(filePath, 'r');
    this.size = fs.fstatSync(this.fd).size;
    this._detectLayout();
  }

  close() {
    if (this.fd !== null) { fs.closeSync(this.fd); this.fd = null; }
  }

  _readAt(pos, len) {
    const buf = Buffer.alloc(len);
    const n = fs.readSync(this.fd, buf, 0, len, pos);
    return n === len ? buf : buf.subarray(0, n);
  }

  _detectLayout() {
    // Raw image: every sector starts with the 12-byte sync pattern 00 FF*10 00.
    const head = this._readAt(16 * RAW, 24);
    const isSync = head.length >= 16 && head[0] === 0x00 && head[11] === 0x00 &&
      head.subarray(1, 11).every((b) => b === 0xff);
    if (isSync) {
      const mode = head[15];
      this.sectorSize = RAW;
      this.dataOffset = mode === 2 ? 24 : 16; // Mode2 Form1 has an 8-byte subheader
    } else {
      this.sectorSize = COOKED;
      this.dataOffset = 0;
    }
    const pvd = this.readSector(16);
    if (pvd[0] !== 1 || pvd.toString('ascii', 1, 6) !== 'CD001') {
      throw new Error('Not a PlayStation/ISO9660 disc image (no primary volume descriptor).');
    }
    this.volumeId = pvd.toString('ascii', 40, 72).trim();
    this.root = parseDirRecord(pvd, 156);
  }

  readSector(lba) {
    return this._readAt(lba * this.sectorSize + this.dataOffset, COOKED);
  }

  readExtent(lba, length) {
    const out = Buffer.alloc(length);
    let done = 0;
    let sector = lba;
    while (done < length) {
      const chunk = this.readSector(sector++);
      const take = Math.min(COOKED, length - done);
      chunk.copy(out, done, 0, take);
      done += take;
    }
    return out;
  }

  listDir(record) {
    const data = this.readExtent(record.lba, record.size);
    const entries = [];
    let pos = 0;
    while (pos < data.length) {
      const len = data[pos];
      if (len === 0) { // records never straddle a sector; skip to next sector
        pos = (Math.floor(pos / COOKED) + 1) * COOKED;
        continue;
      }
      const rec = parseDirRecord(data, pos);
      if (rec.name !== '\u0000' && rec.name !== '\u0001') entries.push(rec);
      pos += len;
    }
    return entries;
  }

  // Path like "\\SLUS_000.67;1" or "DIR\\FILE.EXE". Case-insensitive, ;1 optional.
  findFile(p) {
    const parts = p.replace(/^cdrom0?:/i, '').split(/[\\/]+/).filter(Boolean);
    let dir = this.root;
    for (let i = 0; i < parts.length; i++) {
      const want = normName(parts[i]);
      const hit = this.listDir(dir).find((e) => normName(e.name) === want);
      if (!hit) return null;
      if (i === parts.length - 1) return hit;
      if (!hit.isDir) return null;
      dir = hit;
    }
    return null;
  }

  readFile(p) {
    const rec = this.findFile(p);
    if (!rec) return null;
    return this.readExtent(rec.lba, rec.size);
  }

  bootPath() {
    const cnf = this.readFile('SYSTEM.CNF');
    if (!cnf) return null;
    const m = /BOOT\s*=\s*([^\r\n]+)/i.exec(cnf.toString('ascii'));
    return m ? m[1].trim() : null;
  }
}

function normName(n) {
  return n.toUpperCase().replace(/;\d+$/, '').replace(/\.$/, '');
}

function parseDirRecord(buf, pos) {
  const lba = buf.readUInt32LE(pos + 2);
  const size = buf.readUInt32LE(pos + 10);
  const flags = buf[pos + 25];
  const nameLen = buf[pos + 32];
  const name = buf.toString('latin1', pos + 33, pos + 33 + nameLen);
  return { lba, size, isDir: (flags & 2) !== 0, name };
}

// Parse a PS-X EXE header.
function parsePsxExe(exe) {
  if (!exe || exe.length < 0x800 || exe.toString('ascii', 0, 8) !== 'PS-X EXE') {
    throw new Error('Boot file is not a PS-X EXE.');
  }
  return {
    pc0: exe.readUInt32LE(0x10),
    tAddr: exe.readUInt32LE(0x18),
    tSize: exe.readUInt32LE(0x1c),
  };
}

// Build probes: 64-byte slices of the executable's text segment plus the RAM
// offset each should appear at once the BIOS has loaded the game.
function buildProbes(exe, header, count = 4, len = 64) {
  const probes = [];
  const textStart = 0x800;
  const available = Math.min(header.tSize, exe.length - textStart);
  const fractions = [0.02, 0.2, 0.45, 0.7, 0.9].slice(0, Math.max(count, 1) + 1);
  for (const f of fractions) {
    if (probes.length >= count) break;
    let off = Math.floor((available * f) / 4) * 4;
    // Avoid all-zero / low-entropy slices.
    for (let tries = 0; tries < 64 && off + len <= available; tries++, off += 256) {
      const slice = exe.subarray(textStart + off, textStart + off + len);
      if (entropyOk(slice)) {
        probes.push({
          ramOffset: ((header.tAddr & 0x1fffffff) + off) >>> 0,
          bytes: Array.from(slice),
        });
        break;
      }
    }
  }
  return probes;
}

function entropyOk(slice) {
  const seen = new Set(slice);
  return seen.size >= 16;
}

// Inspect a disc image: returns boot exe name, header and probes.
function inspectDisc(filePath) {
  const disc = new Disc(filePath);
  try {
    const boot = disc.bootPath();
    if (!boot) throw new Error('SYSTEM.CNF not found — is this the data track (Track 1)?');
    const exe = disc.readFile(boot);
    if (!exe) throw new Error(`Boot executable ${boot} not found on disc.`);
    const header = parsePsxExe(exe);
    const exeName = normName(boot.split(/[\\/:]+/).pop());
    return {
      volumeId: disc.volumeId,
      boot,
      exeName,
      header,
      probes: buildProbes(exe, header),
      sectorSize: disc.sectorSize,
    };
  } finally {
    disc.close();
  }
}

module.exports = { Disc, inspectDisc, parsePsxExe, buildProbes, normName };
