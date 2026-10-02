// No-account ROM source: libretro-thumbnails (box art and in-game snaps) and the
// libretro database metadata (developer, publisher, genre, release year), matched
// by ROM CRC when known and by name otherwise.
const fs = require("node:fs/promises");
const path = require("node:path");
const net = require("./net.cjs");

const THUMBNAILS = "https://thumbnails.libretro.com";
const DATABASE = "https://raw.githubusercontent.com/libretro/libretro-database/master/metadat";
const META_FIELDS = ["developer", "publisher", "genre", "releaseyear"];
const CACHE_DAYS = 30;
const KINDS = { cover: "Named_Boxarts", screenshot: "Named_Snaps" };
const REGION_ORDER = ["usa", "world", "europe", "japan"];

// Characters libretro replaces with "_" in thumbnail file names.
function thumbnailName(name) {
  return name.replace(/[&*/:`<>?\\|"]/g, "_");
}

// "Super Mario Bros. (USA) [!].nes" -> "supermariobros"
function normalize(name) {
  return String(name || "")
    .replace(/\.[a-z0-9]{1,4}$/i, "")
    .replace(/\([^)]*\)|\[[^\]]*\]/g, "")
    .replace(/&/g, "and")
    .toLowerCase()
    .replace(/^the |, the$/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function regionRank(name) {
  const lower = name.toLowerCase();
  const index = REGION_ORDER.findIndex(
    (region) => lower.includes(`(${region}`) || lower.includes(`, ${region}`),
  );
  return index < 0 ? REGION_ORDER.length : index;
}

async function cached(cacheDir, name, fetchFresh) {
  const file = path.join(cacheDir, "_libretro", name);
  try {
    const stat = await fs.stat(file);
    if (Date.now() - stat.mtimeMs < CACHE_DAYS * 86400000)
      return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    // Not cached yet.
  }
  const value = await fetchFresh();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value));
  return value;
}

function parseIndex(html) {
  const names = [];
  for (const match of html.matchAll(/href="([^"?/][^"]*\.png)"/g)) {
    names.push(decodeURIComponent(match[1]).replace(/\.png$/, ""));
  }
  return names;
}

// Names of every thumbnail of one kind for one system.
function thumbnailIndex(cacheDir, libretroSystem, kind) {
  const folder = KINDS[kind];
  return cached(cacheDir, `${libretroSystem}.${folder}.json`, async () => {
    const html = await net.getText(
      `${THUMBNAILS}/${encodeURIComponent(libretroSystem)}/${folder}/`,
    );
    return html ? parseIndex(html) : [];
  });
}

// clrmamepro dat: game ( comment "Name" field "value" rom ( crc XXXX ) )
function parseDat(text, field) {
  const entries = [];
  for (const block of text.split(/\ngame \(/).slice(1)) {
    const name = (block.match(/comment "([^"]*)"/) || [])[1];
    const value = (block.match(new RegExp(`\\n\\s*${field} "([^"]*)"`)) || [])[1];
    const crc = (block.match(/crc ([0-9A-Fa-f]{8})/) || [])[1];
    if (name && value) entries.push({ name, value, crc: crc ? crc.toUpperCase() : "" });
  }
  return entries;
}

// Metadata for one system: {byCrc: {CRC: name}, byName: {name: {developer, ...}}}.
function metadata(cacheDir, libretroSystem) {
  return cached(cacheDir, `${libretroSystem}.metadat.json`, async () => {
    const byCrc = {};
    const byName = {};
    for (const field of META_FIELDS) {
      const text = await net.getText(
        `${DATABASE}/${field}/${encodeURIComponent(libretroSystem)}.dat`,
      );
      for (const entry of parseDat(text || "", field)) {
        if (entry.crc) byCrc[entry.crc] = entry.name;
        (byName[entry.name] ||= {})[field] = entry.value;
      }
    }
    return { byCrc, byName };
  });
}

// Picks the best name from a list: exact, then same normalized title (preferring
// USA, World, Europe, Japan releases).
function bestName(candidates, wanted) {
  if (!candidates.length) return "";
  if (candidates.includes(wanted)) return wanted;
  const key = normalize(wanted);
  if (!key) return "";
  const same = candidates.filter((name) => normalize(name) === key);
  same.sort((a, b) => regionRank(a) - regionRank(b) || a.length - b.length);
  return same[0] || "";
}

// Finds art and metadata for a ROM. romName is the file name without extension;
// crc (optional) is the CRC32 of the ROM data.
async function lookup(cacheDir, libretroSystem, romName, crc) {
  const meta = await metadata(cacheDir, libretroSystem);
  const canonical = (crc && meta.byCrc[crc.toUpperCase()]) || "";
  const covers = await thumbnailIndex(cacheDir, libretroSystem, "cover");
  const title = canonical || bestName(Object.keys(meta.byName), romName) || romName;
  const coverName =
    bestName(covers, thumbnailName(title)) || bestName(covers, thumbnailName(romName));
  const screenshots = await thumbnailIndex(cacheDir, libretroSystem, "screenshot");
  const screenshotName = bestName(screenshots, coverName || title);
  const fields =
    meta.byName[canonical] || meta.byName[bestName(Object.keys(meta.byName), title)] || {};
  const url = (kind, name) =>
    name
      ? `${THUMBNAILS}/${encodeURIComponent(libretroSystem)}/${KINDS[kind]}/${encodeURIComponent(thumbnailName(name))}.png`
      : "";
  return {
    matchedBy: canonical ? "crc" : coverName || fields.developer ? "name" : "",
    title: (canonical || coverName || title).replace(/\s*\([^)]*\)|\s*\[[^\]]*\]/g, "").trim(),
    fullName: canonical || coverName || "",
    developer: fields.developer || "",
    publisher: fields.publisher || "",
    genre: fields.genre || "",
    releaseDate: fields.releaseyear || "",
    coverUrl: url("cover", coverName),
    screenshotUrl: url("screenshot", screenshotName),
  };
}

module.exports = { lookup, normalize, bestName, parseIndex, parseDat, thumbnailName, THUMBNAILS };
