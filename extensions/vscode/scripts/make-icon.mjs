// Génère media/icon.png (128x128) sans dépendance : fond uni arrondi + motif « branches ».
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SIZE = 128;
const BG = [24, 32, 51];
const FG = [96, 165, 250];
const ACCENT = [52, 211, 153];

const pixels = Buffer.alloc(SIZE * SIZE * 4);

function inRoundedRect(x, y, r) {
  const cx = Math.min(Math.max(x, r), SIZE - 1 - r);
  const cy = Math.min(Math.max(y, r), SIZE - 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
const dist = (x, y, px, py) => Math.hypot(x - px, y - py);
function onSegment(x, y, ax, ay, bx, by, w) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return dist(x, y, ax + t * dx, ay + t * dy) <= w;
}

for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const i = (y * SIZE + x) * 4;
    if (!inRoundedRect(x, y, 24)) continue;
    let color = BG;
    if (onSegment(x, y, 40, 36, 40, 92, 4) || onSegment(x, y, 40, 64, 88, 64, 4)) color = FG;
    if (dist(x, y, 40, 36) <= 12 || dist(x, y, 40, 92) <= 12) color = FG;
    if (dist(x, y, 88, 64) <= 12) color = ACCENT;
    if (dist(x, y, 40, 36) <= 6 || dist(x, y, 40, 92) <= 6 || dist(x, y, 88, 64) <= 6) color = BG;
    pixels[i] = color[0];
    pixels[i + 1] = color[1];
    pixels[i + 2] = color[2];
    pixels[i + 3] = 255;
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
};

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0;
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(fileURLToPath(new URL('../media/icon.png', import.meta.url)), png);
console.log(`icon.png: ${png.length} bytes`);
