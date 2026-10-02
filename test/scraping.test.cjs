const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const net = require("../scraping/net.cjs");
const libretro = require("../scraping/libretro.cjs");
const steam = require("../scraping/steam.cjs");
const gamenative = require("../scraping/gamenative.cjs");
const media = require("../scraping/media.cjs");
const { scrapeRom, zipCrc, romCrc, systemFor } = require("../scraping/roms.cjs");
const { guessSystem } = require("../scraping/systems.cjs");

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "odin-scrape-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// Answers requests from a table of URL substrings, like recorded responses.
function fakeNetwork(t, routes) {
  const requested = [];
  net.setFetch(async (url) => {
    requested.push(url);
    const route = Object.keys(routes).find((key) => decodeURIComponent(url).includes(key));
    if (!route) return new Response("", { status: 404 });
    const body = routes[route];
    if (Buffer.isBuffer(body))
      return new Response(body, { headers: { "content-type": "image/png" } });
    if (typeof body === "string")
      return new Response(body, { headers: { "content-type": "text/plain" } });
    return Response.json(body);
  });
  t.after(() => net.setFetch((...args) => fetch(...args)));
  return requested;
}

const DS = "Nintendo - Nintendo DS";
const INDEX_COVERS = `<a href="../">..</a><a href="Mario%20Kart%20DS%20(Europe)%20(En%2CFr).png">x</a>
<a href="Mario%20Kart%20DS%20(USA%2C%20Australia).png">x</a><a href="Pok%C3%A9mon%20-%20Black%20Version%20(USA%2C%20Europe).png">x</a>`;
const DAT = (field, value) => `clrmamepro (\n\tname "${DS}"\n)\n
game (\n\tcomment "Mario Kart DS (USA, Australia)"\n\t${field} "${value}"\n\trom ( crc AABBCCDD )\n)\n`;

function libretroRoutes() {
  return {
    [`${DS}/Named_Boxarts/Mario Kart DS (USA, Australia).png`]: Buffer.from("cover"),
    [`${DS}/Named_Snaps/Mario Kart DS (USA, Australia).png`]: Buffer.from("snap"),
    [`${DS}/Named_Boxarts/`]: INDEX_COVERS,
    [`${DS}/Named_Snaps/`]: INDEX_COVERS,
    [`developer/${DS}.dat`]: DAT("developer", "Nintendo EAD"),
    [`publisher/${DS}.dat`]: DAT("publisher", "Nintendo"),
    [`genre/${DS}.dat`]: DAT("genre", "Racing"),
    [`releaseyear/${DS}.dat`]: DAT("releaseyear", "2005"),
  };
}

test("systems are guessed from common folder names", () => {
  assert.equal(guessSystem("psx"), "psx");
  assert.equal(guessSystem("PS1"), "psx");
  assert.equal(guessSystem("Nintendo DS"), "nds");
  assert.equal(guessSystem("genesis"), "megadrive");
  assert.equal(guessSystem("My Stuff"), "");
  const folder = { id: "r", name: "ROMs", path: "/x/roms", type: "roms", system: "" };
  assert.equal(systemFor(folder, { id: "snes/Zelda.sfc" }), "snes");
  assert.equal(
    systemFor({ ...folder, system: "gba" }, { id: "snes/Zelda.sfc" }),
    "gba",
    "the folder setting wins",
  );
});

test("libretro: matched by name (USA preferred), with metadata from the database", async (t) => {
  const cache = await tempDir(t);
  fakeNetwork(t, libretroRoutes());
  const found = await libretro.lookup(cache, DS, "Mario Kart DS", "");
  assert.equal(found.title, "Mario Kart DS");
  assert.equal(found.fullName, "Mario Kart DS (USA, Australia)");
  assert.equal(found.developer, "Nintendo EAD");
  assert.equal(found.genre, "Racing");
  assert.equal(found.releaseDate, "2005");
  assert.match(found.coverUrl, /Named_Boxarts\/Mario%20Kart%20DS%20\(USA%2C%20Australia\)\.png$/);
});

test("libretro: a CRC match finds the canonical name even with an odd file name", async (t) => {
  const cache = await tempDir(t);
  fakeNetwork(t, libretroRoutes());
  const found = await libretro.lookup(cache, DS, "mkds_final", "aabbccdd");
  assert.equal(found.matchedBy, "crc");
  assert.equal(found.fullName, "Mario Kart DS (USA, Australia)");
});

test("ROM scraping stores cover, snap and metadata; zip CRCs come from the central directory", async (t) => {
  const dir = await tempDir(t);
  // A real zip with one stored file, made by hand.
  const data = Buffer.from("ROMDATA");
  const crc = zlib.crc32(data) >>> 0;
  const name = Buffer.from("game.nds");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  const centralOffset = local.length + name.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  const zip = path.join(dir, "Mario Kart DS.zip");
  await fs.writeFile(zip, Buffer.concat([local, name, data, central, name, end]));
  assert.equal(await zipCrc(zip), crc.toString(16).toUpperCase().padStart(8, "0"));
  assert.equal(await romCrc(path.join(dir, "x.chd"), 10), "", "disc images are matched by name");

  fakeNetwork(t, libretroRoutes());
  const folder = { id: "roms", name: "ROMs", path: dir, type: "roms", system: "nds" };
  const item = {
    id: "Mario Kart DS.zip",
    name: "Mario Kart DS.zip",
    files: [{ source: zip, size: 100 }],
  };
  const scraped = await scrapeRom({ folder, item, cacheDir: path.join(dir, "cache") });
  assert.equal(scraped.meta.system, "nds");
  assert.equal(scraped.meta.developer, "Nintendo EAD");
  assert.equal(scraped.images.cover.data.toString(), "cover");
  assert.equal(scraped.images.screenshot.data.toString(), "snap");
  const mediaDir = path.join(dir, "media");
  await media.write(mediaDir, "roms", item.id, scraped.meta, scraped.images, () =>
    Buffer.from("thumb"),
  );
  const listed = await media.list(mediaDir, "roms");
  assert.equal(listed[item.id].title, "Mario Kart DS");
  assert.deepEqual(Object.keys(listed[item.id].files).sort(), ["cover", "screenshot", "thumb"]);
  assert.match(
    await media.dataUrl(mediaDir, "roms", item.id, "thumb.jpg"),
    /^data:image\/jpeg;base64,/,
  );
});

test("Steam: the folder name is cleaned, the exact title is picked, details and art are stored", async (t) => {
  fakeNetwork(t, {
    "storesearch/?term=Hollow Knight": {
      items: [
        { type: "app", id: 1030300, name: "Hollow Knight: Silksong" },
        { type: "app", id: 367520, name: "Hollow Knight" },
      ],
    },
    "appdetails?appids=367520": {
      367520: {
        success: true,
        data: {
          name: "Hollow Knight",
          short_description: "Forge your own path <b>now</b>.",
          developers: ["Team Cherry"],
          publishers: ["Team Cherry"],
          release_date: { date: "24 Feb, 2017" },
          genres: [{ description: "Action" }, { description: "Indie" }],
          screenshots: [{ path_full: "https://cdn.example/shot.jpg" }],
          header_image: "https://cdn.example/header.jpg",
        },
      },
    },
    "367520/library_600x900_2x.jpg": Buffer.from("cover"),
    "shot.jpg": Buffer.from("shot"),
  });
  assert.equal(steam.cleanName("Hollow Knight v1.5.78 (GOG) [Repack]"), "Hollow Knight");
  const result = await steam.scrapeGame({ item: { name: "Hollow Knight v1.5.78 (GOG)" } });
  assert.equal(result.meta.steamAppId, 367520);
  assert.equal(result.meta.description, "Forge your own path now.");
  assert.equal(result.meta.genre, "Action, Indie");
  assert.equal(result.images.cover.data.toString(), "cover");
  assert.equal(result.meta.candidates.length, 2, "other matches are kept for 'Wrong game?'");
});

function gnRun(id, rating, createdAt, avgFps, configs = { id: "STEAM_367520" }) {
  return {
    id,
    rating,
    createdAt,
    avgFps,
    appVersion: "1.2.1",
    configs,
    device: { model: "AYN Odin2 Portal", gpu: "Adreno (TM) 740" },
  };
}

test("GameNative: reports with a config, best rating first, then newest, then FPS", async (t) => {
  const cache = await tempDir(t);
  const requested = fakeNetwork(t, {
    "games/search?q=": {
      games: [
        { id: 19, name: "Hollow Knight: Silksong" },
        { id: 11, name: "Hollow Knight" },
      ],
    },
    "compatibility?gameId=11": {
      runs: [
        gnRun(1, 4, "2026-09-30T10:00:00Z", 60),
        gnRun(2, 5, "2026-09-01T10:00:00Z", 50),
        gnRun(3, 5, "2026-09-29T10:00:00Z", 40),
        gnRun(4, 5, "2026-09-29T10:00:00Z", 58),
        gnRun(5, 5, "2026-09-30T12:00:00Z", 30, null),
      ],
    },
  });
  const found = await gamenative.bestConfigs(cache, { title: "Hollow Knight" }, "Adreno (TM) 740");
  assert.deepEqual(
    found.games.map((g) => g.id),
    [11],
    "the exact title, not Silksong",
  );
  assert.deepEqual(
    found.others.map((g) => g.id),
    [19],
  );
  assert.deepEqual(
    found.runs.map((r) => r.id),
    [4, 3, 2, 1],
    "no-config report dropped; rating, then date, then FPS",
  );
  assert.ok(requested.some((url) => url.includes("gpu=Adreno+%28TM%29+740")));
  assert.ok(
    requested.some((url) => url.includes("sort=created_at&dir=desc")),
    "newest reports are fetched",
  );
  assert.deepEqual(await gamenative.configFor(cache, 11, "Adreno (TM) 740", 4), {
    id: "STEAM_367520",
  });
});

test("GameNative: case variants of the same name are found and combined", async (t) => {
  const cache = await tempDir(t);
  const requested = fakeNetwork(t, {
    "games/search?q=Dead Cells": { games: [{ id: 100, name: "Dead Cells" }] },
    "games/search?q=dead cells": { games: [{ id: 200, name: "dead cells" }] },
    "games/search?q=DEAD CELLS": {
      games: [
        { id: 100, name: "Dead Cells" },
        { id: 300, name: "DEAD CELLS" },
      ],
    },
    "compatibility?gameId=100": { runs: [gnRun(1, 4, "2026-09-01T00:00:00Z", 60)] },
    "compatibility?gameId=200": { runs: [gnRun(2, 5, "2026-08-01T00:00:00Z", 60)] },
    "compatibility?gameId=300": { runs: [] },
  });
  const found = await gamenative.bestConfigs(cache, { title: "Dead Cells" });
  assert.deepEqual(
    found.games.map((g) => [g.name, g.reports]),
    [
      ["Dead Cells", 1],
      ["dead cells", 1],
      ["DEAD CELLS", 0],
    ],
  );
  assert.deepEqual(
    found.runs.map((r) => [r.id, r.gameName]),
    [
      [2, "dead cells"],
      [1, "Dead Cells"],
    ],
    "the best report wins whichever entry it was filed under",
  );
  assert.ok(
    requested.some((url) => decodeURIComponent(url).includes("q=dead cells")),
    "lower case is tried too",
  );
});

test("GameNative: a Steam link keeps only that Steam app's configs; a game id is used as is", async (t) => {
  const cache = await tempDir(t);
  fakeNetwork(t, {
    "games/search?q=": { games: [{ id: 11, name: "Hollow Knight" }] },
    "compatibility?gameId=11": {
      runs: [
        gnRun(1, 5, "2026-09-30T00:00:00Z", 60, { id: "EPIC_x" }),
        gnRun(2, 4, "2026-09-01T00:00:00Z", 60),
      ],
    },
    "compatibility?gameId=42": { runs: [gnRun(3, 3, "2026-09-01T00:00:00Z", 30)] },
  });
  const steamOnly = await gamenative.bestConfigs(cache, {
    title: "Hollow Knight",
    steamAppId: 367520,
  });
  assert.deepEqual(
    steamOnly.runs.map((r) => r.id),
    [2],
  );
  const byId = await gamenative.bestConfigs(cache, { gameId: 42, title: "Hollow Knight" });
  assert.deepEqual(
    byId.games.map((g) => g.id),
    [42],
  );
  assert.deepEqual(
    byId.runs.map((r) => r.id),
    [3],
  );
});

test("GameNative: pasted links and names are understood", () => {
  const { parseGameRef } = gamenative;
  assert.deepEqual(parseGameRef("https://store.steampowered.com/app/367520/Hollow_Knight/"), {
    steamAppId: 367520,
  });
  assert.deepEqual(
    parseGameRef("https://api.gamenative.app/api/compatibility?gameId=11&gpu=Adreno"),
    { gameId: 11 },
  );
  assert.deepEqual(parseGameRef("https://gamenative.app/compatibility/?gameId=11"), { gameId: 11 });
  assert.deepEqual(parseGameRef(" 11 "), { gameId: 11 });
  assert.deepEqual(parseGameRef("https://gamenative.app/compatibility/?q=Hades%20II"), {
    query: "Hades II",
  });
  assert.deepEqual(parseGameRef("hades ii"), { query: "hades ii" });
  assert.equal(parseGameRef(""), null);
  assert.throws(
    () => parseGameRef("https://gamenative.app/compatibility/"),
    /does not name a game/,
  );
});

test("ScreenScraper: English texts, US box art, rating out of 1, one request at a time", async (t) => {
  const { createProvider, parseGame } = require("../scraping/screenscraper.cjs");
  const parsed = parseGame({
    id: "3",
    noms: [
      { region: "jp", text: "Mario Kart DS (J)" },
      { region: "us", text: "Mario Kart DS" },
    ],
    synopsis: [
      { langue: "fr", text: "Course" },
      { langue: "en", text: "Race on the DS." },
    ],
    developpeur: { text: "Nintendo EAD" },
    genres: [{ noms: [{ langue: "en", text: "Racing" }] }],
    dates: [{ region: "us", text: "2005-11-14" }],
    note: { text: "17" },
    medias: [
      { type: "box-2D", region: "eu", url: "https://ss/eu.png" },
      { type: "box-2D", region: "us", url: "https://ss/us.png" },
      { type: "ss", region: "wor", url: "https://ss/shot.png" },
    ],
  });
  assert.equal(parsed.meta.title, "Mario Kart DS");
  assert.equal(parsed.meta.description, "Race on the DS.");
  assert.equal(parsed.meta.rating, 0.85);
  assert.equal(parsed.coverUrl, "https://ss/us.png");
  const times = [];
  fakeNetwork(t, {
    "jeuInfos.php": { response: { jeu: { id: "1", noms: [{ region: "us", text: "X" }] } } },
  });
  const provider = createProvider(
    { user: "u", password: "p", devId: "d", devPassword: "dp" },
    { pauseMs: 50 },
  );
  await Promise.all(
    [1, 2].map(async () => {
      await provider.lookup({ system: "nds", romName: "X", crc: "ABCD1234", file: { size: 10 } });
      times.push(Date.now());
    }),
  );
  assert.ok(Math.abs(times[1] - times[0]) >= 45, "requests are spaced out");
  assert.equal(await provider.lookup({ system: "unknown", romName: "X" }), null);
});

test("Steam: pasted store or community links and bare app ids give the app id", () => {
  assert.equal(
    steam.parseAppRef("https://store.steampowered.com/app/367520/Hollow_Knight/"),
    367520,
  );
  assert.equal(steam.parseAppRef("store.steampowered.com/app/1145360?snr=1_7_15"), 1145360);
  assert.equal(steam.parseAppRef("https://steamcommunity.com/app/367520/discussions/"), 367520);
  assert.equal(steam.parseAppRef(" 367520 "), 367520);
  assert.equal(steam.parseAppRef("Hollow Knight"), null);
  assert.equal(steam.parseAppRef("https://store.steampowered.com/search/?term=x"), null);
  assert.equal(
    steam.searchUrl("Hollow Knight"),
    "https://store.steampowered.com/search/?term=Hollow%20Knight",
  );
});
