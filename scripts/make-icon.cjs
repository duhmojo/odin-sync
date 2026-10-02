// Draws the app icon (the green tile with the ring and arrow, as on Android)
// into build-resources/icon.png for the installers. No image tools needed.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const SIZE = 512;
const GREEN = [166, 240, 120];
const INK = [23, 35, 17];

// Coverage of a pixel by a shape, with 4x4 supersampling for smooth edges.
function coverage(x, y, inside) {
  let hits = 0;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if (inside(x + (i + 0.5) / 4, y + (j + 0.5) / 4)) hits++;
  return hits / 16;
}

const s = SIZE / 108; // the Android icon is drawn on a 108 grid
const tile = (x, y) => {
  const r = 22 * s;
  const m = 6 * s;
  const cx = Math.min(Math.max(x, m + r), SIZE - m - r);
  const cy = Math.min(Math.max(y, m + r), SIZE - m - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= m && y >= m && x <= SIZE - m && y <= SIZE - m;
};
const ring = (x, y) => {
  const d = Math.hypot(x - 54 * s, y - 54 * s);
  return d >= 28 * s && d <= 36 * s;
};
const arrow = (x, y) => {
  const u = x / s;
  const v = y / s;
  if (v >= 52 && v <= 72 && u >= 49 && u <= 59) return true; // shaft
  if (v >= 36 && v <= 52) return Math.abs(u - 54) <= ((v - 36) / 16) * 14; // head
  return false;
};

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  for (let x = 0; x < SIZE; x++) {
    const a = coverage(x, y, tile);
    const ink = coverage(x, y, (px, py) => tile(px, py) && (ring(px, py) || arrow(px, py)));
    const i = y * (SIZE * 4 + 1) + 1 + x * 4;
    for (let c = 0; c < 3; c++) raw[i + c] = Math.round(GREEN[c] * (1 - ink / Math.max(a, 1e-9)) + INK[c] * (ink / Math.max(a, 1e-9)));
    raw[i + 3] = Math.round(a * 255);
  }
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bit depth
header[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", header),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
const out = path.join(__dirname, "..", "build-resources", "icon.png");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`Wrote ${out} (${png.length} bytes).`);
