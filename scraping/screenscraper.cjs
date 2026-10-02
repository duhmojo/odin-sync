// Optional ROM source: ScreenScraper (screenscraper.fr). It needs a user
// account and developer credentials (devid/devpassword, requested from
// ScreenScraper). Requests go one at a time with a pause, within its limits.
const net = require("./net.cjs");

const API = "https://api.screenscraper.fr/api2";
const SOFTWARE = "OdinSync";
const PAUSE_MS = 1200;

// ES-DE system -> ScreenScraper system id.
const SYSTEM_IDS = {
  megadrive: 1,
  mastersystem: 2,
  nes: 3,
  snes: 4,
  gb: 9,
  gbc: 10,
  virtualboy: 11,
  gba: 12,
  gc: 13,
  n64: 14,
  nds: 15,
  wii: 16,
  n3ds: 17,
  sega32x: 19,
  segacd: 20,
  gamegear: 21,
  saturn: 22,
  dreamcast: 23,
  ngp: 25,
  atari2600: 26,
  atarijaguar: 27,
  atarilynx: 28,
  pcengine: 31,
  atari7800: 41,
  wonderswan: 45,
  wonderswancolor: 46,
  colecovision: 48,
  psx: 57,
  ps2: 58,
  psp: 61,
  ngpc: 82,
  fds: 106,
  msx: 113,
  pcenginecd: 114,
  intellivision: 115,
};

function credentialParams(account) {
  return new URLSearchParams({
    devid: account.devId,
    devpassword: account.devPassword,
    softname: SOFTWARE,
    output: "json",
    ssid: account.user,
    sspassword: account.password,
  });
}

function configured(account) {
  return !!(account?.user && account?.password && account?.devId && account?.devPassword);
}

// Picks the English (or world/US) text from ScreenScraper's localized lists.
function pickText(list, keys = ["en", "us", "wor", "eu"]) {
  if (!Array.isArray(list)) return list?.text || "";
  for (const key of keys) {
    const found = list.find((entry) => entry.langue === key || entry.region === key);
    if (found?.text) return found.text;
  }
  return list[0]?.text || "";
}

function pickMedia(medias, type) {
  const matching = (medias || []).filter((m) => m.type === type && m.url);
  for (const region of ["us", "wor", "eu", "ss", "jp"]) {
    const found = matching.find((m) => m.region === region);
    if (found) return found.url;
  }
  return matching[0]?.url || "";
}

// Turns a jeuInfos answer into metadata and media URLs.
function parseGame(game) {
  const genre = (game.genres || [])
    .map((g) => pickText(g.noms))
    .filter(Boolean)
    .join(", ");
  const rating = Number(game.note?.text);
  return {
    meta: {
      title: pickText(game.noms, ["us", "wor", "eu", "ss", "jp"]),
      description: pickText(game.synopsis),
      developer: game.developpeur?.text || "",
      publisher: game.editeur?.text || "",
      genre,
      releaseDate: pickText(game.dates, ["us", "wor", "eu", "jp"]),
      players: game.joueurs?.text || "",
      rating: Number.isFinite(rating) ? rating / 20 : undefined,
      screenscraperId: game.id,
    },
    coverUrl: pickMedia(game.medias, "box-2D"),
    screenshotUrl: pickMedia(game.medias, "ss"),
  };
}

// A provider object for roms.cjs: lookup({system, romName, crc, file}).
function createProvider(account, options = {}) {
  const pause = options.pauseMs ?? PAUSE_MS;
  let last = 0;
  let queue = Promise.resolve();
  async function call(endpoint, params) {
    const run = async () => {
      const wait = last + pause - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      last = Date.now();
      return net.getJson(`${API}/${endpoint}?${params}`);
    };
    const result = queue.then(run);
    queue = result.catch(() => {});
    return result;
  }
  async function lookup({ system, romName, crc, file }) {
    const systemId = SYSTEM_IDS[system];
    if (!systemId) return null;
    const params = credentialParams(account);
    params.set("systemeid", String(systemId));
    params.set("romtype", "rom");
    params.set("romnom", (file?.source || romName).split(/[\\/]/).pop());
    if (file?.size) params.set("romtaille", String(file.size));
    if (crc) params.set("crc", crc);
    const answer = await call("jeuInfos.php", params);
    const game = answer?.response?.jeu;
    if (!game) return null;
    const parsed = parseGame(game);
    const images = {};
    for (const [kind, url] of [
      ["cover", parsed.coverUrl],
      ["screenshot", parsed.screenshotUrl],
    ]) {
      if (url) images[kind] = await net.getBuffer(url).catch(() => null);
    }
    return {
      meta: Object.fromEntries(
        Object.entries(parsed.meta).filter(([, v]) => v !== undefined && v !== ""),
      ),
      images,
    };
  }
  // Checks the account; returns the user's request limits.
  async function check() {
    const answer = await call("ssuserInfos.php", credentialParams(account));
    const user = answer?.response?.ssuser;
    if (!user) throw new Error("ScreenScraper did not accept these credentials.");
    return {
      user: user.id,
      maxThreads: Number(user.maxthreads) || 1,
      requestsToday: Number(user.requeststoday) || 0,
      maxRequestsPerDay: Number(user.maxrequestsperday) || 0,
    };
  }
  return { lookup, check };
}

module.exports = { createProvider, configured, parseGame, SYSTEM_IDS };
