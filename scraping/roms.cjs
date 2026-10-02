// Scrapes one ROM item: identifies it (CRC when practical, else its name) and
// stores cover, screenshot and metadata in the media cache.
const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const net = require("./net.cjs");
const libretro = require("./libretro.cjs");
const { SYSTEMS, guessSystem } = require("./systems.cjs");

const MAX_CRC_BYTES = 256 * 1024 * 1024;
const NAME_ONLY = new Set([
  ".7z",
  ".chd",
  ".iso",
  ".cso",
  ".pbp",
  ".cue",
  ".m3u",
  ".gdi",
  ".rvz",
  ".wbfs",
  ".bin",
  ".img",
]);

// CRC32 of the largest file in a zip, read from its central directory.
async function zipCrc(file) {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, 65557);
    const tail = Buffer.alloc(length);
    await handle.read(tail, 0, length, size - length);
    const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (end < 0) return "";
    const count = tail.readUInt16LE(end + 10);
    const dirSize = tail.readUInt32LE(end + 12);
    const dirOffset = tail.readUInt32LE(end + 16);
    const dir = Buffer.alloc(dirSize);
    await handle.read(dir, 0, dirSize, dirOffset);
    let best = { size: -1, crc: "" };
    let cursor = 0;
    for (let i = 0; i < count && cursor + 46 <= dir.length; i++) {
      if (dir.readUInt32LE(cursor) !== 0x02014b50) break;
      const crc = dir.readUInt32LE(cursor + 16);
      const uncompressed = dir.readUInt32LE(cursor + 24);
      const nameLength = dir.readUInt16LE(cursor + 28);
      const extraLength = dir.readUInt16LE(cursor + 30);
      const commentLength = dir.readUInt16LE(cursor + 32);
      if (uncompressed > best.size)
        best = { size: uncompressed, crc: crc.toString(16).toUpperCase().padStart(8, "0") };
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    return best.crc;
  } finally {
    await handle.close();
  }
}

async function fileCrc(file) {
  let crc = 0;
  const handle = await fs.open(file, "r");
  try {
    for await (const chunk of handle.createReadStream()) crc = zlib.crc32(chunk, crc);
  } finally {
    await handle.close();
  }
  return (crc >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

// CRC used to identify a ROM, or "" when only the name will be used (disc
// images, archives other than zip, very large files).
async function romCrc(file, size) {
  const extension = path.extname(file).toLowerCase();
  if (NAME_ONLY.has(extension)) return "";
  if (extension === ".zip") return zipCrc(file).catch(() => "");
  if (size > MAX_CRC_BYTES) return "";
  return fileCrc(file).catch(() => "");
}

// ES-DE system for an item: the folder's own setting, else guessed from the
// first folder of the item's path, else from the local folder's name.
function systemFor(folder, item) {
  if (folder.system && SYSTEMS[folder.system]) return folder.system;
  const first = item.id.includes("/") ? item.id.split("/")[0] : "";
  return guessSystem(first) || guessSystem(path.basename(folder.path)) || guessSystem(folder.name);
}

async function download(url) {
  if (!url) return null;
  try {
    return await net.getBuffer(url);
  } catch {
    return null;
  }
}

// Returns {meta, images} for a ROM item. `extra` sources (ScreenScraper) can add
// a description and better media.
async function scrapeRom({ folder, item, cacheDir, screenscraper }) {
  const system = systemFor(folder, item);
  if (!system) throw new Error("Unknown system: set the ES-DE system for this local folder.");
  const primary = item.files?.[0] || { source: "", size: 0 };
  const romName = path.posix.basename(item.id).replace(/\.[^.]+$/, "");
  const crc = primary.source ? await romCrc(primary.source, primary.size) : "";
  let meta = { kind: "rom", system, romName, crc, source: "libretro" };
  let images = {};
  if (screenscraper) {
    const found = await screenscraper
      .lookup({ system, romName, crc, file: primary })
      .catch(() => null);
    if (found) {
      meta = { ...meta, ...found.meta, source: "screenscraper" };
      images = found.images || {};
    }
  }
  const found = await libretro.lookup(cacheDir, SYSTEMS[system].libretro, romName, crc);
  meta = {
    title: found.title,
    developer: found.developer,
    publisher: found.publisher,
    genre: found.genre,
    releaseDate: found.releaseDate,
    matchedBy: found.matchedBy,
    ...Object.fromEntries(Object.entries(meta).filter(([, v]) => v)),
  };
  if (!images.cover) images.cover = await download(found.coverUrl);
  if (!images.screenshot) images.screenshot = await download(found.screenshotUrl);
  if (!images.cover && !images.screenshot && !found.matchedBy && meta.source === "libretro") {
    meta.notFound = true;
  }
  return { meta, images };
}

module.exports = { scrapeRom, romCrc, zipCrc, systemFor };
