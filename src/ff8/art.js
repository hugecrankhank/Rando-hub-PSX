// FF8 pictures for the tracker, read from the player's own Disc 1 at run time (never shipped): the character and
// GF face sheets, the world map and the Triple Triad cards. They are PS1 TIM images inside FF8DISC1.IMG; each is
// looked up at its usual place and only used if the TIM header there has the expected size.
'use strict';

const zlib = require('zlib');
const { Disc } = require('../disc');
const { findImg } = require('./discdata');

// IMG byte offsets (USA Disc 1) and expected sizes.
const SHEETS = {
  faces: { at: 97040 * 2048, w: 256, h: 96 },          // 8 x 2 faces, 32 x 48: Squall, Zell, Irvine, Quistis, Rinoa, Selphie, Seifer, Edea / Laguna, Kiros, Ward, -, Griever, Moomba?, Boko, Angelo
  gfs: { at: 97053 * 2048, w: 256, h: 96 },            // 8 x 2 GF faces, 32 x 48, in game order
  map: { at: 64494532, w: 256, h: 192 },               // world map (two palettes: colour, grey)
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`cards${i}`, { at: (97370 + 25 * i) * 2048, w: 256, h: 192 }])), // 4 x 3 cards, 64 x 64
};

function parseTim(buf) {
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x10) return null;
  const flags = buf.readUInt32LE(4), bpp = flags & 7, hasClut = !!(flags & 8);
  if (bpp > 1 || !hasClut) return null;
  let p = 8;
  const clen = buf.readUInt32LE(p), clutW = buf.readUInt16LE(p + 8), clutH = buf.readUInt16LE(p + 10);
  if (clen !== 12 + clutW * clutH * 2) return null;
  const clut = buf.subarray(p + 12, p + clen); p += clen;
  const len = buf.readUInt32LE(p), ww = buf.readUInt16LE(p + 8), h = buf.readUInt16LE(p + 10);
  if (len !== 12 + ww * h * 2 || p + len > buf.length) return null;
  return { bpp, clut, clutW, clutH, w: bpp === 0 ? ww * 4 : ww * 2, h, data: buf.subarray(p + 12, p + len) };
}

function toRgba(t, pal = 0) {
  const out = Buffer.alloc(t.w * t.h * 4);
  for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) {
    let i;
    if (t.bpp === 0) { const b = t.data[y * (t.w >> 1) + (x >> 1)]; i = x & 1 ? b >> 4 : b & 15; } else i = t.data[y * t.w + x];
    const v = t.clut.readUInt16LE(((pal * t.clutW) + i) * 2);
    const o = (y * t.w + x) * 4;
    const r = (v & 31) << 3, g = ((v >> 5) & 31) << 3, b = ((v >> 10) & 31) << 3;
    out[o] = r | (r >> 5); out[o + 1] = g | (g >> 5); out[o + 2] = b | (b >> 5); out[o + 3] = v === 0 ? 0 : 255;
  }
  return out;
}

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(b) { let c = -1; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const l = Buffer.alloc(4); l.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td));
  return Buffer.concat([l, td, c]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Returns { faces, gfs, map, cards: [10] } as PNG data URLs (missing ones are null).
function load(discPath) {
  const disc = new Disc(discPath);
  try {
    const img = findImg(disc);
    if (!img) return null;
    const read = (s) => {
      try {
        const sector = Math.floor(s.at / 2048), skip = s.at % 2048;
        const t = parseTim(disc.readExtent(img.lba + sector, skip + 12 + 512 + 12 + s.w * s.h + 4096).subarray(skip));
        if (!t || t.w !== s.w || t.h !== s.h) return null;
        return 'data:image/png;base64,' + png(t.w, t.h, toRgba(t, 0)).toString('base64');
      } catch (_) { return null; }
    };
    const out = { faces: read(SHEETS.faces), gfs: read(SHEETS.gfs), map: read(SHEETS.map), cards: [] };
    for (let i = 0; i < 10; i++) out.cards.push(read(SHEETS[`cards${i}`]));
    return out;
  } finally { if (disc.close) disc.close(); }
}

module.exports = { load, parseTim, toRgba, png, SHEETS };
