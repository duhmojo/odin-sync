// No-key PC game source: Steam store search and app details, art from Steam's CDN.
const net = require("./net.cjs");

const STORE = "https://store.steampowered.com/api";
const CDN = "https://cdn.cloudflare.steamstatic.com/steam/apps";

// "Hollow Knight v1.5.78 (GOG) [FitGirl Repack]" -> "Hollow Knight"
function cleanName(name) {
  return String(name || "")
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/\bv?\d+(\.\d+){1,3}\b/gi, " ")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// A Steam app id from a pasted store or community link, or a bare id.
function parseAppRef(text) {
  const value = String(text || "").trim();
  const link = value.match(/(?:store\.steampowered\.com|steamcommunity\.com)\/app\/(\d+)/i);
  if (link) return Number(link[1]);
  if (/^\d{1,10}$/.test(value)) return Number(value);
  return null;
}

function searchUrl(name) {
  return `https://store.steampowered.com/search/?term=${encodeURIComponent(name)}`;
}

async function search(term) {
  const url = `${STORE}/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=US`;
  const result = await net.getJson(url);
  return (result?.items || [])
    .filter((item) => item.type === "app")
    .map((item) => ({ appId: item.id, name: item.name, image: item.tiny_image || "" }));
}

async function details(appId) {
  const result = await net.getJson(`${STORE}/appdetails?appids=${Number(appId)}&l=english`);
  const data = result?.[appId]?.success ? result[appId].data : null;
  if (!data) throw new Error(`Steam has no details for app ${appId}.`);
  return {
    title: data.name,
    description: String(data.short_description || "").replace(/<[^>]+>/g, ""),
    developer: (data.developers || []).join(", "),
    publisher: (data.publishers || []).join(", "),
    releaseDate: data.release_date?.date || "",
    genre: (data.genres || []).map((g) => g.description).join(", "),
    steamAppId: Number(appId),
    headerUrl: data.header_image || "",
    screenshotUrl: data.screenshots?.[0]?.path_full || "",
  };
}

async function image(urls) {
  for (const url of urls) {
    if (!url) continue;
    const found = await net.getBuffer(url).catch(() => null);
    if (found?.data?.length) return found;
  }
  return null;
}

// Finds the game on Steam (or uses the chosen appId) and returns {meta, images}.
async function scrapeGame({ item, appId }) {
  let chosen = appId;
  let candidates = [];
  if (!chosen) {
    const term = cleanName(item.name);
    candidates = await search(term);
    if (!candidates.length)
      return {
        meta: { kind: "game", title: item.name, notFound: true, source: "steam", searched: term },
        images: {},
      };
    const exact = candidates.find((c) => compact(c.name) === compact(term));
    chosen = (exact || candidates[0]).appId;
  }
  const info = await details(chosen);
  const cover = await image([
    `${CDN}/${chosen}/library_600x900_2x.jpg`,
    `${CDN}/${chosen}/library_600x900.jpg`,
    info.headerUrl,
  ]);
  const screenshot = await image([info.screenshotUrl]);
  const { headerUrl, screenshotUrl, ...meta } = info;
  return {
    meta: { kind: "game", source: "steam", ...meta, candidates: candidates.slice(0, 8) },
    images: { cover, screenshot },
  };
}

module.exports = { scrapeGame, search, details, cleanName, parseAppRef, searchUrl };
