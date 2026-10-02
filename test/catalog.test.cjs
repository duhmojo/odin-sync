const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { listFolder, selectedFiles, gameSizes } = require("../catalog.cjs");
const { normalizeFolder } = require("../config.cjs");

async function tree(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "odin-catalog-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, ...relative.split("/"));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  return root;
}

const folder = (root, type, extra = {}) =>
  normalizeFolder({ id: type, name: type, path: root, type, ...extra });
const selection = (extra = {}) => ({ folders: {}, items: [], excluded: [], ...extra });

test("games: each immediate subfolder is one unit, nothing is filtered", async (t) => {
  const root = await tree(t, {
    "Game1/game.exe": "exe",
    "Game1/data/save.db": "database",
    "Game2/run.bat": "bat",
    "loose.txt": "not a game",
  });
  const games = folder(root, "games");
  const listing = await listFolder(games, "", {});
  assert.deepEqual(
    listing.items.map((i) => i.name),
    ["Game1", "Game2"],
  );
  assert.deepEqual(listing.folders, []);
  await assert.rejects(listFolder(games, "Game1", {}), /one level deep/);
  // A type-wide *.db filter must never strip files from a game.
  const files = await selectedFiles(games, selection({ items: ["Game1"] }), {
    files: { excludeFiles: "\\.db$" },
  });
  assert.deepEqual(files.map((f) => f.relative).sort(), ["Game1/data/save.db", "Game1/game.exe"]);
  const sizes = await gameSizes(games, ["Game1"]);
  assert.deepEqual(sizes.Game1, { size: 11, files: 2 });
});

test("roms: extensions, folder and file regexes, and type-wide filters", async (t) => {
  const root = await tree(t, {
    "nds/Mario.nds": "m",
    "nds/Zelda (Beta).nds": "z",
    "nds/readme.txt": "r",
    "psx/Game.chd": "g",
    "media/cover.png": "p",
  });
  const roms = folder(root, "roms", { excludeFolders: "^media$" });
  const top = await listFolder(roms, "", {});
  assert.deepEqual(
    top.folders.map((f) => f.name),
    ["nds", "psx"],
  );
  assert.equal(top.hidden.folders, 1);
  const nds = await listFolder(roms, "nds", { roms: { excludeFiles: "\\(Beta\\)" } });
  assert.deepEqual(
    nds.items.map((i) => i.name),
    ["Mario.nds"],
  );
  assert.equal(nds.hidden.files, 2);
  const noSubfolders = folder(root, "roms", { includeSubfolders: false });
  assert.deepEqual((await listFolder(noSubfolders, "", {})).folders, []);
  await assert.rejects(listFolder(noSubfolders, "nds", {}), /Subfolders are turned off/);
});

test("roms: CUE/BIN and multi-disc M3U sets are one entry with all their files", async (t) => {
  const root = await tree(t, {
    "psx/Game.cue": 'FILE "Game (Track 1).bin" BINARY\nFILE "Game (Track 2).bin" BINARY\n',
    "psx/Game (Track 1).bin": "1",
    "psx/Game (Track 2).bin": "2",
    "psx/Multi.m3u": "Multi (Disc 1).chd\nMulti (Disc 2).chd\n",
    "psx/Multi (Disc 1).chd": "d1",
    "psx/Multi (Disc 2).chd": "d2",
    "psx/Broken.cue": 'FILE "missing.bin" BINARY\n',
  });
  const listing = await listFolder(folder(root, "roms"), "psx", {});
  assert.deepEqual(
    listing.items.map((i) => [i.name, i.files.length]),
    [
      ["Game.cue", 3],
      ["Multi.m3u", 3],
    ],
  );
  assert.equal(listing.warnings.length, 1);
  assert.match(listing.warnings[0].message, /missing file missing\.bin/);
});

test("selection resolves folder rules, exclusions and reports missing items", async (t) => {
  const root = await tree(t, {
    "nds/a.nds": "a",
    "nds/b.nds": "b",
    "nds/new/c.nds": "c",
    "gba/x.gba": "x",
  });
  const roms = folder(root, "roms");
  const warnings = [];
  const files = await selectedFiles(
    roms,
    selection({
      folders: { nds: true },
      excluded: ["nds/b.nds"],
      items: ["gba/x.gba", "gba/renamed.gba"],
    }),
    {},
    warnings,
  );
  assert.deepEqual(files.map((f) => f.relative).sort(), [
    "gba/x.gba",
    "nds/a.nds",
    "nds/new/c.nds",
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /not found/);
});

test("music: folders and individual files, no grouping", async (t) => {
  const root = await tree(t, { "Album/01.mp3": "1", "Album/cover.jpg": "c", "02.flac": "2" });
  const music = folder(root, "music");
  const listing = await listFolder(music, "", {});
  assert.deepEqual(
    listing.items.map((i) => i.name),
    ["02.flac"],
  );
  const files = await selectedFiles(music, selection({ folders: { "": true } }), {});
  assert.deepEqual(files.map((f) => f.relative).sort(), ["02.flac", "Album/01.mp3"]);
});

test("an unavailable local folder is a warning, not a crash", async () => {
  const warnings = [];
  const missing = folder(path.resolve("/definitely/missing/odin"), "roms");
  const files = await selectedFiles(missing, selection({ folders: { "": true } }), {}, warnings);
  assert.deepEqual(files, []);
  assert.match(warnings[0].message, /unavailable/);
});

test("missing, escaping and circular playlists are skipped with warnings", async (t) => {
  for (const [text, pattern] of [
    ["missing.iso", /missing file/],
    ["../outside.iso", /outside/],
    ["game.m3u", /Circular/],
  ]) {
    const root = await tree(t, { "game.m3u": text });
    const listing = await listFolder(folder(root, "roms"), "", {});
    assert.equal(listing.items.length, 0);
    assert.equal(listing.warnings.length, 1);
    assert.match(listing.warnings[0].message, pattern);
  }
});

test("theme playlist directives never hide unrelated games", async (t) => {
  const root = await tree(t, {
    "themes/art/test.m3u": "#EXTM3U\n;#RESETONSHOW\n; theme directive\n",
    "game.iso": "game",
  });
  const roms = folder(root, "roms");
  assert.deepEqual(
    (await listFolder(roms, "", {})).items.map((i) => i.name),
    ["game.iso"],
  );
  const theme = await listFolder(roms, "themes/art", {});
  assert.equal(theme.items.length, 0);
  assert.match(theme.warnings[0].message, /no game file references/);
});

test("comments and a byte-order mark are ignored in playlists", async (t) => {
  const root = await tree(t, {
    "disc.iso": "disc",
    "game.m3u": "﻿#EXTM3U\r\n;#RESETONSHOW\r\ndisc.iso\r\n",
  });
  const listing = await listFolder(folder(root, "roms"), "", {});
  assert.deepEqual(
    listing.items.map((i) => [i.name, i.files.length]),
    [["game.m3u", 2]],
  );
  assert.equal(listing.warnings.length, 0);
});

test("a broken playlist does not hide the valid files it references", async (t) => {
  const root = await tree(t, { "disc.iso": "disc", "broken.m3u": "disc.iso\nmissing.iso" });
  const listing = await listFolder(folder(root, "roms"), "", {});
  assert.deepEqual(
    listing.items.map((i) => i.name),
    ["disc.iso"],
  );
  assert.equal(listing.warnings.length, 1);
});
