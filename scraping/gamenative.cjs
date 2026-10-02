// GameNative compatibility data: the same reports gamenative.app/compatibility
// shows, from its public API. Each report carries the container config the
// reporter used; the best one for the device's GPU can be saved to the device
// and imported in GameNative with Import Config.
const fs = require("node:fs/promises");
const path = require("node:path");
const net = require("./net.cjs");

// The one place that knows the source; swap it here for an official API.
const API = "https://api.gamenative.app/api";
const SITE = "https://gamenative.app/compatibility/";
const CACHE_HOURS = 24;
const PAGES = 3;
const PAGE_SIZE = 50;
const DEFAULT_GPU = "Adreno (TM) 740";

// Case and punctuation do not matter: "HOLLOW KNIGHT" equals "Hollow Knight".
function compact(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

async function cached(cacheDir, name, fetchFresh) {
  const file = path.join(cacheDir, "_gamenative", name.replace(/[^\w.-]+/g, "_"));
  try {
    const stat = await fs.stat(file);
    if (Date.now() - stat.mtimeMs < CACHE_HOURS * 3600000) {
      return JSON.parse(await fs.readFile(file, "utf8"));
    }
  } catch {
    // Not cached.
  }
  const value = await fetchFresh();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value));
  return value;
}

// What a pasted text points at:
//   https://store.steampowered.com/app/367520/... -> {steamAppId: 367520}
//   ...?gameId=11 (API or gamenative.app URL)    -> {gameId: 11}
//   11                                           -> {gameId: 11}
//   https://gamenative.app/compatibility/?q=Name -> {query: "Name"}
//   anything else                                -> {query: text}
function parseGameRef(text) {
  const value = String(text || "").trim();
  if (!value) return null;
  const steam =
    value.match(/store\.steampowered\.com\/app\/(\d+)/i) || value.match(/^steam:(\d+)$/i);
  if (steam) return { steamAppId: Number(steam[1]) };
  const id = value.match(/[?&]gameId=(\d+)/i);
  if (id) return { gameId: Number(id[1]) };
  if (/^\d+$/.test(value)) return { gameId: Number(value) };
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const query =
        url.searchParams.get("q") || url.searchParams.get("search") || url.searchParams.get("game");
      if (query) return { query };
    } catch {
      // Not a URL after all.
    }
    throw new Error(
      "That link does not name a game. Paste a Steam store link, a link with gameId=, or a game name.",
    );
  }
  return { query: value };
}

async function search(cacheDir, query) {
  return cached(
    cacheDir,
    `search-${compact(query)}-${Buffer.from(query).toString("hex").slice(0, 40)}.json`,
    async () => {
      const result = await net.getJson(`${API}/games/search?q=${encodeURIComponent(query)}`);
      return result?.games || [];
    },
  );
}

// Every GameNative game for a title. The search returns only a few results, so
// a few spellings are tried; "matches" are the games whose name equals the
// title ignoring case and punctuation (GameNative can list the same game twice
// with different capitalisation), "others" are the rest.
async function searchGames(cacheDir, title) {
  const tries = [
    ...new Set([
      title,
      title.toLowerCase(),
      title.toUpperCase(),
      title.replace(/[^\w\s]/g, " ").trim(),
    ]),
  ];
  const byId = new Map();
  for (const query of tries.filter(Boolean)) {
    for (const game of await search(cacheDir, query)) byId.set(game.id, game);
  }
  const games = [...byId.values()];
  const matches = games.filter((g) => compact(g.name) === compact(title));
  const others = games.filter((g) => compact(g.name) !== compact(title));
  return { matches, others };
}

// The newest reports are fetched; the best come first: highest rating, then
// newest, then highest average FPS.
// Only reports that include a config are useful for importing.
function rankRuns(runs) {
  return runs
    .filter((run) => run.configs && typeof run.configs === "object")
    .sort(
      (a, b) =>
        (b.rating || 0) - (a.rating || 0) ||
        String(b.createdAt || "").localeCompare(String(a.createdAt || "")) ||
        (b.avgFps || 0) - (a.avgFps || 0),
    );
}

// The newest reports of a game on a GPU: {runs, total}; total is GameNative's
// count of all its reports there (only the newest are fetched).
async function reports(cacheDir, gameId, gpu) {
  return cached(cacheDir, `reports-${gameId}-${compact(gpu)}.json`, async () => {
    const runs = [];
    let total = 0;
    for (let page = 0; page < PAGES; page++) {
      const query = new URLSearchParams({
        gameId: String(gameId),
        gpu,
        sort: "created_at",
        dir: "desc",
        page: String(page),
        limit: String(PAGE_SIZE),
      });
      const result = await net.getJson(`${API}/compatibility?${query}`);
      const batch = result?.runs || [];
      if (page === 0) total = Number(result?.total) || batch.length;
      runs.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }
    return { runs, total: Math.max(total, runs.length) };
  });
}

function summary(run) {
  return {
    id: run.id,
    gameId: run.gameId,
    gameName: run.gameName || run.game?.name || "",
    rating: run.rating,
    createdAt: run.createdAt,
    appVersion: run.appVersion || "",
    avgFps: run.avgFps,
    device: run.device?.model || "",
    gpu: run.device?.gpu || "",
    notes: run.notes || "",
    tags: run.tags || [],
  };
}

// Reports of several games, each tagged with its game id.
async function reportsFor(cacheDir, games, gpu) {
  const runs = [];
  const counts = {};
  for (const game of games) {
    const found = await reports(cacheDir, game.id, gpu);
    counts[game.id] = found.total;
    runs.push(...found.runs.map((run) => ({ ...run, gameId: game.id, gameName: game.name })));
  }
  return { runs, counts };
}

// The best configs on a GPU. `ref` is what to look up: {title} (searched, case
// variants combined), {gameId}, or {steamAppId, title} (only configs for that
// Steam app). Returns {games, chosen, runs, gpu}.
async function bestConfigs(cacheDir, ref, gpu = DEFAULT_GPU) {
  let games = [];
  let others = [];
  if (ref.gameId) {
    games = [{ id: ref.gameId, name: ref.title || `GameNative game ${ref.gameId}` }];
  } else {
    const found = await searchGames(cacheDir, ref.title || "");
    games = found.matches;
    others = found.others;
  }
  const { runs, counts } = await reportsFor(cacheDir, games, gpu);
  let usable = runs;
  if (ref.steamAppId) usable = runs.filter((run) => run.configs?.id === `STEAM_${ref.steamAppId}`);
  const ranked = rankRuns(usable);
  return {
    gpu,
    games: games.map((g) => ({ ...g, reports: counts[g.id] || 0 })),
    others: others.slice(0, 8),
    runs: ranked.slice(0, 5).map(summary),
    siteUrl: SITE,
  };
}

// The config JSON of one report, from the cache filled by bestConfigs.
async function configFor(cacheDir, gameId, gpu, runId) {
  const { runs } = await reports(cacheDir, gameId, gpu);
  const run = runs.find((r) => r.id === runId);
  if (!run?.configs) throw new Error("That GameNative report has no config.");
  return run.configs;
}

module.exports = {
  bestConfigs,
  configFor,
  rankRuns,
  searchGames,
  parseGameRef,
  compact,
  DEFAULT_GPU,
  API,
  SITE,
};
