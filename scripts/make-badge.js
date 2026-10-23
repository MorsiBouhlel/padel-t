// Génère public/badge-96.png : balle blanche sur fond transparent (les badges de notification Android sont monochromes,
// seule la transparence compte ; une icône pleine devient un carré blanc).
const zlib = require('zlib');
const fs = require('fs');
const N = 96, SS = 4, cx = N / 2, cy = N / 2, R = 42, seamR = R * 1.05, seamOff = R * 1.62, seamW = R * 0.17;
const inside = (x, y) => {
  if (Math.hypot(x - cx, y - cy) > R) return false;
  for (const s of [-1, 1]) if (Math.abs(Math.hypot(x - (cx + s * seamOff), y - cy) - seamR) < seamW / 2) return false;
  return true;
};
const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  for (let x = 0; x < N; x++) {
    let a = 0;
    for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) if (inside(x + (i + .5) / SS, y + (j + .5) / SS)) a++;
    const o = y * (N * 4 + 1) + 1 + x * 4;
    raw[o] = raw[o + 1] = raw[o + 2] = 255;
    raw[o + 3] = Math.round((a / (SS * SS)) * 255);
  }
}
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
fs.writeFileSync(__dirname + '/../public/badge-96.png', Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
