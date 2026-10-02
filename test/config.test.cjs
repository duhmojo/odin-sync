const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const config = require("../config.cjs");

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "odin-config-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function withDevice() {
  const base = config.emptyConfig();
  base.devices.push({
    id: "odin",
    name: "Odin 2",
    transport: "receiver",
    hardwareId: "abc",
    receiver: { id: "11111111-2222-3333-4444-555555555555", key: Buffer.alloc(32).toString("base64") },
  });
  config.ensureProfiles(base);
  const { config: next } = config.saveFolder(base, {
    id: "roms",
    name: "ROMs",
    path: path.resolve("/roms"),
    type: "roms",
  });
  return next;
}

test("missing config starts empty with no notice", async (t) => {
  const dir = await tempDir(t);
  const result = await config.loadConfig(dir);
  assert.match(result.config.desktopId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(result.config, { ...config.emptyConfig(), desktopId: result.config.desktopId });
  assert.equal(result.notice, "");
});

test("an older config version is moved to a backup and the app starts fresh", async (t) => {
  const dir = await tempDir(t);
  await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ version: 2, sources: [] }));
  const result = await config.loadConfig(dir, new Date("2026-09-30T01:02:03Z"));
  assert.equal(result.config.folders.length, 0);
  assert.match(result.notice, /new settings format/);
  const files = await fs.readdir(dir);
  assert.deepEqual(files, ["config-backup-2026-09-30T01-02-03-000Z.json"]);
});

test("invalid JSON is backed up and reported instead of silently discarded", async (t) => {
  const dir = await tempDir(t);
  await fs.writeFile(path.join(dir, "config.json"), "{ not json");
  const result = await config.loadConfig(dir);
  assert.match(result.notice, /invalid JSON/);
  const backup = (await fs.readdir(dir)).find((f) => f.startsWith("config-backup-"));
  assert.equal(await fs.readFile(path.join(dir, backup), "utf8"), "{ not json");
});

test("a valid version 3 config round-trips through save and load", async (t) => {
  const dir = await tempDir(t);
  const saved = config.setDestination(withDevice(), "odin", "roms", "/sdcard/ROMs/");
  await config.saveConfig(dir, saved);
  const loaded = await config.loadConfig(dir);
  assert.equal(loaded.notice, "");
  assert.equal(loaded.config.profiles[0].destinations.roms, "/sdcard/ROMs");
});

test("local folder validation: regexes, types and games ignore filters", () => {
  assert.throws(
    () =>
      config.normalizeFolder({
        name: "A",
        path: path.resolve("/a"),
        type: "roms",
        excludeFiles: "(",
      }),
    /Exclude files is not a valid regular expression/,
  );
  assert.throws(
    () => config.normalizeFolder({ name: "A", path: "relative", type: "roms" }),
    /Choose a folder/,
  );
  const games = config.normalizeFolder({
    name: "Games",
    path: path.resolve("/games"),
    type: "games",
    includeSubfolders: true,
    extensions: ".exe",
    excludeFiles: "\\.db$",
  });
  assert.equal(games.includeSubfolders, false);
  assert.equal(games.extensions, "");
  assert.equal(games.excludeFiles, "");
});

test("type-wide filters exist for every type except games", () => {
  const next = config.setTypeFilters(config.emptyConfig(), {
    roms: { excludeFiles: "\\(Beta\\)" },
    games: { excludeFiles: "\\.db$" },
  });
  assert.equal(next.typeFilters.roms.excludeFiles, "\\(Beta\\)");
  assert.equal(next.typeFilters.games, undefined);
  assert.throws(() => config.setTypeFilters(next, { music: { excludeFolders: "[" } }), /Music/);
});

test("removing a local folder cleans it from every profile", () => {
  let next = config.setDestination(withDevice(), "odin", "roms", "/sdcard/ROMs");
  next = config.setFolderSelection(next, "odin", "roms", "", true);
  next = config.setOverride(next, "odin", "roms", "nds", "/storage/ABCD-1234/nds");
  next = config.removeFolder(next, "roms");
  assert.deepEqual(next.profiles[0], {
    deviceId: "odin",
    destinations: {},
    overrides: {},
    selections: {},
  });
});

test("selection needs a destination first (gap flag)", () => {
  const next = withDevice();
  assert.deepEqual(config.gaps(next, "odin"), ["roms"]);
  assert.throws(() => config.setFolderSelection(next, "odin", "roms", "", true), /Choose where/);
  const set = config.setDestination(next, "odin", "roms", "/sdcard/ROMs");
  assert.deepEqual(config.gaps(set, "odin"), []);
});

test("folder rules, exclusions and individual items combine", () => {
  let next = config.setDestination(withDevice(), "odin", "roms", "/sdcard/ROMs");
  next = config.setFolderSelection(next, "odin", "roms", "psx", true);
  next = config.setItemSelection(next, "odin", "roms", [{ id: "psx/b.chd", folder: "psx" }], false);
  next = config.setItemSelection(next, "odin", "roms", [{ id: "nds/a.nds", folder: "nds" }], true);
  const selection = next.profiles[0].selections.roms;
  assert.equal(config.itemSelected(selection, "psx/a.chd", "psx"), true);
  assert.equal(config.itemSelected(selection, "psx/b.chd", "psx"), false);
  assert.equal(config.itemSelected(selection, "nds/a.nds", "nds"), true);
  assert.equal(config.itemSelected(selection, "nds/c.nds", "nds"), false);
  next = config.setFolderSelection(next, "odin", "roms", "psx/japan", false);
  assert.equal(config.folderRule(next.profiles[0].selections.roms, "psx/japan/x"), false);
  // Re-checking the parent replaces everything inside its branch.
  next = config.setFolderSelection(next, "odin", "roms", "psx", true);
  assert.deepEqual(next.profiles[0].selections.roms.folders, { psx: true });
  assert.deepEqual(next.profiles[0].selections.roms.excluded, []);
  next = config.setFolderSelection(next, "odin", "roms", "psx", false);
  next = config.setItemSelection(next, "odin", "roms", [{ id: "nds/a.nds", folder: "nds" }], false);
  assert.equal(next.profiles[0].selections.roms, undefined);
});

test("one profile per device; removing a device removes its profile", () => {
  const next = withDevice();
  config.ensureProfiles(next);
  assert.equal(next.profiles.length, 1);
  const removed = config.removeDevice(next, "odin");
  assert.equal(removed.profiles.length, 0);
  assert.equal(removed.devices.length, 0);
});

test("changing a folder's path clears its selections and overrides", () => {
  let next = config.setDestination(withDevice(), "odin", "roms", "/sdcard/ROMs");
  next = config.setFolderSelection(next, "odin", "roms", "", true);
  next = config.saveFolder(next, { ...next.folders[0], path: path.resolve("/other") }).config;
  assert.equal(next.profiles[0].selections.roms, undefined);
  assert.equal(next.profiles[0].destinations.roms, "/sdcard/ROMs");
});

test("destinations and overrides must be valid device paths", () => {
  const next = withDevice();
  assert.throws(() => config.setDestination(next, "odin", "roms", "C:\\ROMs"), /Choose a folder/);
  assert.throws(() => config.setOverride(next, "odin", "roms", "../x", "/sdcard/x"), /Invalid/);
});

test("Wi-Fi ADB settings: an app-paired device is kept, an ADB-only device is dropped and named", async (t) => {
  const dir = await tempDir(t);
  const old = config.emptyConfig();
  old.adbPath = "C:\adb.exe";
  old.awakeMode = "operations";
  const receiver = { id: "11111111-2222-3333-4444-555555555555", key: Buffer.alloc(32).toString("base64") };
  old.devices.push(
    { id: "odin", name: "Odin 2", transport: "adb", hardwareId: "abc", serial: "x:5555", gpu: "Adreno (TM) 740", receiver },
    { id: "tab", name: "Tablet", transport: "adb", hardwareId: "def" },
  );
  config.ensureProfiles(old);
  await fs.writeFile(path.join(dir, "config.json"), JSON.stringify(old));
  const { config: loaded, notice } = await config.loadConfig(dir);
  assert.deepEqual(loaded.devices.map((d) => [d.id, d.transport, d.serial, d.gpu]), [["odin", "receiver", undefined, "Adreno (TM) 740"]]);
  assert.deepEqual(loaded.profiles.map((p) => p.deviceId), ["odin"]);
  assert.equal(loaded.adbPath, undefined);
  assert.match(notice, /pair Tablet again/);
});
