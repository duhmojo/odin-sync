// End-to-end test: launches the real Electron app with a temporary data folder
// and a fake Odin Sync app (fake-receiver.cjs) whose storage is a temporary
// folder, and drives the UI. Run with `npm run test:e2e`.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");
const { createFakeReceiver } = require("./fake-receiver.cjs");

const REPO = path.join(__dirname, "..");
const ELECTRON = require("electron");

// Temporary folders are removed after the app has closed (Windows keeps its
// data folder locked while it runs).
function tempDir(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `odin-e2e-${name}-`));
  (t.cleanup ||= []).push(dir);
  return dir;
}

async function cleanUp(t) {
  await t.app?.close().catch(() => {});
  await t.receiver?.stop().catch(() => {});
  for (const dir of t.cleanup || []) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

function write(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

// Starts a fake Odin Sync app on deviceRoot (its /sdcard is
// deviceRoot/storage/emulated/0) and the real app pointed at it.
const PIN = "246810";

async function launch(t, dataDir, deviceRoot, extraEnv = {}, setPin = true) {
  const webPort = 20000 + Math.floor(Math.random() * 20000);
  const receiver = createFakeReceiver({ root: deviceRoot });
  const ports = await receiver.start();
  t.receiver = receiver;
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [REPO],
    env: {
      ...process.env,
      ODIN_SYNC_DATA_DIR: dataDir,
      ODIN_SYNC_RECEIVER_TARGETS: "127.0.0.1",
      ODIN_SYNC_RECEIVER_UDP: String(ports.discoveryPort),
      ODIN_SYNC_APP_UDP: String(20000 + Math.floor(Math.random() * 20000)),
      ODIN_SYNC_WEB_HOST: "127.0.0.1",
      ODIN_SYNC_WEB_PORT: String(webPort),
      ODIN_SYNC_NO_TRAY: "1",
      ...extraEnv,
    },
  });
  t.app = app;
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(() => document.getElementById("status").textContent !== "Ready.");
  if (setPin) await answerPin(page);
  return { app, page, errors, receiver, webPort };
}

// Without a PIN the app asks for one before anything else.
async function answerPin(page) {
  await page.waitForSelector("#pin-dialog[open]");
  await page.fill("#pin-new", PIN);
  await page.fill("#pin-again", PIN);
  await page.click("#pin-save");
  await page.waitForFunction(() => !document.getElementById("pin-dialog").open);
}

const statusText = (page) => page.textContent("#status");
const nav = (page, view) => page.click(`nav button[data-view="${view}"]`);
const idle = (page) =>
  page.waitForFunction(() => document.getElementById("busy-indicator").hidden, null, {
    timeout: 30000,
  });

async function addFolder(page, name, dir, type) {
  await nav(page, "folders");
  await page.click("#add-folder");
  await page.fill("#folder-name", name);
  await page.selectOption("#folder-type", type);
  await page.evaluate((p) => (document.getElementById("folder-path").value = p), dir);
  await page.click("#folder-form button[type=submit]");
  await idle(page);
  assert.equal(await statusText(page), "Folder saved.");
}

// The fake app pairs itself with the PC's PIN, as the person does in the app.
async function addDevice(page, receiver) {
  await nav(page, "devices");
  const webPort = await page.evaluate(() => state.web.port);
  await receiver.pairWith("127.0.0.1", webPort, PIN);
  await page.waitForSelector("#receiver-paired:not([hidden])");
  assert.match(await page.textContent("#receiver-paired"), /is paired/);
  await idle(page);
}

async function checkDevice(page) {
  await nav(page, "sync");
  await page.click("#sync-check");
  await page.waitForFunction(() => !document.getElementById("sync-plan").hidden, null, {
    timeout: 30000,
  });
  return page.$$eval(".stats.four strong", (tiles) => tiles.map((t) => Number(t.textContent)));
}

async function startSync(page) {
  await page.click("#sync-start");
  if (await page.$("#confirm-dialog[open]")) await page.click("#confirm-ok");
  await page
    .waitForFunction(() => !document.getElementById("sync-results").hidden, null, {
      timeout: 60000,
    })
    .catch(async (error) => {
      throw new Error(`${error.message} Status: ${await statusText(page)}`);
    });
}

test("add folders and a device, choose content, sync, remove, reload, reset", async (t) => {
  t.after(() => cleanUp(t));
  const pc = tempDir(t, "pc");
  const device = tempDir(t, "device");
  const data = tempDir(t, "data");
  write(pc, {
    "ROMs/psx/Game.cue": 'FILE "Game (Track 1).bin" BINARY\n',
    "ROMs/psx/Game (Track 1).bin": "track",
    "ROMs/psx/Multi.m3u": "Multi (Disc 1).chd\nMulti (Disc 2).chd\n",
    "ROMs/psx/Multi (Disc 1).chd": "d1",
    "ROMs/psx/Multi (Disc 2).chd": "d2",
    "ROMs/psx/.DS_Store": "junk",
    "ROMs/media/cover.png": "png",
    "Games/Game1/game.exe": "exe",
    "Games/Game1/data/save.db": "db",
    "Games/Game2/run.bat": "bat",
    "Music/Album/01.mp3": "mp3",
  });
  write(device, { "storage/emulated/0/ROMs/psx/mine.chd": "not copied by the app" });
  const { page, errors, receiver } = await launch(t, data, device);

  await addFolder(page, "ROMs", path.join(pc, "ROMs"), "roms");
  await addFolder(page, "PC Games", path.join(pc, "Games"), "games");
  await addFolder(page, "Music", path.join(pc, "Music"), "music");
  await addDevice(page, receiver);

  // Gap flag until destinations are set.
  await nav(page, "library");
  assert.match(await page.textContent("#library-gaps"), /without a place on Fake Odin/);
  await nav(page, "profiles");
  const destinations = ["/sdcard/ROMs", "/sdcard/Games", "/sdcard/Music"];
  for (const [index, target] of destinations.entries()) {
    const input = (await page.$$(".profile-table input"))[index];
    await input.fill(target);
    await input.press("Tab");
    await idle(page);
  }
  assert.equal(await page.$(".profile-card .notice.warning"), null);

  // Library: ROMs folder (media hidden by default), select psx and Game1.
  await nav(page, "library");
  await page.click("#library-folders .folder-button:nth-child(1)");
  await idle(page);
  assert.deepEqual(
    await page.$$eval("#library-rows .link-button", (b) => b.map((x) => x.textContent)),
    ["▸ psx"],
  );
  await page.check('#library-rows input[aria-label="Sync folder psx"]');
  await idle(page);
  await page.click("#library-folders .folder-button:nth-child(2)");
  await idle(page);
  await page.check('#library-rows input[aria-label="Sync Game1"]');
  await idle(page);
  assert.match(await page.textContent("#library-rows"), /Will add/);

  // Check and sync.
  let tiles = await checkDevice(page);
  assert.deepEqual(tiles, [7, 0, 0, 0], "5 ROM files and 2 game files to copy");
  const reviewRows = await page.$$eval("#sync-rows tr", (rows) => rows.map((r) => r.innerText));
  assert.ok(
    reviewRows.some((r) => r.startsWith("Game1")),
    "the game is one review row",
  );
  assert.ok(
    reviewRows.some((r) => r.includes("/sdcard/ROMs/psx")),
    "ROM files grouped by folder",
  );
  assert.match(await page.textContent("#sync-space"), /free of/);
  await startSync(page);
  assert.match(await page.textContent("#sync-results"), /Sync finished/);
  const internal = path.join(device, "storage", "emulated", "0");
  assert.equal(fs.readFileSync(path.join(internal, "Games/Game1/data/save.db"), "utf8"), "db");
  assert.ok(fs.existsSync(path.join(internal, "ROMs/psx/Multi (Disc 2).chd")));
  assert.ok(!fs.existsSync(path.join(internal, "ROMs/psx/.DS_Store")));
  await page.click("#sync-results button >> text=Clear");
  assert.equal(await page.isHidden("#sync-results"), true);

  // Unselect the game: it is offered for removal, and removal is confirmed in a modal.
  await nav(page, "library");
  await page.click("#library-folders .folder-button:nth-child(2)");
  await idle(page);
  await page.uncheck('#library-rows input[aria-label="Sync Game1"]');
  await idle(page);
  assert.match(await page.textContent("#library-rows"), /Will remove/);
  tiles = await checkDevice(page);
  assert.deepEqual(tiles, [0, 2, 0, 5]);
  await page.check("#sync-remove");
  await page.click("#sync-start");
  await page.waitForSelector("#confirm-dialog[open]");
  assert.match(await page.textContent("#confirm-title"), /Remove 2 files/);
  await page.click("#confirm-ok");
  await page.waitForFunction(() => !document.getElementById("sync-results").hidden);
  assert.ok(!fs.existsSync(path.join(internal, "Games/Game1")), "game folder removed");
  assert.ok(fs.existsSync(path.join(internal, "ROMs/psx/mine.chd")), "other files stay");
  await page.click("#sync-results button >> text=Clear");

  // Reload picks up a file renamed on the PC.
  await nav(page, "library");
  await page.click("#library-folders .folder-button:nth-child(1)");
  await page.click("#library-rows .link-button >> text=psx");
  await idle(page);
  fs.renameSync(path.join(pc, "ROMs/psx/Multi.m3u"), path.join(pc, "ROMs/psx/Multi2.m3u"));
  await page.click("#library-refresh");
  await idle(page);
  assert.match(await page.textContent("#library-rows"), /Multi2\.m3u/);

  // Device storage browser: files are listed; unticking Show files hides them.
  await nav(page, "devices");
  await page.click("#refresh-status");
  await idle(page);
  await page.click("#saved-devices summary >> text=Browse device storage");
  await idle(page);
  await page.click("#saved-devices .storage-volumes button >> text=Internal storage");
  await idle(page);
  await page.click("#saved-devices .link-button >> text=ROMs");
  await idle(page);
  await page.click("#saved-devices .link-button >> text=psx");
  await idle(page);
  assert.match(await page.textContent("#saved-devices .storage-table-wrap"), /mine\.chd/);
  await page.uncheck("#saved-devices .storage-tools input[type=checkbox]");
  await idle(page);
  assert.match(await page.textContent("#saved-devices .storage-tools"), /files? not shown/);

  // Remove device: cancel keeps it.
  await page.click("#saved-devices button >> text=Remove device");
  await page.waitForSelector("#confirm-dialog[open]");
  await page.keyboard.press("Escape");
  assert.equal((await page.$$("#saved-devices .device-card")).length, 1);

  // Reset settings.
  await nav(page, "settings");
  await page.click("#reset-settings");
  await page.waitForSelector("#confirm-dialog[open]");
  await page.click("#confirm-ok");
  await idle(page);
  assert.match(await statusText(page), /All settings were cleared/);
  // The PIN was cleared too: it is asked for again.
  await answerPin(page);
  await nav(page, "folders");
  assert.equal(await page.isHidden("#folders-empty"), false);
  assert.deepEqual(errors, []);
});

test("after the fresh-start notice, adding a device still works", async (t) => {
  t.after(() => cleanUp(t));
  const device = tempDir(t, "device");
  const data = tempDir(t, "data");
  fs.writeFileSync(path.join(data, "config.json"), JSON.stringify({ version: 2, sources: [] }));
  const { page, errors, receiver } = await launch(t, data, device, {}, false);
  assert.match(await statusText(page), /new settings format/);
  await answerPin(page);
  await addDevice(page, receiver);
  assert.equal((await page.$$("#saved-devices .device-card")).length, 1);
  assert.deepEqual(errors, []);
});

test("a device lost mid-sync shows Device disconnected, and Resume finishes the sync", async (t) => {
  t.after(() => cleanUp(t));
  const pc = tempDir(t, "pc");
  const device = tempDir(t, "device");
  const data = tempDir(t, "data");
  write(pc, { "Music/a.mp3": "a", "Music/b.mp3": "b", "Music/c.mp3": "c" });
  const { page, errors, receiver } = await launch(t, data, device);
  await addFolder(page, "Music", path.join(pc, "Music"), "music");
  await addDevice(page, receiver);
  await nav(page, "profiles");
  const input = (await page.$$(".profile-table input"))[0];
  await input.fill("/sdcard/Music");
  await input.press("Tab");
  await idle(page);
  await nav(page, "library");
  await page.click("#library-folders .folder-button:nth-child(1)");
  await idle(page);
  await page.check("#library-location input[type=checkbox]");
  await idle(page);
  assert.deepEqual(await checkDevice(page), [3, 0, 0, 0]);
  // The connection drops at the second file and the app is gone for now.
  receiver.state.dropAfter = receiver.state.uploads + 2;
  await startSync(page);
  const results = await page.textContent("#sync-results");
  assert.match(results, /Device disconnected/);
  assert.match(results, /1 of 3 changes done/);
  assert.doesNotMatch(results, /Failed \(/, "nothing is reported as a failed file");
  // The device comes back; Resume checks again and copies what is left.
  receiver.state.dropAfter = Infinity;
  receiver.state.offline = false;
  await page.click("#sync-results button >> text=Resume sync");
  await page.waitForFunction(
    () => /Sync finished/.test(document.getElementById("sync-results").textContent),
    null,
    { timeout: 60000 },
  );
  const music = path.join(device, "storage", "emulated", "0", "Music");
  assert.deepEqual(fs.readdirSync(music).sort(), ["a.mp3", "b.mp3", "c.mp3"]);
  assert.deepEqual(errors, []);
});

test("web access: log in from a browser, the desktop is paused, and can take back control", async (t) => {
  t.after(() => cleanUp(t));
  const pc = tempDir(t, "pc");
  const device = tempDir(t, "device");
  const data = tempDir(t, "data");
  write(pc, { "Music/a.mp3": "a" });
  const { app, page, errors, receiver, webPort: port } = await launch(t, data, device);
  await addFolder(page, "Music", path.join(pc, "Music"), "music");
  await addDevice(page, receiver);

  // The server runs; Settings shows its address. Only a hash of the PIN is stored.
  await nav(page, "settings");
  assert.match(await page.textContent("#web-status"), /Running/);
  const config = JSON.parse(fs.readFileSync(path.join(data, "config.json"), "utf8"));
  assert.ok(!JSON.stringify(config).includes(PIN), "only a hash is stored");

  // A browser window (no preload: it uses the web bridge) logs in.
  await app.evaluate(({ BrowserWindow }, url) => {
    const browser = new BrowserWindow({ show: false, width: 800, height: 900 });
    browser.loadURL(url);
  }, `http://127.0.0.1:${port}/`);
  const browser = await app.waitForEvent("window", (w) => w.url().includes("/login"));
  await browser.fill("input[name=password]", PIN);
  await browser.click("button[type=submit]");
  const browserErrors = [];
  browser.on("pageerror", (e) => browserErrors.push(e.message));
  await browser.waitForSelector("#library");
  await browser.waitForFunction(() =>
    document.getElementById("library-folders").textContent.includes("Music"),
  );
  await browser.waitForFunction(() => document.getElementById("status").textContent !== "Ready.");
  assert.equal(await browser.evaluate(() => window.odin.mode), "web");
  assert.equal(await browser.isHidden("#library-reveal"), true, "PC-only actions are hidden");
  assert.match(await browser.textContent("#library-folders"), /Music/);

  // The desktop is paused, and its calls are refused by the main process too.
  await page.waitForSelector("#control-overlay:not([hidden])");
  assert.match(await page.textContent("#control-text"), /127\.0\.0\.1/);
  const refused = await page.evaluate(() =>
    window.odin.invoke("folder:remove", "x").then(
      () => "allowed",
      (e) => e.message,
    ),
  );
  assert.match(refused, /controlled from the web/);

  // The browser can check the device.
  await browser.click('nav button[data-view="profiles"]');
  const input = await browser.$(".profile-table input");
  await input.fill("/sdcard/Music");
  await input.press("Tab");
  await browser.waitForFunction(
    () => document.getElementById("status").textContent === "Destination saved.",
  );
  await browser.click('nav button[data-view="library"]');
  await browser.click("#library-folders .folder-button:nth-child(1)");
  await browser.check("#library-location input[type=checkbox]");
  await browser.waitForFunction(() => document.getElementById("busy-indicator").hidden);
  await browser.click('nav button[data-view="sync"]');
  await browser.click("#sync-check");
  await browser.waitForFunction(() => !document.getElementById("sync-plan").hidden, null, {
    timeout: 30000,
  });
  assert.equal(await browser.textContent("#count-copy"), "1");

  // Take back control: the browser is told, and the desktop works again.
  await page.click("#control-action");
  await page.waitForSelector("#control-overlay", { state: "hidden" });
  await browser.waitForSelector("#control-overlay:not([hidden])");
  assert.match(await browser.textContent("#control-text"), /the PC took back control/);
  const after = await browser.evaluate(() =>
    window.odin.invoke("config:get").then(
      () => "allowed",
      (e) => e.message,
    ),
  );
  assert.match(after, /logged out/);
  await nav(page, "library");
  assert.match(await page.textContent("#library-folders"), /Music/);
  assert.deepEqual(errors, []);
  assert.deepEqual(browserErrors, []);
});

test("receiver app: install page, PIN pairing, sync through the app, closed app, reconnect", async (t) => {
  t.after(() => cleanUp(t));
  const pc = tempDir(t, "pc");
  const phone = tempDir(t, "phone");
  const data = tempDir(t, "data");
  write(pc, { "Music/Album/01.mp3": "song one", "Music/Album/02.mp3": "song two" });
  const launched = await launch(t, data, phone);
  const { page, errors } = launched;
  let receiver = launched.receiver;
  const ports = receiver.ports;
  await addFolder(page, "Music", path.join(pc, "Music"), "music");

  // The install page is always served, and linked from Devices.
  await nav(page, "devices");
  const port = launched.webPort;
  if (await page.$("#receiver-urls a")) {
    const html = await (await fetch(`http://127.0.0.1:${port}/receiver`)).text();
    assert.match(html, /Odin Sync app/);
  }

  // The app pairs with the PC's PIN; a wrong one is refused.
  await assert.rejects(receiver.pairWith("127.0.0.1", port, "000000"), /Wrong PIN/);
  await addDevice(page, receiver);
  assert.match(await page.textContent("#saved-devices"), /Fake Odin/);
  assert.match(await page.textContent("#saved-devices"), /Online/);

  // Sync through the app.
  await nav(page, "profiles");
  const input = (await page.$$(".profile-table input"))[0];
  await input.fill("/sdcard/OdinSyncTest/Music");
  await input.press("Tab");
  await idle(page);
  await nav(page, "library");
  await page.click("#library-folders .folder-button:nth-child(1)");
  await idle(page);
  await page.check("#library-location input[type=checkbox]");
  await idle(page);
  assert.deepEqual(await checkDevice(page), [2, 0, 0, 0]);
  await startSync(page);
  assert.match(await page.textContent("#sync-results"), /Sync finished/);
  const internal = path.join(phone, "storage", "emulated", "0", "OdinSyncTest", "Music");
  assert.equal(fs.readFileSync(path.join(internal, "Album", "02.mp3"), "utf8"), "song two");
  assert.equal(receiver.state.session, null, "the app was told the sync ended");
  assert.deepEqual(await checkDevice(page), [0, 0, 0, 2], "both files are now unchanged");

  // Closing the app makes the device unreachable; reopening it reconnects.
  const { id, paired } = receiver;
  await receiver.stop();
  await nav(page, "devices");
  await page.click("#refresh-status");
  await idle(page);
  assert.match(await page.textContent("#saved-devices"), /Open the Odin Sync app/);
  receiver = createFakeReceiver({ root: phone, id, paired, httpPort: ports.httpPort, discoveryPort: ports.discoveryPort });
  t.receiver = receiver;
  await receiver.start();
  await page.waitForFunction(
    () => /Online/.test(document.getElementById("saved-devices").textContent),
    null,
    { timeout: 30000 },
  );
  assert.deepEqual(errors, []);
});
