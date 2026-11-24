// Gzip members as FF7 stores them (KERNEL.BIN sections, SCENE.BIN scenes).
// We keep each member's original header bytes and only swap the deflate body,
// so the game's own decompressor sees exactly the layout it expects.
'use strict';

const zlib = require('zlib');

const FTEXT = 1, FHCRC = 2, FEXTRA = 4, FNAME = 8, FCOMMENT = 16;

function headerLength(buf, pos = 0) {
  if (buf[pos] !== 0x1f || buf[pos + 1] !== 0x8b || buf[pos + 2] !== 8) throw new Error('Not a gzip member');
  const flg = buf[pos + 3];
  let p = pos + 10;
  if (flg & FEXTRA) p += 2 + buf.readUInt16LE(p);
  if (flg & FNAME) { while (buf[p] !== 0) p++; p++; }
  if (flg & FCOMMENT) { while (buf[p] !== 0) p++; p++; }
  if (flg & FHCRC) p += 2;
  void FTEXT;
  return p - pos;
}

// Decompress one member starting at `pos`. Returns { data, header, length }
// where length is the member's exact size in bytes (header + body + trailer).
function readMember(buf, pos = 0) {
  const hl = headerLength(buf, pos);
  const r = zlib.inflateRawSync(buf.subarray(pos + hl), { info: true });
  const bodyLen = r.engine.bytesWritten;
  return {
    data: r.buffer,
    header: Buffer.from(buf.subarray(pos, pos + hl)),
    length: hl + bodyLen + 8,
  };
}

// Smallest deflate we can make; the game has fixed room for these files.
function bestDeflate(data) {
  let best = null;
  const S = zlib.constants;
  for (const level of [9, 8, 7, 6]) {
    for (const memLevel of [9, 8, 7]) {
      for (const strategy of [S.Z_DEFAULT_STRATEGY, S.Z_FILTERED]) {
        const d = zlib.deflateRawSync(data, { level, memLevel, strategy, windowBits: 15 });
        if (!best || d.length < best.length) best = d;
      }
    }
  }
  return best;
}

function writeMember(header, data) {
  const tail = Buffer.alloc(8);
  tail.writeUInt32LE(zlib.crc32(data) >>> 0, 0);
  tail.writeUInt32LE(data.length >>> 0, 4);
  // Header CRC (FHCRC) would cover only the header, which we keep, so it stays valid.
  return Buffer.concat([header, bestDeflate(data), tail]);
}

module.exports = { readMember, writeMember, headerLength };
