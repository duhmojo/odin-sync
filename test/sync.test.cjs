const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const config = require("../config.cjs");
const plan = require("../plan.cjs");
const { runSync, Speedometer } = require("../transfer.cjs");
const { FakeDevice } = require("./fake-device.cjs");

async function tree(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "odin-sync-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, ...relative.split("/"));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  return root;
}

function setup(root, type = "roms") {
  let next = config.emptyConfig();
  next.devices.push({ id: "odin", name: "Odin", transport: "receiver", hardwareId: "x", receiver: { id: "11111111-2222-3333-4444-555555555555", key: Buffer.alloc(32).toString("base64") } });
  config.ensureProfiles(next);
  next = config.saveFolder(next, { id: "f", name: "Local", path: root, type }).config;
  return next;
}

test("targets keep structure under the destination; overrides set a subtree's own location", () => {
  const profile = {
    destinations: { f: "/sdcard/ROMs" },
    overrides: { f: { NDS: "/storage/ABCD-1234/nds", "NDS/Hacks": "/sdcard/Hacks" } },
  };
  assert.equal(plan.targetFor(profile, "f", "GBA/x.gba").target, "/sdcard/ROMs/GBA/x.gba");
  assert.equal(
    plan.targetFor(profile, "f", "NDS/Mario.nds").target,
    "/storage/ABCD-1234/nds/Mario.nds",
  );
  assert.equal(plan.targetFor(profile, "f", "NDS/Hacks/a.nds").target, "/sdcard/Hacks/a.nds");
  assert.equal(plan.targetFor(profile, "f", "NDSX/a.nds").target, "/sdcard/ROMs/NDSX/a.nds");
});

test("device listing is parsed robustly and must be complete", () => {
  const listing = `12|/sdcard/ROMs/a b|c.nds\r\nnoise\n0|/sdcard/ROMs/empty\n${plan.LISTING_END}\n`;
  const remote = plan.parseListing(listing);
  assert.equal(remote.get("/sdcard/roms/a b|c.nds"), 12);
  assert.equal(remote.get("/sdcard/roms/empty"), 0);
  assert.throws(() => plan.parseListing("12|/sdcard/x"), /incomplete/);
  assert.deepEqual(plan.minimalRoots(["/sdcard/ROMs/nds", "/sdcard/ROMs", "/sdcard/ROMsX"]), [
    "/sdcard/ROMs",
    "/sdcard/ROMsX",
  ]);
});

test("plan compares by size: Add, Unchanged, Different; blocked folders are reported", async (t) => {
  const root = await tree(t, { "nds/a.nds": "aaa", "nds/b.nds": "bb", "nds/c.nds": "c" });
  let next = setup(root);
  const blocked = await plan.resolvePlanFiles(
    {
      ...next,
      profiles: [
        {
          ...next.profiles[0],
          selections: { f: { folders: { "": true }, items: [], excluded: [] } },
        },
      ],
    },
    "odin",
  );
  assert.deepEqual(blocked.blocked, [{ folderId: "f", folder: "Local" }]);
  next = config.setDestination(next, "odin", "f", "/sdcard/ROMs");
  next = config.setFolderSelection(next, "odin", "f", "", true);
  const resolved = await plan.resolvePlanFiles(next, "odin");
  assert.deepEqual(resolved.roots, ["/sdcard/ROMs"]);
  const adb = new FakeDevice({
    "/sdcard/ROMs/nds/b.nds": Buffer.from("bb"),
    "/sdcard/ROMs/nds/c.nds": Buffer.from("XX"),
  });
  const entries = plan.compare(resolved.files, await plan.listRemote(adb, resolved.roots));
  assert.deepEqual(
    entries.map((e) => [e.relative, e.action]),
    [
      ["nds/a.nds", "Add"],
      ["nds/b.nds", "Unchanged"],
      ["nds/c.nds", "Different"],
    ],
  );
  const summary = plan.summarize(entries);
  assert.deepEqual(summary.Add, { count: 1, bytes: 3 });
  assert.deepEqual(adb.calls, ["listing"], "one request lists every destination");
});

test("sync copies Add files, verifies checksums, renames, and never deletes device files", async (t) => {
  const root = await tree(t, { "a.nds": "aaa", "b.nds": "bbbb", "c.nds": "cc" });
  const adb = new FakeDevice({
    "/sdcard/ROMs/c.nds": Buffer.from("zz9"),
    "/sdcard/ROMs/keep.txt": Buffer.from("k"),
  });
  const entries = [
    {
      relative: "a.nds",
      source: path.join(root, "a.nds"),
      size: 3,
      target: "/sdcard/ROMs/a.nds",
      action: "Add",
    },
    {
      relative: "b.nds",
      source: path.join(root, "b.nds"),
      size: 4,
      target: "/sdcard/ROMs/sub/b.nds",
      action: "Add",
    },
    {
      relative: "c.nds",
      source: path.join(root, "c.nds"),
      size: 2,
      target: "/sdcard/ROMs/c.nds",
      action: "Different",
    },
  ];
  const progress = [];
  const result = await runSync(entries, adb, { onProgress: (p) => progress.push(p) });
  assert.deepEqual(
    result.results.map((r) => [r.relative, r.status]),
    [
      ["c.nds", "skipped"],
      ["a.nds", "copied"],
      ["b.nds", "copied"],
    ],
  );
  assert.equal(adb.files.get("/sdcard/ROMs/a.nds").toString(), "aaa");
  assert.equal(
    adb.files.get("/sdcard/ROMs/c.nds").toString(),
    "zz9",
    "Different is not replaced by default",
  );
  assert.ok(adb.files.has("/sdcard/ROMs/keep.txt"));
  assert.deepEqual(adb.calls, ["mkdirs"], "folders created in one request");
  const last = progress.at(-1);
  assert.equal(last.doneBytes, 7);
  assert.equal(last.totalBytes, 7);
  assert.equal(last.fileCount, 2);
});

test("replace different files only when chosen; failed verification is reported and cleaned", async (t) => {
  const root = await tree(t, { "c.nds": "cc", "bad.nds": "bad" });
  const adb = new FakeDevice({ "/sdcard/ROMs/c.nds": Buffer.from("zz9") });
  adb.corrupt.add(path.join(root, "bad.nds"));
  const entries = [
    {
      relative: "c.nds",
      source: path.join(root, "c.nds"),
      size: 2,
      target: "/sdcard/ROMs/c.nds",
      action: "Different",
    },
    {
      relative: "bad.nds",
      source: path.join(root, "bad.nds"),
      size: 3,
      target: "/sdcard/ROMs/bad.nds",
      action: "Add",
    },
  ];
  const result = await runSync(entries, adb, { replaceDifferent: true });
  assert.equal(adb.files.get("/sdcard/ROMs/c.nds").toString(), "cc");
  const bad = result.results.find((r) => r.relative === "bad.nds");
  assert.equal(bad.status, "failed");
  assert.match(bad.reason, /checksum/);
  assert.ok(!adb.files.has("/sdcard/ROMs/bad.nds"));
});

test("stop skips the files after the current one; a vanished local file fails alone", async (t) => {
  const root = await tree(t, { "a.nds": "a", "b.nds": "b" });
  const adb = new FakeDevice();
  let stop = false;
  const entries = [
    {
      relative: "gone.nds",
      source: path.join(root, "gone.nds"),
      size: 1,
      target: "/sdcard/R/gone.nds",
      action: "Add",
    },
    {
      relative: "a.nds",
      source: path.join(root, "a.nds"),
      size: 1,
      target: "/sdcard/R/a.nds",
      action: "Add",
    },
    {
      relative: "b.nds",
      source: path.join(root, "b.nds"),
      size: 1,
      target: "/sdcard/R/b.nds",
      action: "Add",
    },
  ];
  const result = await runSync(entries, adb, {
    cancelled: () => stop,
    onProgress: (p) => {
      if (p.phase === "Copied") stop = true;
    },
  });
  assert.deepEqual(
    result.results.map((r) => r.status),
    ["failed", "copied", "skipped"],
  );
  assert.equal(result.stopped, true);
});

test("speed and time remaining come from recent samples", () => {
  let now = 0;
  const speed = new Speedometer(() => now);
  speed.add(0);
  now = 1000;
  speed.add(10);
  assert.equal(speed.bytesPerSecond(), 0, "no estimate from the first second");
  now = 4000;
  speed.add(8_000_000);
  assert.equal(speed.bytesPerSecond(), 2_000_000);
});

test("files that differ only by letter case go to one target; the second is skipped", async (t) => {
  const root = await tree(t, { "a/Game.nds": "1", "b/x.nds": "2" });
  let next = setup(root);
  next = config.setDestination(next, "odin", "f", "/sdcard/ROMs");
  next = config.setOverride(next, "odin", "f", "b", "/sdcard/ROMs/A");
  await fs.rename(path.join(root, "b", "x.nds"), path.join(root, "b", "GAME.nds"));
  next = config.setFolderSelection(next, "odin", "f", "", true);
  const resolved = await plan.resolvePlanFiles(next, "odin");
  assert.equal(resolved.files.length, 1);
  assert.match(resolved.warnings[0].message, /also goes to/);
});

test("a device lost mid-sync stops cleanly: nothing is marked failed and the rest waits", async (t) => {
  const root = await tree(t, { "a.nds": "a", "b.nds": "b", "c.nds": "c" });
  const entry = (name) => ({
    relative: name,
    source: path.join(root, name),
    size: 1,
    target: "/sdcard/R/" + name,
    action: "Add",
  });
  const adb = new FakeDevice();
  adb.dropAfterUploads = 2;
  const result = await runSync([entry("a.nds"), entry("b.nds"), entry("c.nds")], adb, {
  });
  assert.match(result.disconnected, /socket hang up|connection reset/);
  assert.deepEqual(
    result.results.map((r) => [r.relative, r.status]),
    [
      ["a.nds", "copied"],
      ["b.nds", "skipped"],
      ["c.nds", "skipped"],
    ],
  );
  assert.match(result.results[1].reason, /disconnected during this file/);
});

test("free space is read per volume and a sync that does not fit is flagged", () => {
  // As the app reports it: per root, with the volume it is on.
  const space = [
    { root: "/sdcard/ROMs", total: 100e9, available: 1000000 * 1024, mount: "/storage/emulated/0" },
    { root: "/storage/ABCD-1234/ROMs", total: 500e9, available: 400e9, mount: "/storage/ABCD-1234" },
  ];
  const big = 2 * 1024 * 1024 * 1024;
  const entries = [
    { action: "Add", size: big, root: "/sdcard/ROMs" },
    { action: "Remove", size: big, root: "/sdcard/ROMs" },
    { action: "Add", size: 5, root: "/storage/ABCD-1234/ROMs" },
  ];
  const keep = plan.spaceNeeds(entries, space, {});
  assert.equal(keep[0].short, true, "2 GB does not fit in 1 GB");
  assert.equal(keep[1].short, false);
  const removing = plan.spaceNeeds(entries, space, { remove: true });
  assert.equal(removing[0].short, false, "removals run first and free the space");
});

test("this app's leftover temporary files are found by exact name only", () => {
  const listing = [
    "10|/sdcard/ROMs/a.nds.odin-sync-0f8fad5b-d9cb-469f-a165-70867728950e.part",
    "10|/sdcard/ROMs/b.part",
    "10|/sdcard/ROMs/c.odin-sync-x.part",
    plan.LISTING_END,
  ].join("\n");
  const remote = plan.parseListing(listing);
  assert.deepEqual(
    remote.temps.map((t) => t.path),
    ["/sdcard/ROMs/a.nds.odin-sync-0f8fad5b-d9cb-469f-a165-70867728950e.part"],
  );
  assert.equal(remote.size, 2);
});

test("a file this app copied that is gone from the device is marked to be restored; a new one is not", () => {
  const files = [
    { target: "/sdcard/Games/Game1/game.exe", size: 3 },
    { target: "/sdcard/Games/Game2/run.bat", size: 3 },
    { target: "/sdcard/Games/Game3/x.exe", size: 3 },
  ];
  const remote = new Map([["/sdcard/games/game3/x.exe", 3]]);
  const copied = new Set(["/sdcard/Games/Game1/game.exe", "/sdcard/Games/Game3/x.exe"]);
  const entries = plan.compare(files, remote, (target) => (copied.has(target) ? { size: 3 } : null));
  assert.deepEqual(
    entries.map((e) => [e.action, !!e.restore]),
    [
      ["Add", true],
      ["Add", false],
      ["Unchanged", false],
    ],
  );
});
