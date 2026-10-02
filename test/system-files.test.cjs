const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { listFolder, selectedFiles } = require("../catalog.cjs");
const { normalizeFolder, TYPES } = require("../config.cjs");

async function tree(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "odin-system-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, ...relative.split("/"));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  return root;
}

test("macOS and Windows metadata never appear in ROM folders", async (t) => {
  const root = await tree(t, {
    ".DS_Store": "x",
    "._Mario.nds": "x",
    "Mario.nds": "m",
    "Thumbs.db": "x",
    "desktop.ini": "x",
    "__MACOSX/Mario.nds": "x",
    ".Trashes/a": "x",
  });
  const roms = normalizeFolder({ id: "r", name: "R", path: root, type: "roms", extensions: "*" });
  const listing = await listFolder(roms, "", {});
  assert.deepEqual(
    listing.items.map((i) => i.name),
    ["Mario.nds"],
  );
  assert.deepEqual(listing.folders, []);
  assert.equal(listing.hidden.files, 0, "system files are not counted as filtered");
});

test("games skip macOS metadata but keep everything else, including .db files", async (t) => {
  const root = await tree(t, {
    "Game1/game.exe": "e",
    "Game1/.DS_Store": "x",
    "Game1/data/._save.db": "x",
    "Game1/data/save.db": "s",
    "Game1/Thumbs.db": "t",
    "__MACOSX/Game1/x": "x",
  });
  const games = normalizeFolder({ id: "g", name: "G", path: root, type: "games" });
  const listing = await listFolder(games, "", {});
  assert.deepEqual(
    listing.items.map((i) => i.name),
    ["Game1"],
  );
  const files = await selectedFiles(games, { folders: { "": true }, items: [], excluded: [] }, {});
  assert.deepEqual(files.map((f) => f.relative).sort(), [
    "Game1/Thumbs.db",
    "Game1/data/save.db",
    "Game1/game.exe",
  ]);
});

test("ROM folders have default folder excludes for frontend artwork and BIOS", () => {
  const regex = new RegExp(TYPES.roms.excludeFolders, "i");
  for (const name of ["media", "BIOS", "snap", "wheel", "mixart", "boxart"])
    assert.ok(regex.test(name), name);
  assert.equal(regex.test("psx"), false);
  assert.equal(regex.test("snes"), false);
});
