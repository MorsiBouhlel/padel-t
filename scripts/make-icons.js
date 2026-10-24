// Génère les icônes de l'application (public/icon-192.png, icon-512.png, apple-touch-icon.png) :
// balle jaune sur le bleu du terrain, lignes blanches en filigrane. Sans dépendance : node scripts/make-icons.js
const zlib = require('zlib');
const fs = require('fs');
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };

const BG = [29, 95, 209], BALL = [212, 240, 74], WHITE = [255, 255, 255];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

function icon(N) {
  const SS = 3, u = N / 100;
  // Retourne la couleur d'un point (coordonnées en % de la taille).
  const shade = (x, y) => {
    let col = BG;
    // lignes du terrain (filigrane)
    const line = (d) => Math.abs(d) < 0.9;
    if ((x >= 8 && x <= 92 && (line(y - 12) || line(y - 88))) || (y >= 12 && y <= 88 && (line(x - 8) || line(x - 92) || line(x - 50) || line(x - 29) || line(x - 71))) || (x >= 29 && x <= 71 && line(y - 50))) col = mix(BG, WHITE, 0.18);
    // balle (rayon 28 %, dans la zone sûre des icônes « maskable »)
    const dx = x - 50, dy = y - 50, r = 28;
    if (Math.hypot(dx, dy) <= r) {
      col = BALL;
      for (const s of [-1, 1]) if (Math.abs(Math.hypot(dx - s * r * 1.62, dy) - r * 1.05) < r * 0.085) col = WHITE;
    }
    return col;
  };
  const raw = Buffer.alloc(N * (N * 3 + 1));
  for (let y = 0; y < N; y++) {
    raw[y * (N * 3 + 1)] = 0;
    for (let x = 0; x < N; x++) {
      const acc = [0, 0, 0];
      for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) { const c = shade((x + (i + .5) / SS) / u, (y + (j + .5) / SS) / u); acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; }
      const o = y * (N * 3 + 1) + 1 + x * 3;
      raw[o] = acc[0] / (SS * SS); raw[o + 1] = acc[1] / (SS * SS); raw[o + 2] = acc[2] / (SS * SS);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) fs.writeFileSync(`${__dirname}/../public/${name}`, icon(size));
