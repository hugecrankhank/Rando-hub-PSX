// FF7 menu text: one byte per character, byte + 0x20 = ASCII for the printable
// range, 0xFF ends a string. 0xF9 is a "repeat earlier bytes" code used in
// KERNEL.BIN text sections.
'use strict';

function decode(buf, start = 0, end = buf.length) {
  const out = [];
  let p = start;
  while (p < end) {
    const b = buf[p];
    if (b === 0xff) break;
    if (b === 0xf9 && p + 1 < end) {
      const x = buf[p + 1];
      const len = ((x >> 6) & 3) * 2 + 4;
      const back = (x & 0x3f) + 1;
      const from = out.length - back;
      for (let i = 0; i < len && from + i >= 0 && from + i < out.length; i++) out.push(out[from + i]);
      p += 2;
      continue;
    }
    if (b < 0x60) out.push(String.fromCharCode(b + 0x20));
    else if (b === 0xe1) out.push(' ');
    p++;
  }
  return out.join('');
}

// Text section: table of u16 offsets (first offset = table size), strings after.
function decodeTable(buf) {
  if (buf.length < 2) return [];
  const first = buf.readUInt16LE(0);
  if (first === 0 || first % 2 || first > buf.length) return [];
  const n = first / 2;
  const out = [];
  for (let i = 0; i < n; i++) {
    const off = buf.readUInt16LE(i * 2);
    out.push(off < buf.length ? decode(buf, off) : '');
  }
  return out;
}

// Lower-case, letters and digits only: "HP<->MP" -> "hpmp".
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

module.exports = { decode, decodeTable, norm };
