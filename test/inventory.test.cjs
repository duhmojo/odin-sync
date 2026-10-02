const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const config = require("../config.cjs");
const plan = require("../plan.cjs");
const inventory = require("../inventory.cjs");
const { runSync } = require("../transfer.cjs");
const { FakeDevice } = require("./fake-device.cjs");

async function tree(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "odin-inventory-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, ...relative.split("/"));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  return root;
}

function setup(roots) {
  let next = config.emptyConfig();
  next.devices.push({ id: "odin", name: "Odin", transport: "receiver", hardwareId: "x", receiver: { id: "11111111-2222-3333-4444-555555555555", key: Buffer.alloc(32).toString("base64") } });
  config.ensureProfiles(next);
  for (const [id, type, root, target] of roots) {
    next = config.saveFolder(next, { id, name: id, path: root, type }).config;
    next = config.setDestination(next, "odin", id, target);
  }
  return next;
}

// The same check + sync + inventory update the app runs.
async function syncOnce(current, adb, known, options = {}) {
  const resolved = await plan.resolvePlanFiles(current, "odin");
  const check = await plan.checkDevice(resolved, adb, inventory.entries(known));
  const outcome = await runSync(check.entries, adb, options);
  inventory.apply(known, outcome.results, check.gone);
  return { check, outcome };
}

const actions = (check) => check.entries.map((e) => [e.relative, e.action]).sort();

test("unselecting removes only files the app copied; other device files stay", async (t) => {
  const root = await tree(t, { "nds/a.nds": "aa", "nds/b.nds": "bb" });
  let current = setup([["roms", "roms", root, "/sdcard/ROMs"]]);
  current = config.setFolderSelection(current, "odin", "roms", "nds", true);
  const adb = new FakeDevice({ "/sdcard/ROMs/nds/mine.nds": Buffer.from("user") });
  const known = inventory.empty("odin");
  await syncOnce(current, adb, known);
  assert.equal(inventory.entries(known).length, 2);

  current = config.setItemSelection(
    current,
    "odin",
    "roms",
    [{ id: "nds/b.nds", folder: "nds" }],
    false,
  );
  const { check } = await syncOnce(current, adb, known, { remove: false });
  assert.deepEqual(actions(check), [
    ["nds/a.nds", "Unchanged"],
    ["nds/b.nds", "Remove"],
  ]);
  assert.ok(adb.files.has("/sdcard/ROMs/nds/b.nds"), "removal needs to be chosen");

  const second = await syncOnce(current, adb, known, { remove: true });
  assert.equal(second.outcome.results.find((r) => r.relative === "nds/b.nds").status, "removed");
  assert.ok(!adb.files.has("/sdcard/ROMs/nds/b.nds"));
  assert.ok(
    adb.files.has("/sdcard/ROMs/nds/mine.nds"),
    "a file the app did not copy is never removed",
  );
  assert.ok(adb.files.has("/sdcard/ROMs/nds/a.nds"));
  assert.equal(inventory.entries(known).length, 1);

  // Unselecting everything leaves an empty folder behind only if other files are there.
  current = config.setFolderSelection(current, "odin", "roms", "nds", false);
  await syncOnce(current, adb, known, { remove: true });
  assert.ok(adb.removedDirs.includes("/sdcard/ROMs/nds"));
  assert.ok(!adb.removedDirs.includes("/sdcard/ROMs"), "the destination root itself is never removed");
});

test("a file changed on the device since it was copied is kept, and a managed change is an Update", async (t) => {
  const root = await tree(t, { "a.nds": "aa", "b.nds": "bb" });
  let current = setup([["roms", "roms", root, "/sdcard/ROMs"]]);
  current = config.setFolderSelection(current, "odin", "roms", "", true);
  const adb = new FakeDevice();
  const known = inventory.empty("odin");
  await syncOnce(current, adb, known);
  await fs.writeFile(path.join(root, "a.nds"), "a longer file");
  adb.files.set("/sdcard/ROMs/b.nds", Buffer.from("edited on device"));
  current = config.setItemSelection(current, "odin", "roms", [{ id: "b.nds", folder: "" }], false);
  const { check, outcome } = await syncOnce(current, adb, known, { remove: true });
  assert.deepEqual(actions(check), [["a.nds", "Update"]]);
  assert.match(check.kept[0].reason, /changed on the device/);
  assert.equal(
    adb.files.get("/sdcard/ROMs/a.nds").toString(),
    "a longer file",
    "updates copy by default",
  );
  assert.equal(adb.files.get("/sdcard/ROMs/b.nds").toString(), "edited on device");
  assert.equal(outcome.results.filter((r) => r.status === "removed").length, 0);
});

test("a deselected game is removed whole, unless its folder holds files the app did not copy", async (t) => {
  const root = await tree(t, {
    "Game1/game.exe": "e",
    "Game1/data/save.db": "s",
    "Game2/run.bat": "r",
  });
  let current = setup([["games", "games", root, "/sdcard/Games"]]);
  current = config.setFolderSelection(current, "odin", "games", "", true);
  const adb = new FakeDevice();
  const known = inventory.empty("odin");
  await syncOnce(current, adb, known);
  adb.files.set("/sdcard/Games/Game2/save-on-device.dat", Buffer.from("progress"));
  current = config.setFolderSelection(current, "odin", "games", "", false);
  const { check } = await syncOnce(current, adb, known, { remove: true });
  assert.deepEqual(actions(check), [
    ["Game1/data/save.db", "Remove"],
    ["Game1/game.exe", "Remove"],
  ]);
  assert.equal(check.kept.length, 1);
  assert.equal(check.kept[0].itemId, "Game2");
  assert.match(check.kept[0].reason, /extra file/);
  assert.ok(!adb.files.has("/sdcard/Games/Game1/game.exe"));
  assert.ok(adb.files.has("/sdcard/Games/Game2/run.bat"));
  assert.ok(adb.removedDirs.includes("/sdcard/Games/Game1/data"));
  assert.ok(adb.removedDirs.includes("/sdcard/Games/Game1"));
});

test("nothing is removed for a local folder that is unavailable or has no destination", async (t) => {
  const root = await tree(t, { "a.nds": "aa" });
  let current = setup([["roms", "roms", root, "/sdcard/ROMs"]]);
  current = config.setFolderSelection(current, "odin", "roms", "", true);
  const adb = new FakeDevice();
  const known = inventory.empty("odin");
  await syncOnce(current, adb, known);
  await fs.rm(root, { recursive: true, force: true });
  const { check } = await syncOnce(current, adb, known, { remove: true });
  assert.equal(check.entries.length, 0);
  assert.ok(adb.files.has("/sdcard/ROMs/a.nds"), "drive unplugged: keep device files");
});

test("files already gone from the device are dropped from the inventory", async (t) => {
  const root = await tree(t, { "a.nds": "aa" });
  let current = setup([["roms", "roms", root, "/sdcard/ROMs"]]);
  current = config.setFolderSelection(current, "odin", "roms", "", true);
  const adb = new FakeDevice();
  const known = inventory.empty("odin");
  await syncOnce(current, adb, known);
  adb.files.delete("/sdcard/ROMs/a.nds");
  current = config.setFolderSelection(current, "odin", "roms", "", false);
  const { check } = await syncOnce(current, adb, known, { remove: true });
  assert.deepEqual(check.gone, ["/sdcard/ROMs/a.nds"]);
  assert.equal(inventory.entries(known).length, 0);
});

test("a new inventory is seeded from earlier sync logs of the same device", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "odin-seed-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const log = {
    device: { id: "odin" },
    finishedAt: "2026-09-30T11:36:49Z",
    results: [
      {
        relative: "Game1/game.exe",
        folder: "PC Games",
        target: "/sdcard/Games/Game1/game.exe",
        size: 3,
        status: "copied",
      },
      {
        relative: "x.nds",
        folder: "ROMs",
        target: "/sdcard/ROMs/x.nds",
        size: 1,
        status: "failed",
      },
    ],
  };
  await fs.writeFile(path.join(dir, "sync-log-2026-09-30T11-36-49-953Z.json"), JSON.stringify(log));
  const current = {
    folders: [
      { id: "g", name: "PC Games", type: "games" },
      { id: "r", name: "ROMs", type: "roms" },
    ],
  };
  const known = await inventory.load(dir, "odin", current);
  assert.deepEqual(
    inventory.entries(known).map((e) => [e.target, e.folderId, e.itemId]),
    [["/sdcard/Games/Game1/game.exe", "g", "Game1"]],
  );
  const other = await inventory.load(dir, "someone-else", current);
  assert.equal(inventory.entries(other).length, 0);
});
