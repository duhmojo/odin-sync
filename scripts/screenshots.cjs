// npm run screenshots: drives the real app with a sample library and a
// simulated device (test-e2e/fake-receiver.cjs) and saves the screenshots
// used by the README and the website into docs/screenshots/. Nothing on this
// PC's real settings or any real device is touched.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");
const { createFakeReceiver } = require("../test-e2e/fake-receiver.cjs");

const REPO = path.join(__dirname, "..");
const OUT = path.join(REPO, "docs", "screenshots");
const PIN = "246810";

function write(root, files) {
  for (const [relative, size] of Object.entries(files)) {
    const file = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(size, 1));
  }
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "odin-shots-"));
  const pc = path.join(temp, "pc");
  const phone = path.join(temp, "phone");
  const MB = 1024 * 1024;
  write(pc, {
    "ROMs/psx/Crash Bandicoot (USA).chd": 3 * MB,
    "ROMs/psx/Spyro the Dragon (USA).chd": 3 * MB,
    "ROMs/psx/Final Fantasy VII (USA) (Disc 1).chd": 3 * MB,
    "ROMs/psx/Final Fantasy VII (USA) (Disc 2).chd": 3 * MB,
    "ROMs/psx/Final Fantasy VII (USA).m3u": 100,
    "ROMs/snes/Super Metroid (USA).sfc": 3 * MB,
    "ROMs/snes/Chrono Trigger (USA).sfc": 4 * MB,
    "ROMs/snes/EarthBound (USA).sfc": 3 * MB,
    "ROMs/gba/Metroid Fusion (USA).gba": 8 * MB,
    "ROMs/gba/Pokemon Emerald (USA).gba": 16 * MB,
    "ROMs/nds/Mario Kart DS (USA).nds": 32 * MB,
    "ROMs/ps2/Shadow of the Colossus (USA).chd": 6 * MB,
    "Games/Hollow Knight/hollow_knight.exe": 2 * MB,
    "Games/Celeste/Celeste.exe": 2 * MB,
    "Games/Stardew Valley/Stardew Valley.exe": 2 * MB,
    "Music/Lofi Beats/01 Rainy Day.mp3": 4 * MB,
    "Music/Lofi Beats/02 Night Drive.mp3": 4 * MB,
  });
  write(phone, {
    "storage/emulated/0/ROMs/snes/Super Metroid (USA).sfc": 3 * MB,
    "storage/emulated/0/ROMs/snes/Chrono Trigger (USA).sfc": 4 * MB,
    "storage/emulated/0/Download/ES-DE.apk": 2 * MB,
  });
  const receiver = createFakeReceiver({ root: phone, name: "AYN Odin 2 Portal" });
  const ports = await receiver.start();
  const app = await electron.launch({
    executablePath: require("electron"),
    args: [REPO],
    env: {
      ...process.env,
      ODIN_SYNC_DATA_DIR: path.join(temp, "data"),
      ODIN_SYNC_WEB_HOST: "127.0.0.1",
      ODIN_SYNC_WEB_PORT: "23456",
      ODIN_SYNC_APP_UDP: "23457",
      ODIN_SYNC_NO_TRAY: "1",
      ODIN_SYNC_RECEIVER_TARGETS: "127.0.0.1",
      ODIN_SYNC_RECEIVER_UDP: String(ports.discoveryPort),
    },
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
    const pause = (ms) => page.waitForTimeout(ms);
    const shot = async (name) => {
      await pause(400);
      await page.screenshot({ path: path.join(OUT, name + ".png") });
      console.log("  " + name);
    };
    const invoke = (channel, ...args) => page.evaluate(([c, a]) => window.odin.invoke(c, ...a), [channel, args]);
    const nav = (view) => page.click(`nav button[data-view="${view}"]`);
    fs.mkdirSync(OUT, { recursive: true });

    await page.waitForSelector("#pin-dialog[open]");
    await shot("welcome");
    await page.fill("#pin-new", PIN);
    await page.fill("#pin-again", PIN);
    await page.click("#pin-save");
    await pause(500);

    const folders = {};
    for (const [name, type] of [["ROMs", "roms"], ["PC Games", "games"], ["Music", "music"]]) {
      const result = await invoke("folder:save", { name, type, path: path.join(pc, name === "PC Games" ? "Games" : name) });
      folders[type] = result.folderId;
    }
    await receiver.pairWith("127.0.0.1", 23456, PIN);
    await pause(800);
    const snapshot = await invoke("config:get");
    const deviceId = snapshot.config.devices[0].id;
    await invoke("profile:destination", deviceId, folders.roms, "/sdcard/ROMs");
    await invoke("profile:destination", deviceId, folders.games, "/sdcard/Games");
    await invoke("profile:destination", deviceId, folders.music, "/sdcard/Music");
    for (const system of ["psx", "snes", "gba"]) await invoke("profile:selectFolder", deviceId, folders.roms, system, true);
    await invoke("profile:selectItems", deviceId, folders.games, [{ id: "Hollow Knight", folder: "" }, { id: "Celeste", folder: "" }], true);
    await page.evaluate(async () => applySnapshot(await window.odin.invoke("config:get")));

    // Library: a ROM system with games selected.
    await nav("library");
    await page.click("#library-folders .folder-button:nth-child(1)");
    await pause(600);
    await page.click("#library-rows .link-button >> text=psx");
    await pause(600);
    await page.click("#library-compare");
    await page.waitForSelector("#library-compared:not([hidden])", { timeout: 20000 });
    await shot("library");

    // Sync review, then a sync in progress (paced so it can be caught).
    await nav("sync");
    await page.click("#sync-check");
    await page.waitForSelector("#sync-plan:not([hidden])", { timeout: 30000 });
    await shot("sync-review");
    await invoke("device:lowImpact", deviceId, true, 4);
    await page.click("#sync-check");
    await page.waitForSelector("#sync-plan:not([hidden])", { timeout: 30000 });
    await page.click("#sync-start");
    if (await page.$("#confirm-dialog[open]")) await page.click("#confirm-ok");
    await pause(4500);
    await shot("sync-progress");
    await page.waitForSelector("#sync-results:not([hidden])", { timeout: 120000 });
    await invoke("device:lowImpact", deviceId, false, 4);

    // Devices with the storage browser open.
    await nav("devices");
    await page.click("#refresh-status");
    await pause(4000);
    await page.click("#saved-devices summary >> text=Browse device storage");
    await page.click("#saved-devices .storage-table-wrap .link-button >> text=Internal storage", { timeout: 15000 });
    await page.click("#saved-devices .storage-table-wrap .link-button >> text=ROMs", { timeout: 15000 });
    await page.waitForFunction(() => !/…/.test(document.querySelector("#saved-devices .storage-table-wrap").textContent), null, { timeout: 15000 });
    await shot("devices");
  } finally {
    await app.close();
    await receiver.stop();
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
