// ES-DE support: where scraped media goes on the device and how gamelist.xml
// is merged. ES-DE finds media at <ES-DE>/downloaded_media/<system>/<type>/
// <ROM path inside the system folder, without extension>.<ext> and metadata in
// <ES-DE>/gamelists/<system>/gamelist.xml with paths like ./Mario Kart DS.nds.
const path = require("node:path").posix;

const MEDIA_FOLDERS = { cover: "covers", screenshot: "screenshots" };

// The ROM's path inside its ES-DE system folder ("Mario Kart DS.nds"), or ""
// when the ROM is not under <ES-DE ROMs folder>/<system>/.
function romPathInSystem(target, romsFolder, system) {
  const systemDir = `${romsFolder.replace(/\/$/, "")}/${system}`;
  if (!target.toLowerCase().startsWith(systemDir.toLowerCase() + "/")) return "";
  return target.slice(systemDir.length + 1);
}

function mediaTarget(esdeFolder, system, romPath, kind, extension) {
  const base = romPath.replace(/\.[^./]+$/, "");
  return `${esdeFolder.replace(/\/$/, "")}/downloaded_media/${system}/${MEDIA_FOLDERS[kind]}/${base}${extension}`;
}

function gamelistPath(esdeFolder, system) {
  return `${esdeFolder.replace(/\/$/, "")}/gamelists/${system}/gamelist.xml`;
}

function escapeXml(text) {
  return String(text).replace(
    /[<>&'"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c],
  );
}

// "2005" or "2005-11-14" -> "20050101T000000" / "20051114T000000"
function esdeDate(value) {
  const match = String(value || "").match(/(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/);
  if (!match) return "";
  return `${match[1]}${match[2] || "01"}${match[3] || "01"}T000000`;
}

// The gamelist fields for one ROM from its scraped metadata.
function gameFields(meta) {
  const fields = {
    name: meta.title,
    desc: meta.description,
    developer: meta.developer,
    publisher: meta.publisher,
    genre: meta.genre,
    releasedate: esdeDate(meta.releaseDate),
    players: meta.players,
    rating: meta.rating !== undefined ? Number(meta.rating).toFixed(2) : "",
  };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v));
}

function setTag(block, tag, value) {
  const element = `<${tag}>${escapeXml(value)}</${tag}>`;
  const pattern = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>|<${tag}\\s*/>`);
  if (pattern.test(block)) return block.replace(pattern, element);
  return block.replace(/\s*<\/game>\s*$/, `\n\t\t${element}\n\t</game>`);
}

// Merges entries ([{path: "./x.nds", fields}]) into an existing gamelist.xml
// (or a new one). Only the given fields of the given games change; every other
// game and tag is kept as it was.
function mergeGamelist(xml, entries) {
  let text =
    xml && xml.includes("<gameList") ? xml : '<?xml version="1.0"?>\n<gameList>\n</gameList>\n';
  if (/<gameList\s*\/>/.test(text))
    text = text.replace(/<gameList\s*\/>/, "<gameList>\n</gameList>");
  for (const entry of entries) {
    const wanted = escapeXml(entry.path);
    const blocks = [...text.matchAll(/<game(?:\s[^>]*)?>[\s\S]*?<\/game>/g)];
    const existing = blocks.find((m) => {
      const found = (m[0].match(/<path>([\s\S]*?)<\/path>/) || [])[1];
      return found && found.trim() === wanted;
    });
    if (existing) {
      let block = existing[0];
      for (const [tag, value] of Object.entries(entry.fields)) block = setTag(block, tag, value);
      text =
        text.slice(0, existing.index) + block + text.slice(existing.index + existing[0].length);
    } else {
      const lines = [`\t<game>`, `\t\t<path>${wanted}</path>`];
      for (const [tag, value] of Object.entries(entry.fields))
        lines.push(`\t\t<${tag}>${escapeXml(value)}</${tag}>`);
      lines.push(`\t</game>`);
      text = text.replace(/<\/gameList>\s*$/, `${lines.join("\n")}\n</gameList>\n`);
    }
  }
  return text;
}

module.exports = {
  romPathInSystem,
  mediaTarget,
  gamelistPath,
  mergeGamelist,
  gameFields,
  esdeDate,
  MEDIA_FOLDERS,
  path,
};
