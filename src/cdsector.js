// CD-ROM sector error codes (EDC + ECC) for raw 2352-byte sectors, so patched
// sectors are as valid as the originals. Mode 2 Form 1 (PlayStation data) and
// Mode 1 are handled; anything else is left as-is.
'use strict';

const EDC = new Uint32Array(256);
const ECC_F = new Uint8Array(256);
const ECC_B = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let e = i;
  for (let j = 0; j < 8; j++) e = (e >>> 1) ^ (e & 1 ? 0xd8018001 : 0);
  EDC[i] = e >>> 0;
  const f = (i << 1) ^ (i & 0x80 ? 0x11d : 0);
  ECC_F[i] = f & 0xff;
  ECC_B[i ^ (f & 0xff)] = i;
}

function edc(buf, start, end) {
  let e = 0;
  for (let i = start; i < end; i++) e = (e >>> 8) ^ EDC[(e ^ buf[i]) & 0xff];
  return e >>> 0;
}

function eccBlock(s, majorCount, minorCount, majorMult, minorInc, dest) {
  const size = majorCount * minorCount;
  for (let major = 0; major < majorCount; major++) {
    let index = (major >> 1) * majorMult + (major & 1);
    let a = 0, b = 0;
    for (let minor = 0; minor < minorCount; minor++) {
      const t = s[0x0c + index];
      index += minorInc;
      if (index >= size) index -= size;
      a ^= t; b ^= t; a = ECC_F[a];
    }
    a = ECC_B[ECC_F[a] ^ b];
    s[dest + major] = a;
    s[dest + major + majorCount] = a ^ b;
  }
}

function ecc(s, zeroAddress) {
  const addr = Buffer.from(s.subarray(12, 16));
  if (zeroAddress) s.fill(0, 12, 16);
  eccBlock(s, 86, 24, 2, 86, 0x81c);
  eccBlock(s, 52, 43, 86, 88, 0x8c8);
  if (zeroAddress) addr.copy(s, 12);
}

const isForm2 = (s) => (s[0x12] & 0x20) !== 0;

// Fix up EDC/ECC in place for a raw sector whose user data changed.
function fixSector(s) {
  if (s.length !== 2352) return;
  const mode = s[15];
  if (mode === 1) {
    s.writeUInt32LE(edc(s, 0, 0x810), 0x810);
    s.fill(0, 0x814, 0x81c);
    ecc(s, false);
  } else if (mode === 2 && !isForm2(s)) {
    s.writeUInt32LE(edc(s, 0x10, 0x818), 0x818);
    ecc(s, true);
  }
}

// True if our EDC/ECC reproduces what's already stored in an untouched sector.
function verifySector(s) {
  const copy = Buffer.from(s);
  fixSector(copy);
  return copy.equals(s);
}

module.exports = { fixSector, verifySector, edc };
