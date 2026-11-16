'use strict';
// Gera build/icon.png (1024x1024) sem dependências: fundo escuro arredondado + 3 barras (Claude, Codex, Cursor).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const N = 1024; const SS = 3; const K = N / 256; // desenhado em 256 e escalado // supersampling para bordas suaves
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const BG = hex('#1d1d1b'); const BARS = [
  { c: hex('#d97757'), x: 62, w: 34, top: 112 },
  { c: hex('#10a37f'), x: 111, w: 34, top: 62 },
  { c: hex('#7c8cff'), x: 160, w: 34, top: 140 },
];
const BOTTOM = 194;

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  for (let x = 0; x < N; x++) {
    let r = 0; let g = 0; let b = 0; let a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS; const py = y + (sy + 0.5) / SS;
        if (!inRoundRect(px / K, py / K, 8, 8, 248, 248, 56)) continue;
        let col = BG;
        for (const bar of BARS) if (inRoundRect(px / K, py / K, bar.x, bar.top, bar.x + bar.w, BOTTOM, 14)) col = bar.c;
        r += col[0]; g += col[1]; b += col[2]; a += 255;
      }
    }
    const n = SS * SS; const cov = a / 255;
    const o = y * (N * 4 + 1) + 1 + x * 4;
    raw[o] = cov ? r / cov : 0; raw[o + 1] = cov ? g / cov : 0; raw[o + 2] = cov ? b / cov : 0; raw[o + 3] = a / n;
  }
}

function crc32(buf) {
  let c; const table = crc32.t || (crc32.t = Array.from({ length: 256 }, (_, n) => {
    c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
  }));
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(path.join(__dirname, 'icon.png'), png);
console.log('icon.png gerado');
