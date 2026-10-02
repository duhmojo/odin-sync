// Draws the app icon (the green O on a transparent background, as on Android)
// into build-resources/icon.png (installers, tray) and docs/icon.png (website).
// No image tools needed.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const SIZE = 512;
const GREEN = [166, 240, 120];

// Coverage of a pixel by a shape, with 4x4 supersampling for smooth edges.
function coverage(x, y, inside) {
  let hits = 0;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if (inside(x + (i + 0.5) / 4, y + (j + 0.5) / 4)) hits++;
  return hits / 16;
}

// The green O, as on Android (ring of radius 24, stroke 10, on a 66 safe zone),
// filling the canvas, on a transparent background.
const s = SIZE / 66;
const ring = (x, y) => {
  const d = Math.hypot(x - SIZE / 2, y - SIZE / 2);
  return d >= 19 * s && d <= 29 * s;
};

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  for (let x = 0; x < SIZE; x++) {
    const i = y * (SIZE * 4 + 1) + 1 + x * 4;
    for (let c = 0; c < 3; c++) raw[i + c] = GREEN[c];
    raw[i + 3] = Math.round(coverage(x, y, ring) * 255);
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
fs.writeFileSync(path.join(__dirname, "..", "docs", "icon.png"), png);
console.log(`Wrote ${out} (${png.length} bytes).`);
