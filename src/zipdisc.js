// Serves a disc image as an uncompressed ("stored") .zip containing the .bin plus
// a generated .cue. Some cores (Beetle PSX) refuse a bare .bin and need a cue
// sheet; EmulatorJS only fetches one URL, so we hand it both in one archive.
// Nothing is written to disk except a tiny CRC cache.
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');

function crc32File(p) {
  return new Promise((resolve, reject) => {
    let crc = 0;
    fs.createReadStream(p, { highWaterMark: 4 * 1024 * 1024 })
      .on('data', (chunk) => { crc = zlib.crc32(chunk, crc); })
      .on('error', reject)
      .on('end', () => resolve(crc >>> 0));
  });
}

async function cachedCrc(p, cacheFile) {
  const st = fs.statSync(p);
  const key = `${p}|${st.size}|${st.mtimeMs}`;
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (_) { /* empty */ }
  if (cache[key] !== undefined) return cache[key];
  const crc = await crc32File(p);
  cache = Object.fromEntries(Object.entries(cache).slice(-50));
  cache[key] = crc;
  try { fs.writeFileSync(cacheFile, JSON.stringify(cache)); } catch (_) { /* ignore */ }
  return crc;
}

function localHeader(nameBuf, crc, size) {
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4);      // version needed
  h.writeUInt16LE(0, 6);       // flags
  h.writeUInt16LE(0, 8);       // method: stored
  h.writeUInt16LE(0, 10);      // time
  h.writeUInt16LE(0x21, 12);   // date (1980-01-01)
  h.writeUInt32LE(crc, 14);
  h.writeUInt32LE(size, 18);
  h.writeUInt32LE(size, 22);
  h.writeUInt16LE(nameBuf.length, 26);
  h.writeUInt16LE(0, 28);
  return h;
}

function centralHeader(nameBuf, crc, size, offset) {
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(20, 6);
  h.writeUInt16LE(0, 8);
  h.writeUInt16LE(0, 10);
  h.writeUInt16LE(0, 12);
  h.writeUInt16LE(0x21, 14);
  h.writeUInt32LE(crc, 16);
  h.writeUInt32LE(size, 20);
  h.writeUInt32LE(size, 24);
  h.writeUInt16LE(nameBuf.length, 28);
  h.writeUInt32LE(offset, 42);
  return h;
}

/**
 * Prepare a zip for `binPath`. Returns { size, stream() } where stream() yields
 * a fresh web ReadableStream each call.
 */
async function prepareDiscZip(binPath, cacheFile) {
  const binSize = fs.statSync(binPath).size;
  if (binSize >= 0xffffffff) throw new Error('Disc image too large for zip packaging.');
  const base = 'game';
  const binName = Buffer.from(`${base}.bin`);
  const cueName = Buffer.from(`${base}.cue`);
  const cue = Buffer.from(`FILE "${base}.bin" BINARY\r\n  TRACK 01 MODE2/2352\r\n    INDEX 01 00:00:00\r\n`);
  const cueCrc = zlib.crc32(cue) >>> 0;
  const binCrc = await cachedCrc(binPath, cacheFile);

  const cueLocal = localHeader(cueName, cueCrc, cue.length);
  const binLocal = localHeader(binName, binCrc, binSize);
  const cueOffset = 0;
  const binOffset = cueLocal.length + cueName.length + cue.length;
  const cdStart = binOffset + binLocal.length + binName.length + binSize;
  const cd = Buffer.concat([
    centralHeader(cueName, cueCrc, cue.length, cueOffset), cueName,
    centralHeader(binName, binCrc, binSize, binOffset), binName,
  ]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(2, 8);
  eocd.writeUInt16LE(2, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  const head = Buffer.concat([cueLocal, cueName, cue, binLocal, binName]);
  const tail = Buffer.concat([cd, eocd]);
  const size = head.length + binSize + tail.length;

  async function* parts() {
    yield head;
    for await (const chunk of fs.createReadStream(binPath, { highWaterMark: 4 * 1024 * 1024 })) yield chunk;
    yield tail;
  }
  return { size, stream: () => Readable.toWeb(Readable.from(parts())) };
}

module.exports = { prepareDiscZip, crc32File };
