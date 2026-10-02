const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, Tray, Menu } = require("electron");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { destination } = require("./core.cjs");
const settings = require("./config.cjs");
const catalog = require("./catalog.cjs");
const plan = require("./plan.cjs");
const { runSync, TEMP_NAME } = require("./transfer.cjs");
const inventory = require("./inventory.cjs");
const {
  Sessions,
  OperationLock,
  RateLimiter,
  hashPin,
  verifyPassword,
} = require("./web-session.cjs");
const { createWebServer, lanUrls } = require("./web-server.cjs");
const receiverClient = require("./receiver-client.cjs");
const desktopLink = require("./desktop-link.cjs");
const { ZipStream } = require("./zip-stream.cjs");
const media = require("./scraping/media.cjs");
const { scrapeItems } = require("./scraping/jobs.cjs");
const steam = require("./scraping/steam.cjs");
const gamenative = require("./scraping/gamenative.cjs");
const screenscraper = require("./scraping/screenscraper.cjs");
const esde = require("./esde.cjs");
const { SYSTEMS } = require("./scraping/systems.cjs");

// ODIN_SYNC_DATA_DIR points the app at another data folder (used for testing).
// Settings live in the per-user app data folder (%APPDATA%\Odin Sync on
// Windows), for the installed app and a checkout alike, so both use the same
// settings and pairings. ODIN_SYNC_DATA_DIR points elsewhere (tests).
const product = require("./product.json");
const dataDir = process.env.ODIN_SYNC_DATA_DIR || path.join(app.getPath("appData"), product.name);
app.setPath("userData", dataDir);

const RECONNECT_FIRST_MS = 5000;
const RECONNECT_MAX_MS = 60000;

let win;
let config = settings.emptyConfig();
let notice = "";
const listings = new Map();
let checked = null;
let job = null;

const dataPath = (name) => path.join(dataDir, name);

function send(channel, value) {
  if (channel === "sync:progress") trayProgress(value);
  if (web && channel === "storage:progress") web.broadcast("storage", value);
  if (win && !win.isDestroyed()) win.webContents.send(channel, value);
  if (web && channel === "sync:progress") web.broadcast("progress", value);
  if (web && channel === "scrape:progress") web.broadcast("scrape", value);
  if (web && channel === "device:state") web.broadcast("device", value);
}

// The config as the UI sees it: never the password hash.
function publicConfig() {
  const { password, ...webSettings } = config.web || settings.emptyWeb();
  const { ssPassword, ssDevPassword, ...scraping } = config.scraping || {};
  return {
    ...config,
    web: { ...webSettings, hasPassword: !!password },
    scraping: { ...scraping, hasPassword: !!ssPassword, hasDevPassword: !!ssDevPassword },
  };
}

// The web server port (ODIN_SYNC_WEB_PORT overrides it for tests).
function webPort() {
  return Number(process.env.ODIN_SYNC_WEB_PORT) || config.web?.port || 8765;
}

function webStatus() {
  const port = webPort();
  const running = !!web?.running();
  return {
    running,
    error: webError,
    port,
    urls: running ? lanUrls(port) : [],
    // Browsers and the Odin Sync app need a PIN; the app asks for one at start.
    hasPin: !!config.web?.password,
    installer: {
      built: fsSync.existsSync(RECEIVER_APK),
      app: bundledApp(),
      urls: running ? lanUrls(port).map((url) => url.replace(/\/$/, "") + "/receiver") : [],
    },
  };
}

function snapshot() {
  const gaps = {};
  for (const device of config.devices) gaps[device.id] = settings.gaps(config, device.id);
  return {
    config: publicConfig(),
    web: webStatus(),
    startup: startup(),
    session: sessions.status(),
    notice,
    dataDir,
    gaps,
    types: settings.TYPES,
    sync: job ? { deviceId: job.deviceId, running: true } : null,
  };
}

async function persist(next) {
  settings.ensureProfiles(next);
  await settings.saveConfig(dataDir, next);
  config = next;
  return snapshot();
}

// Config changes run one at a time: each change receives the latest config and
// returns a new one, so quick successive clicks never overwrite each other.
let updates = Promise.resolve();
function update(change) {
  const result = updates.then(async () => persist(await change(config)));
  updates = result.catch(() => {});
  return result;
}

// What a sync plan depends on. Saving a new device address does not change it.
function planKey(deviceId) {
  const profile = config.profiles.find((p) => p.deviceId === deviceId);
  return JSON.stringify([config.folders, config.typeFilters, profile]);
}

function forgetListings(folderId) {
  for (const key of listings.keys()) {
    if (!folderId || key.startsWith(folderId + "\n")) listings.delete(key);
  }
}

function requireIdle(action) {
  if (job) throw new Error(`Wait for the sync to finish before you ${action}.`);
}

// Pairing, connecting and discovery share the ADB server and the mDNS port,
// so they run one at a time: each waits for the previous one instead of failing.
// Syncing and storage browsing are not blocked.
let deviceQueue = Promise.resolve();
function deviceTask(fn) {
  const result = deviceQueue.then(fn);
  deviceQueue = result.catch(() => {});
  return result;
}

// ---- One channel registry for the desktop window (IPC) and web access (HTTP) ----

const handlers = new Map();

function handle(name, fn) {
  handlers.set(name, fn);
}

// Channels that only read; anyone signed in may call them at any time.
const READ_ONLY = new Set([
  "config:get",
  "library:list",
  "library:gameSizes",
  "inventory:status",
  "storage:browse",
  "storage:size",
  "device:status",
  "session:status",
  "media:thumbs",
  "media:details",
  "gamenative:configs",
  "steam:search",
  "steam:resolve",
  "scrape:systems",
]);
// Native pickers, Explorer and the web settings themselves exist only on the PC.
const PC_ONLY = new Set([
  // A browser cannot browse this PC's folders: local folders change only here.
  "folder:save",
  "folder:remove",
  "filters:save",
  "scraping:configure",
  "pick:folder",
  "storage:pickFiles",
  "storage:upload",
  "storage:download",
  "library:reveal",
  "web:configure",
  "web:restart",
  "app:startup",
  "session:takeBack",
]);
// Destructive or long operations: one at a time across the PC and the web.
const LOCKED = {
  "sync:check": "a device check",
  "sync:start": "a sync",
  "sync:cleanTemps": "removing temporary files",
  "storage:mkdir": "creating a folder on the device",
  "storage:upload": "uploading to the device",
  "storage:download": "downloading from the device",
  "storage:delete": "deleting on the device",
  "settings:reset": "resetting settings",
  "gamenative:save": "saving a GameNative config",
  "device:remove": "removing a device",
  "device:merge": "adding a device",
  "folder:save": "saving a local folder",
  "folder:remove": "removing a local folder",
  "filters:save": "saving filters",
};

const sessions = new Sessions();
const operations = new OperationLock();
const limiter = new RateLimiter();
let web = null;
let webError = "";
// The receiver APK bundled with the app, offered at http://<pc>:<port>/receiver.
const RECEIVER_APK = path.join(__dirname, "receiver", "odin-sync-receiver.apk");

// Every call, from either side, goes through here.
async function dispatch(source, token, name, args) {
  const fn = handlers.get(name);
  if (!fn) throw new Error("Unsupported operation");
  if (source === "web" && PC_ONLY.has(name)) throw new Error("Do this on the PC.");
  // Taking control back is the desktop's override and always allowed.
  if (!READ_ONLY.has(name) && name !== "session:takeBack" && !sessions.allowed(source, token)) {
    if (source === "app") {
      const since = new Date(sessions.web.since).toLocaleTimeString();
      throw new Error(`Odin Sync is controlled from the web by ${sessions.web.ip} since ${since}.`);
    }
    throw new Error("You are logged out.");
  }
  if (LOCKED[name]) return operations.run(LOCKED[name], source, () => fn(...args));
  return fn(...args);
}

// ---- Tray and start with the system ----

let tray = null;
let quitting = false;
let trayHintShown = false;
app.on("before-quit", () => {
  quitting = true;
});

function showWindow() {
  if (!win || win.isDestroyed()) return;
  win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
}

// Only an installed app can start with the system (a checkout would start
// Electron without this app).
// Linux has no login items: an autostart entry does the same.
const AUTOSTART = path.join(os.homedir(), ".config", "autostart", `${product.id}.desktop`);

function startup() {
  if (!app.isPackaged) return { supported: false, enabled: false };
  if (process.platform === "linux") return { supported: true, enabled: fsSync.existsSync(AUTOSTART) };
  return { supported: true, enabled: app.getLoginItemSettings().openAtLogin };
}

function setStartup(enabled) {
  if (!app.isPackaged) throw new Error("Starting with the system works in the installed app.");
  if (process.platform === "linux") {
    if (enabled) {
      // An AppImage runs from APPIMAGE; a .deb install from its own path.
      const exe = process.env.APPIMAGE || process.execPath;
      fsSync.mkdirSync(path.dirname(AUTOSTART), { recursive: true });
      fsSync.writeFileSync(
        AUTOSTART,
        `[Desktop Entry]\nType=Application\nName=${product.name}\nExec="${exe}" --hidden\nX-GNOME-Autostart-enabled=true\n`,
      );
    } else fsSync.rmSync(AUTOSTART, { force: true });
  } else {
    app.setLoginItemSettings({ openAtLogin: !!enabled, args: ["--hidden"] });
  }
  updateTrayMenu();
  return startup();
}

// The tray during a sync: a status line in the menu, progress in the tooltip,
// and the icon pulsing until it finishes.
let traySync = "";
let trayIcons = null;
let trayPulse = null;
function trayProgress(value) {
  if (!tray) return;
  const running = !value.done && value.phase !== "Finished";
  const percent = value.totalBytes ? Math.floor(((value.doneBytes || 0) * 100) / value.totalBytes) : null;
  traySync = running ? `Syncing${percent !== null ? ` ${percent}%` : ""}${value.fileCount ? ` · file ${value.fileIndex || 0} of ${value.fileCount}` : ""}` : "";
  tray.setToolTip(traySync ? `${product.name} · ${traySync}` : product.name);
  if (running && !trayPulse) {
    let dim = false;
    trayPulse = setInterval(() => {
      dim = !dim;
      tray?.setImage(dim ? trayIcons.dim : trayIcons.normal);
    }, 600);
  } else if (!running && trayPulse) {
    clearInterval(trayPulse);
    trayPulse = null;
    tray.setImage(trayIcons.normal);
  }
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const login = startup();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: traySync || "Not syncing", enabled: false },
      { type: "separator" },
      { label: `Open ${product.name}`, click: showWindow },
      {
        label: process.platform === "darwin" ? "Open at login" : `Start with ${process.platform === "win32" ? "Windows" : "the system"}`,
        type: "checkbox",
        checked: login.enabled,
        enabled: login.supported,
        click: (item) => setStartup(item.checked),
      },
      { type: "separator" },
      { label: `Quit ${product.name}`, click: () => app.quit() },
    ]),
  );
}

function createTray() {
  const normal = nativeImage.createFromPath(path.join(__dirname, "build-resources", "icon.png")).resize({ width: 16, height: 16 });
  // The same icon at half opacity, for the pulse during a sync.
  const bitmap = Buffer.from(normal.toBitmap());
  for (let i = 3; i < bitmap.length; i += 4) bitmap[i] = bitmap[i] >> 1;
  const dim = nativeImage.createFromBitmap(bitmap, normal.getSize());
  trayIcons = { normal, dim };
  tray = new Tray(normal);
  tray.setToolTip(product.name);
  tray.on("click", showWindow);
  updateTrayMenu();
}

// One running copy: starting it again opens the existing window.
const primaryInstance = !!process.env.ODIN_SYNC_DATA_DIR || app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
app.on("second-instance", showWindow);

function registerIpc() {
  for (const name of handlers.keys()) {
    ipcMain.handle(name, async (event, ...args) => {
      if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
        throw new Error("Invalid sender");
      }
      return dispatch("app", null, name, args);
    });
  }
}

function findDevice(deviceId) {
  const device = config.devices.find((d) => d.id === deviceId);
  if (!device) throw new Error("Choose a saved device.");
  if (!device.hardwareId) throw new Error(`Finish setting up ${device.name} in Devices first.`);
  return device;
}

// Devices the app could not reach; the background loop keeps trying them.
const offline = new Map();

function markOffline(deviceId) {
  if (!offline.has(deviceId))
    offline.set(deviceId, { delay: RECONNECT_FIRST_MS, next: Date.now() + RECONNECT_FIRST_MS });
}

function markOnline(deviceId) {
  const wasOffline = offline.delete(deviceId);
  if (wasOffline)
    send("device:state", { deviceId, state: "online", detail: "Reconnected automatically." });
}

// The connection a sync or browse uses: the device's Odin Sync app.
async function deviceLink(deviceId) {
  const device = findDevice(deviceId);
  try {
    const client = await reachReceiver(device);
    markOnline(deviceId);
    return client;
  } catch (error) {
    markOffline(deviceId);
    throw error;
  }
}

// ---- The Odin Sync app on the device ----

const receiverLinks = new Map();

// Where discovery asks: the broadcast addresses, plus each receiver's last
// known address (so a network that drops broadcasts still works).
// ODIN_SYNC_RECEIVER_TARGETS / _UDP point tests at a fake receiver.
function receiverTargets() {
  if (process.env.ODIN_SYNC_RECEIVER_TARGETS) return process.env.ODIN_SYNC_RECEIVER_TARGETS.split(",");
  const known = config.devices.map((d) => d.receiver?.host).filter(Boolean);
  return [...new Set([...receiverClient.broadcastAddresses(), ...known])];
}

function discoverReceivers(timeout = 1500) {
  return receiverClient.discover({
    desktopId: config.desktopId,
    targets: receiverTargets(),
    port: Number(process.env.ODIN_SYNC_RECEIVER_UDP) || receiverClient.DISCOVERY_PORT,
    timeout,
  });
}

function clientFor(device, host, port) {
  const client = new receiverClient.ReceiverClient({
    host,
    port,
    desktopId: config.desktopId,
    key: device.receiver.key,
  });
  // Low impact transfers (for playing while syncing): a speed cap, in MB/s.
  const low = device.lowImpact;
  if (low?.enabled) client.maxBytesPerSecond = Math.max(0.5, Number(low.mbPerSecond) || 5) * 1024 * 1024;
  return client;
}

// Finds the device's receiver app: its last address first, then a broadcast.
// The protocol this desktop speaks; older apps are asked to update.
const RECEIVER_VERSION = 2;

function requireCurrentApp(device, hello) {
  if ((hello.version || 1) < RECEIVER_VERSION) {
    throw new Error(
      `Update the Odin Sync app on ${device.name}: in Devices, share the installer and install it again over the old one (pairing is kept).`,
    );
  }
}

// The app reports the device's GPU (for GameNative configs); saved when it changes.
// and its app version (shown in Devices, compared with the bundled one).
async function rememberGpu(device, hello) {
  const app = Number.isInteger(hello?.appVersion)
    ? { versionCode: hello.appVersion, versionName: String(hello.appVersionName || "") }
    : null;
  const gpuChanged = hello?.gpu && device.gpu !== hello.gpu;
  const appChanged = app && device.app?.versionCode !== app.versionCode;
  const access = typeof hello?.filesAccess === "boolean" ? hello.filesAccess : null;
  const accessChanged = access !== null && device.filesAccess !== access;
  if (!gpuChanged && !appChanged && !accessChanged) return;
  await update((current) => {
    const next = structuredClone(current);
    const saved = next.devices.find((d) => d.id === device.id);
    if (saved && gpuChanged) saved.gpu = hello.gpu;
    if (saved && appChanged) saved.app = app;
    if (saved && accessChanged) saved.filesAccess = access;
    return next;
  });
  if (appChanged || accessChanged) send("device:state", { deviceId: device.id, state: "online", changed: true, detail: "Connected through the Odin Sync app." });
}

// The version of the app bundled with this PC app (written by npm run build:apk).
const RECEIVER_MANIFEST = path.join(__dirname, "receiver", "odin-sync-receiver.json");
function bundledApp() {
  try {
    const { versionCode, versionName } = JSON.parse(fsSync.readFileSync(RECEIVER_MANIFEST, "utf8"));
    return Number.isInteger(versionCode) ? { versionCode, versionName: String(versionName || "") } : null;
  } catch {
    return null;
  }
}

async function reachReceiver(device, found = null) {
  const r = device.receiver;
  const known = receiverLinks.get(device.id) || (r.host ? clientFor(device, r.host, r.port) : null);
  if (known) {
    try {
      const hello = await known.hello();
      if (hello.id === r.id && hello.paired) {
        requireCurrentApp(device, hello);
        await rememberGpu(device, hello);
        receiverLinks.set(device.id, known);
        return known;
      }
    } catch (error) {
      if (/^Update the Odin Sync app/.test(error.message)) throw error;
      // Moved or closed; look for it.
    }
  }
  receiverLinks.delete(device.id);
  let answer = (found || (await discoverReceivers())).find((a) => a.id === r.id);
  if (!answer && r.mac) {
    const ip = (await desktopLink.readArp())[r.mac];
    if (ip && ip !== r.host) {
      try {
        const hello = await clientFor(device, ip, r.port || receiverClient.HTTP_PORT).hello();
        if (hello.id === r.id) answer = { ...hello, host: ip, port: r.port || receiverClient.HTTP_PORT };
      } catch {
        // Not there either.
      }
    }
  }
  if (!answer) {
    throw new Error(`Open the Odin Sync app on ${device.name}: it is not answering on the network.`);
  }
  if (!answer.paired) {
    throw new Error(`${device.name}'s Odin Sync app no longer knows this PC. Pair it again in Devices.`);
  }
  requireCurrentApp(device, answer);
  await rememberGpu(device, answer);
  const client = clientFor(device, answer.host, answer.port);
  await client.status();
  receiverLinks.set(device.id, client);
  if (r.host !== answer.host || r.port !== answer.port) {
    await update((current) => {
      const next = structuredClone(current);
      const saved = next.devices.find((d) => d.id === device.id);
      if (saved?.receiver) Object.assign(saved.receiver, { host: answer.host, port: answer.port, lastSeen: Date.now() });
      return next;
    });
  }
  return client;
}

// ---- The app finding the PC ----

const tickets = new desktopLink.Tickets();
const pairings = new desktopLink.Pairings();

// The app pairing with this PC: start (key exchange), then finish with the
// PIN sealed under the agreed key. A wrong PIN counts against the address,
// like a wrong browser login. A device paired before (same app id) keeps its
// profile; otherwise a new device is created.
async function pairApp(step, body, ip) {
  if (!config.web?.password) {
    throw Object.assign(new Error("Set a PIN in Odin Sync on the PC first."), { status: 409 });
  }
  if (step === "start") {
    const publicKey = pairings.start(body);
    return { publicKey, desktopId: config.desktopId, name: os.hostname() };
  }
  const pending = pairings.finish(body);
  if (!verifyPassword(pending.pin, config.web.password)) {
    limiter.fail(ip);
    throw Object.assign(new Error("Wrong PIN."), { status: 401 });
  }
  limiter.reset(ip);
  pairings.done(body.receiverId);
  const receiver = {
    id: body.receiverId,
    key: pending.key.toString("base64"),
    host: ip,
    port: pending.httpPort,
    lastSeen: Date.now(),
  };
  let deviceId;
  let fresh = false;
  await update((current) => {
    const next = structuredClone(current);
    let device = next.devices.find((d) => d.receiver?.id === receiver.id);
    if (!device) {
      fresh = true;
      device = {
        id: crypto.randomUUID(),
        name: pending.name,
        transport: "receiver",
        hardwareId: "receiver:" + receiver.id,
        pairingState: "paired",
      };
      next.devices.push(device);
    }
    device.receiver = { ...device.receiver, ...receiver };
    if (pending.gpu) device.gpu = pending.gpu;
    deviceId = device.id;
    return next;
  });
  receiverLinks.delete(deviceId);
  markOnline(deviceId);
  send("device:state", {
    deviceId,
    state: "online",
    paired: true,
    fresh,
    detail: "Paired through the Odin Sync app.",
  });
  return {
    ok: true,
    desktopId: config.desktopId,
    name: os.hostname(),
    webPort: webPort(),
    proof: crypto.createHmac("sha256", pending.key).update("paired\n" + receiver.id).digest("hex"),
  };
}

function receiverKey(receiverId) {
  const device = config.devices.find((d) => d.receiver?.id === receiverId);
  return device ? Buffer.from(device.receiver.key, "base64") : null;
}

// Records where a device's app was seen (and its MAC, from the ARP table).
async function receiverSeen(receiverId, { host, port, app, filesAccess = null }) {
  const device = config.devices.find((d) => d.receiver?.id === receiverId);
  if (!device) return;
  const r = device.receiver;
  const moved = r.host !== host || r.port !== port;
  if (moved) receiverLinks.delete(device.id);
  const mac = (Object.entries(await desktopLink.readArp()).find(([, ip]) => ip === host) || [])[0] || r.mac;
  await update((current) => {
    const next = structuredClone(current);
    const saved = next.devices.find((d) => d.id === device.id);
    if (saved?.receiver) Object.assign(saved.receiver, { host, port, mac, lastSeen: Date.now() });
    if (saved && app) saved.app = app;
    if (saved && filesAccess !== null) saved.filesAccess = filesAccess;
    return next;
  });
  const wasOffline = offline.has(device.id);
  markOnline(device.id);
  const appChanged = app && device.app?.versionCode !== app.versionCode;
  const accessChanged = filesAccess !== null && device.filesAccess !== filesAccess;
  if (wasOffline || moved || appChanged || accessChanged) {
    // changed: the device's details (address, app version) differ; pages reload them.
    send("device:state", {
      deviceId: device.id,
      state: "online",
      changed: true,
      detail: "Connected through the Odin Sync app.",
    });
  }
}

const appListener = desktopLink.createAppListener({
  port: Number(process.env.ODIN_SYNC_APP_UDP) || desktopLink.APP_PORT,
  host: process.env.ODIN_SYNC_WEB_HOST || "0.0.0.0",
  desktopId: () => config.desktopId,
  desktopName: () => os.hostname(),
  webPort: () => (web?.running() ? webPort() : 0),
  keyFor: receiverKey,
  app: bundledApp,
  seen: (receiverId, where) => receiverSeen(receiverId, where).catch(() => {}),
});


async function writeReport(name, value) {
  await fs.writeFile(dataPath(name), JSON.stringify(value, null, 2));
}

function registerSettingsHandlers() {
  // The start-up notice (such as a settings backup) is shown once.
  handle("config:get", () => {
    const result = snapshot();
    notice = "";
    return result;
  });
  handle("folder:save", async (input) => {
    let folderId;
    const result = await update((current) => {
      const saved = settings.saveFolder(current, input);
      folderId = saved.folder.id;
      return saved.config;
    });
    forgetListings(folderId);
    return { ...result, folderId };
  });
  handle("folder:remove", async (folderId) => {
    requireIdle("remove a local folder");
    forgetListings(folderId);
    const result = await update((current) => settings.removeFolder(current, folderId));
    await media.removeFolder(mediaDir, folderId);
    return result;
  });
  handle("filters:save", async (filters) => {
    forgetListings();
    return update((current) => settings.setTypeFilters(current, filters));
  });
  handle("profile:destination", (deviceId, folderId, target) =>
    update((current) => settings.setDestination(current, deviceId, folderId, target)),
  );
  handle("profile:override", (deviceId, folderId, relative, target) =>
    update((current) => settings.setOverride(current, deviceId, folderId, relative, target)),
  );
  handle("profile:selectFolder", (deviceId, folderId, relative, selected) =>
    update((current) =>
      settings.setFolderSelection(current, deviceId, folderId, relative, selected),
    ),
  );
  handle("profile:selectItems", (deviceId, folderId, items, selected) =>
    update((current) => settings.setItemSelection(current, deviceId, folderId, items, selected)),
  );
  handle("device:rename", (deviceId, name) =>
    update((current) => settings.renameDevice(current, deviceId, name)),
  );
  handle("device:remove", async (deviceId) => {
    requireIdle("remove a device");
    receiverLinks.delete(deviceId);
    if (checked?.deviceId === deviceId) checked = null;
    lastChecks.delete(deviceId);
    const result = await update((current) => settings.removeDevice(current, deviceId));
    await inventory.remove(dataDir, deviceId);
    return result;
  });
  handle("settings:reset", async () => {
    requireIdle("reset settings");
    const backup = await settings.backupConfig(dataDir, config);
    forgetListings();
    receiverLinks.clear();
    checked = null;
    lastChecks.clear();
    for (const device of config.devices) await inventory.remove(dataDir, device.id);
    for (const name of ["library.json", "scan-warnings.json"]) {
      await fs.rm(dataPath(name), { force: true });
    }
    const result = await update(() => settings.emptyConfig());
    sessions.end("web access turned off");
    await applyWebServer();
    return { ...result, notice: `All settings were cleared. A backup was saved as ${backup}.` };
  });
  handle("pick:folder", async () => {
    const result = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
    return result.filePaths[0] || null;
  });
}

function registerLibraryHandlers() {
  handle("library:list", async (folderId, relative = "", refresh = false) => {
    const folder = config.folders.find((f) => f.id === folderId);
    if (!folder) throw new Error("That local folder no longer exists.");
    const key = folderId + "\n" + relative;
    // Reload re-reads the PC: every cached listing of this local folder is dropped.
    if (refresh) forgetListings(folderId);
    if (!refresh && listings.has(key)) return listings.get(key);
    const listing = await catalog.listFolder(folder, relative, config.typeFilters);
    listing.readAt = Date.now();
    listings.set(key, listing);
    return listing;
  });
  // Opens a folder of the library in Explorer, for cleaning up files by hand.
  handle("library:reveal", async (folderId, relative = "") => {
    const folder = config.folders.find((f) => f.id === folderId);
    if (!folder) throw new Error("That local folder no longer exists.");
    if (relative) settings.relativePath(relative);
    const root = await fs.realpath(folder.path);
    const target = await fs.realpath(path.join(root, ...relative.split("/").filter(Boolean)));
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error("Invalid folder.");
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
    return true;
  });
  handle("library:gameSizes", async (folderId, names) => {
    const folder = config.folders.find((f) => f.id === folderId);
    if (!folder || folder.type !== "games") throw new Error("Choose a Games folder.");
    return catalog.gameSizes(folder, names.slice(0, 500));
  });
}

function registerDeviceHandlers() {
  handle("device:status", () =>
    deviceTask(async () => {
      const states = {};
      const withApp = config.devices.filter((d) => d.receiver);
      const answers = withApp.length ? await discoverReceivers() : [];
      for (const device of withApp) {
        try {
          const client = await reachReceiver(device, answers);
          const hello = await client.hello().catch(() => ({}));
          states[device.id] = {
            state: "online",
            verified: true,
            via: "receiver",
            detail: "Connected through the Odin Sync app.",
            memoryMb: hello.memoryMb || 0,
            lastTrim: hello.lastTrim || "",
          };
        } catch (error) {
          states[device.id] = { state: "offline", verified: false, detail: error.message };
        }
      }
      for (const [deviceId, state] of Object.entries(states)) {
        if (state.verified) markOnline(deviceId);
        else if (config.devices.find((d) => d.id === deviceId)?.hardwareId) markOffline(deviceId);
      }
      return states;
    }),
  );
  // A device paired again from its app arrives as a new device; this moves its
  // pairing onto an existing device so that profile and inventory carry on.
  // Low impact transfers: cap the speed so a game on the device keeps its resources.
  handle("device:lowImpact", async (deviceId, enabled, mbPerSecond) => {
    const speed = Number(mbPerSecond);
    if (enabled && !(speed >= 0.5 && speed <= 500)) throw new Error("Choose a speed between 0.5 and 500 MB/s.");
    const result = await update((current) => {
      const next = structuredClone(current);
      const device = next.devices.find((d) => d.id === deviceId);
      if (!device) throw new Error("That device no longer exists.");
      device.lowImpact = { enabled: !!enabled, mbPerSecond: speed || 5 };
      return next;
    });
    receiverLinks.delete(deviceId);
    return result;
  });
  handle("device:merge", async (fromId, intoId) => {
    requireIdle("change devices");
    const from = config.devices.find((d) => d.id === fromId);
    const into = config.devices.find((d) => d.id === intoId);
    if (!from?.receiver || !into || from.id === into.id) throw new Error("Choose two different devices.");
    const result = await update((current) => {
      const next = structuredClone(current);
      const source = next.devices.find((d) => d.id === fromId);
      const target = next.devices.find((d) => d.id === intoId);
      target.receiver = source.receiver;
      target.transport = "receiver";
      if (source.gpu) target.gpu = source.gpu;
      next.devices = next.devices.filter((d) => d.id !== fromId);
      next.profiles = next.profiles.filter((p) => p.deviceId !== fromId);
      return next;
    });
    receiverLinks.delete(fromId);
    receiverLinks.delete(intoId);
    await inventory.remove(dataDir, fromId);
    markOnline(intoId);
    return { ...result, deviceId: intoId };
  });
  // options: {foldersOnly, sizes}; sizes adds up each folder on the device.
  const browse = (link, target, options) => link.browse(target, !!options?.foldersOnly, !!options?.sizes);
  handle("storage:browse", async (deviceId, target, options) => browse(await deviceLink(deviceId), target, options));
  handle("storage:size", async (deviceId, target) => (await deviceLink(deviceId)).folderSize(target));
  handle("storage:mkdir", async (deviceId, parent, name, options) => {
    const link = await deviceLink(deviceId);
    await link.mkdir(parent, name);
    return browse(link, parent, options);
  });
  // A folder is deleted with everything in it (the app refuses storage roots
  // and Android folders). Files this app copied there leave the inventory.
  handle("storage:delete", async (deviceId, target, expected, options) => {
    requireIdle("delete files on the device");
    const link = await deviceLink(deviceId);
    await link.delete(target, expected?.type, expected?.fingerprint);
    const known = await inventory.load(dataDir, deviceId, config);
    const gone = inventory
      .entries(known)
      .filter((e) => storageInside(e.target, target))
      .map((e) => e.target);
    if (gone.length) {
      for (const file of gone) inventory.forget(known, file);
      await inventory.save(dataDir, known);
    }
    return browse(link, path.posix.dirname(target), options);
  });
  // Upload from the PC: the native picker hands out tokens for the chosen
  // files; only those can be uploaded.
  handle("storage:download", (deviceId, devicePath, type) => downloadToPc(deviceId, devicePath, type));
  handle("storage:cancel", () => {
    if (download) download.cancelled = true;
    return !!download;
  });
  handle("storage:pickFiles", async () => {
    const result = await dialog.showOpenDialog(win, { properties: ["openFile", "multiSelections"] });
    const picked = [];
    for (const file of result.filePaths) {
      const stat = await fs.stat(file);
      const token = crypto.randomUUID();
      pickedFiles.set(token, file);
      picked.push({ token, name: path.basename(file), size: stat.size });
    }
    return picked;
  });
  handle("storage:upload", async (deviceId, folder, tokens, options) => {
    requireIdle("upload to the device");
    const link = await deviceLink(deviceId);
    const files = (Array.isArray(tokens) ? tokens : []).map((token) => pickedFiles.get(token)).filter(Boolean);
    if (!files.length) throw new Error("Choose files to upload.");
    for (const [index, file] of files.entries()) {
      const stat = await fs.stat(file);
      await uploadOne(link, file, folder, path.basename(file), stat, index, files.length);
    }
    for (const token of tokens) pickedFiles.delete(token);
    return browse(link, folder, options);
  });
}

const pickedFiles = new Map();

// Files under a device folder: [{path, relative, size}] (from the app's listing).
async function deviceTree(link, folder) {
  const root = folder.replace(/\/+$/, "");
  const files = [];
  for (const line of (await link.listing([root])).split("\n")) {
    const match = line.match(/^(\d+)\|(\/.*)$/);
    if (match && match[2].startsWith(root + "/")) {
      files.push({ path: match[2], relative: match[2].slice(root.length + 1), size: Number(match[1]) });
    }
  }
  return files;
}

// Downloading to the PC: a file, or a folder with everything in it, into a
// folder chosen with the native picker. Cancel stops after the current chunk.
let download = null;
async function downloadToPc(deviceId, devicePath, type) {
  const link = await deviceLink(deviceId);
  const name = path.posix.basename(devicePath);
  const files =
    type === "folder"
      ? (await deviceTree(link, devicePath)).map((f) => ({ ...f, local: path.join(name, ...f.relative.split("/")) }))
      : [{ path: devicePath, relative: name, local: name, size: null }];
  const choice = await dialog.showOpenDialog(win, { title: `Download ${name} to`, properties: ["openDirectory", "createDirectory"] });
  const folder = choice.filePaths[0];
  if (!folder) return { cancelled: true };
  const existing = files.filter((f) => fsSync.existsSync(path.join(folder, f.local)));
  if (existing.length) {
    const answer = await dialog.showMessageBox(win, {
      type: "question",
      buttons: ["Replace", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: `Replace ${existing.length} existing file${existing.length === 1 ? "" : "s"}?`,
      detail: existing.slice(0, 8).map((f) => f.local).join("\n"),
    });
    if (answer.response !== 0) return { cancelled: true };
  }
  download = { cancelled: false };
  try {
    for (const [index, file] of files.entries()) {
      if (download.cancelled) return { cancelled: true, done: index };
      const target = path.join(folder, file.local);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const partial = target + ".odin-sync-download";
      const stream = await link.download(file.path);
      const size = Number(stream.headers["content-length"]) || file.size || 0;
      let bytes = 0;
      const progress = () =>
        send("storage:progress", { verb: "Downloading", name: file.relative, index: index + 1, count: files.length, bytes, size, done: false });
      progress();
      try {
        const out = fsSync.createWriteStream(partial);
        for await (const chunk of stream) {
          if (download.cancelled) {
            stream.destroy();
            break;
          }
          bytes += chunk.length;
          if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve));
          progress();
        }
        await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
        if (download.cancelled) {
          await fs.rm(partial, { force: true });
          return { cancelled: true, done: index };
        }
        await fs.rename(partial, target);
      } catch (error) {
        await fs.rm(partial, { force: true });
        throw error;
      }
    }
    send("storage:progress", { verb: "Downloading", name, index: files.length, count: files.length, done: true });
    return { folder, files: files.length };
  } finally {
    download = null;
  }
}

// The web UI's download: a file streams through; a folder streams as a zip.
async function webDownload(deviceId, devicePath, type, res) {
  const link = await deviceLink(deviceId);
  const name = path.posix.basename(devicePath) || "download";
  const disposition = (file) => `attachment; filename="${file.replace(/[^\x20-\x7e]|"/g, "_")}"; filename*=UTF-8''${encodeURIComponent(file)}`;
  if (type !== "folder") {
    const stream = await link.download(devicePath);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": stream.headers["content-length"],
      "Content-Disposition": disposition(name),
      "Cache-Control": "no-store",
    });
    await require("node:stream/promises").pipeline(stream, res);
    return;
  }
  const files = await deviceTree(link, devicePath);
  res.writeHead(200, { "Content-Type": "application/zip", "Content-Disposition": disposition(name + ".zip"), "Cache-Control": "no-store" });
  const zip = new ZipStream(res);
  for (const file of files) await zip.add(`${name}/${file.relative}`, await link.download(file.path));
  await zip.finish();
}

// target is inside folder (or is folder), as device paths, ignoring case.
function storageInside(target, folder) {
  const a = destination(target).toLowerCase();
  const b = folder.replace(/^\/storage\/emulated\/0(?=\/|$)/, "/sdcard").replace(/\/+$/, "").toLowerCase();
  const c = folder.replace(/\/+$/, "").toLowerCase();
  return [b, c].some((f) => a === f || a.startsWith(f + "/"));
}

// One file to a device folder, verified like a sync (temporary name, SHA-256
// of what was sent and what was written, then moved into place).
async function uploadOne(link, source, folder, name, stat, index, count) {
  if (!name || /[\/\\\x00-\x1f]/.test(name) || name === "." || name === "..") throw new Error("Invalid file name.");
  const target = destination(`${folder.replace(/\/+$/, "")}/${name}`);
  const report = (bytes) =>
    send("storage:progress", { name, index: index + 1, count, bytes, size: stat.size, done: false });
  report(0);
  await link.upload(source, target, stat.size, Math.floor(stat.mtimeMs / 1000), report);
  send("storage:progress", { name, index: index + 1, count, bytes: stat.size, size: stat.size, done: index + 1 === count });
}

// The web UI's upload: the file arrives at the PC as a temporary file, then
// goes to the device the same way.
async function webUpload(deviceId, folder, name, file, session) {
  if (!sessions.allowed("web", session)) throw new Error("You are logged out.");
  return operations.run("uploading to the device", "web", async () => {
    requireIdle("upload to the device");
    const link = await deviceLink(deviceId);
    await uploadOne(link, file, folder, name, await fs.stat(file), 0, 1);
    return { ok: true };
  });
}

// Per item (folderId + itemId): the action from the last check of a device.
const lastChecks = new Map();

function itemKey(folderId, itemId) {
  return JSON.stringify([folderId, itemId]);
}

// One state per item; an item with any file to add or update counts as that.
// "Missing": synced by this app before, deleted on the device since.
function itemStates(entries) {
  const rank = { Missing: 6, Remove: 5, Different: 4, Update: 3, Add: 2, Unchanged: 1 };
  const states = {};
  for (const entry of entries) {
    const key = itemKey(entry.folderId, entry.itemId);
    const action = entry.restore ? "Missing" : entry.action;
    if (!states[key] || rank[action] > rank[states[key]]) states[key] = action;
  }
  return states;
}

// Temporary files of copies interrupted by a disconnect, removed on the next check.
const orphanedTemps = new Map();

async function removeOrphans(deviceId, adb) {
  const temps = (orphanedTemps.get(deviceId) || []).filter((t) => TEMP_NAME.test(t));
  if (!temps.length) return;
  await adb.removeTemps(temps);
  orphanedTemps.delete(deviceId);
}

// After a disconnect, tries to find the device again (hardware-ID verified).
async function reconnect(deviceId, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    send("sync:progress", {
      phase: `Device disconnected · reconnecting (try ${attempt} of ${attempts})`,
    });
    try {
      await deviceLink(deviceId);
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
  return false;
}

async function updateInventory(deviceId, results, gone) {
  const known = await inventory.load(dataDir, deviceId, config);
  inventory.apply(known, results, gone);
  await inventory.save(dataDir, known);
}

// ---- ES-DE upload (optional per device) ----

// Adds each synced ROM's scraped cover and screenshot as planned files under
// <ES-DE>/downloaded_media/<system>/, and collects its gamelist entry.
async function addEsdeMedia(resolved, deviceId) {
  const profile = config.profiles.find((p) => p.deviceId === deviceId);
  if (!profile?.esdeUpload || !profile.esdeFolder || !profile.esdeRoms) return null;
  const gamelists = {};
  const outside = new Set();
  const mediaRoot = `${profile.esdeFolder}/downloaded_media`;
  const additions = [];
  for (const file of resolved.files) {
    const folder = config.folders.find((f) => f.id === file.folderId);
    if (folder?.type !== "roms" || file.relative !== file.itemId) continue;
    const meta = await media.read(mediaDir, file.folderId, file.itemId);
    if (!meta?.system) continue;
    const romPath = esde.romPathInSystem(file.target, profile.esdeRoms, meta.system);
    if (!romPath) {
      outside.add(`${folder.name} (${meta.system})`);
      continue;
    }
    for (const kind of Object.keys(esde.MEDIA_FOLDERS)) {
      const name = meta.files?.[kind];
      if (!name) continue;
      const source = media.filePath(mediaDir, file.folderId, file.itemId, name);
      const stat = await fs.stat(source).catch(() => null);
      if (!stat) continue;
      additions.push({
        folderId: file.folderId,
        folder: file.folder,
        type: "media",
        itemId: file.itemId,
        relative: `${file.relative} (${kind})`,
        source,
        size: stat.size,
        mtime: Math.floor(stat.mtimeMs / 1000),
        target: destination(
          esde.mediaTarget(profile.esdeFolder, meta.system, romPath, kind, path.extname(name)),
        ),
        root: mediaRoot,
        unitRoot: "",
      });
    }
    (gamelists[meta.system] ||= []).push({ path: "./" + romPath, fields: esde.gameFields(meta) });
  }
  resolved.files.push(...additions);
  if (additions.length) resolved.roots = plan.minimalRoots([...resolved.roots, mediaRoot]);
  for (const name of outside) {
    resolved.warnings.push({
      folder: name,
      file: "",
      message: `ROMs are not under ${profile.esdeRoms}/<system>, so ES-DE artwork is not uploaded for them.`,
    });
  }
  return { esdeFolder: profile.esdeFolder, gamelists };
}

// Merges our ROMs into each system's gamelist.xml on the device, after keeping a
// copy of the previous file as gamelist.xml.odin-sync.bak.
async function updateGamelists(adb, esdePlan) {
  const results = [];
  for (const [system, entries] of Object.entries(esdePlan.gamelists)) {
    const target = destination(esde.gamelistPath(esdePlan.esdeFolder, system));
    try {
      const existing = (await adb.read(target)) || "";
      if (existing.trim()) {
        const backup = dataPath(`tmp-gamelist-${system}.bak`);
        await fs.writeFile(backup, existing);
        try {
          await runSync(
            [{ action: "Update", source: backup, size: (await fs.stat(backup)).size, target: target + ".odin-sync.bak", relative: "gamelist backup", folder: "ES-DE" }],
            adb,
            { onProgress: () => {} },
          );
        } finally {
          await fs.rm(backup, { force: true });
        }
      }
      const local = dataPath(`tmp-gamelist-${system}.xml`);
      await fs.writeFile(local, esde.mergeGamelist(existing, entries));
      try {
        const size = (await fs.stat(local)).size;
        const entry = {
          action: "Update",
          source: local,
          size,
          target,
          relative: `gamelist.xml (${system})`,
          folder: "ES-DE",
        };
        const outcome = await runSync([entry], adb, { onProgress: () => {} });
        results.push({
          system,
          target,
          status: outcome.results[0].status,
          reason: outcome.results[0].reason || "",
        });
      } finally {
        await fs.rm(local, { force: true });
      }
    } catch (error) {
      results.push({ system, target, status: "failed", reason: error.message });
    }
  }
  return results;
}

// Quietly retries offline devices (connected transports, saved address, ARP
// lookup by MAC, ADB's own mDNS list) with growing pauses, so a device that
// wakes up reconnects without anyone pressing Connect.
let reconnecting = false;
async function reconnectTick() {
  if (reconnecting) return;
  reconnecting = true;
  try {
    for (const [deviceId, state] of [...offline]) {
      const device = config.devices.find((d) => d.id === deviceId && d.hardwareId);
      if (!device) {
        offline.delete(deviceId);
        continue;
      }
      if (job?.deviceId === deviceId || Date.now() < state.next) continue;
      try {
        await reachReceiver(device);
        markOnline(deviceId);
      } catch {
        state.delay = Math.min(state.delay * 2, RECONNECT_MAX_MS);
        state.next = Date.now() + state.delay;
      }
    }
  } finally {
    reconnecting = false;
  }
}
setInterval(() => reconnectTick().catch(() => {}), 2000).unref();

function registerSyncHandlers() {
  // What Library shows per item: on the device (per inventory or last check)
  // and the last check's pending action.
  handle("inventory:status", async (deviceId) => {
    findDevice(deviceId);
    const known = await inventory.load(dataDir, deviceId, config);
    const onDevice = {};
    for (const entry of inventory.entries(known))
      onDevice[itemKey(entry.folderId, entry.itemId)] = true;
    const checkStates = lastChecks.get(deviceId) || {};
    for (const [key, action] of Object.entries(checkStates)) {
      if (action === "Unchanged") onDevice[key] = true;
      if (action === "Missing") delete onDevice[key];
    }
    return { onDevice, checked: checkStates };
  });
  handle("sync:check", async (deviceId) => {
    if (job) throw new Error("A sync is already running.");
    findDevice(deviceId);
    job = { deviceId, cancelled: false, checking: true };
    const cancelled = () => job.cancelled;
    try {
      checked = null;
      send("sync:progress", { phase: "Reading local folders" });
      const key = planKey(deviceId);
      const resolved = await plan.resolvePlanFiles(config, deviceId, { cancelled });
      const esdePlan = await addEsdeMedia(resolved, deviceId);
      if (cancelled()) throw new Error("Check stopped.");
      send("sync:progress", { phase: "Connecting to the device" });
      const adb = await deviceLink(deviceId);
      if (cancelled()) throw new Error("Check stopped.");
      await removeOrphans(deviceId, adb);
      send("sync:progress", { phase: "Listing files on the device" });
      const known = await inventory.load(dataDir, deviceId, config);
      const result = await plan.checkDevice(resolved, adb, inventory.entries(known));
      if (cancelled()) throw new Error("Check stopped.");
      checked = { deviceId, key, ...result, esde: esdePlan, time: Date.now() };
      lastChecks.set(deviceId, itemStates(result.entries));
      return { ...checked, config: publicConfig() };
    } finally {
      job = null;
    }
  });
  handle("sync:start", async (deviceId, options = {}) => {
    if (job) throw new Error("A sync is already running.");
    if (!checked || checked.deviceId !== deviceId) {
      throw new Error("Check this device first to see what will be copied.");
    }
    if (checked.key !== planKey(deviceId)) {
      throw new Error("Settings or selections changed since the check. Check the device again.");
    }
    const short = (checked.space?.[plan.spaceKey(options)] || []).filter((v) => v.short);
    if (short.length) {
      const v = short[0];
      throw new Error(
        `Not enough space on ${v.mount}: the sync needs ${Math.ceil(v.needed / 1048576)} MB plus a 100 MB margin, and ${Math.floor(v.available / 1048576)} MB is free.`,
      );
    }
    const current = checked;
    checked = null;
    job = { deviceId, cancelled: false };
    const startedAt = new Date();
    try {
      const adb = await deviceLink(deviceId);
      // The app shows the sync while it runs (and keeps the device awake).
      const session = async (fn) => {
        const queued = current.entries.filter((e) => e.action !== "Unchanged");
        await adb.beginSession(queued.length, queued.reduce((n, e) => n + e.size, 0)).catch(() => {});
        try {
          return await fn();
        } finally {
          await adb.endSession().catch(() => {});
        }
      };
      const outcome = await session(async () => {
        const copied = await runSync(current.entries, adb, {
          replaceDifferent: !!options.replaceDifferent,
          remove: !!options.remove,
          cancelled: () => job.cancelled,
          onProgress: (value) => send("sync:progress", value),
        });
        await updateInventory(deviceId, copied.results, current.gone);
        if (current.esde && !copied.disconnected && !copied.stopped) {
          copied.gamelists = await updateGamelists(adb, current.esde);
        }
        return copied;
      });
      lastChecks.delete(deviceId);
      if (outcome.orphans.length) {
        orphanedTemps.set(deviceId, [...(orphanedTemps.get(deviceId) || []), ...outcome.orphans]);
      }
      if (outcome.disconnected) {
        receiverLinks.delete(deviceId);
        outcome.reconnected = await reconnect(deviceId);
      }
      const device = config.devices.find((d) => d.id === deviceId);
      const logName = `sync-log-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`;
      await writeReport(logName, {
        device: { id: deviceId, name: device?.name, hardwareId: device?.hardwareId },
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        replaceDifferent: !!options.replaceDifferent,
        remove: !!options.remove,
        stopped: outcome.stopped,
        disconnected: outcome.disconnected,
        gamelists: outcome.gamelists,
        kept: current.kept,
        summary: current.summary,
        results: outcome.results,
        warnings: current.warnings,
        blocked: current.blocked,
      });
      return {
        ...outcome,
        warnings: current.warnings,
        blocked: current.blocked,
        log: dataPath(logName),
      };
    } finally {
      job = null;
      receiverLinks.delete(deviceId);
      send("sync:progress", { phase: "Finished", done: true });
    }
  });
  // Removes leftover temporary files found by the last check. Only paths that
  // check listed, and only names this app creates, are accepted.
  handle("sync:cleanTemps", async (deviceId) => {
    if (job) throw new Error("A sync is already running.");
    if (!checked || checked.deviceId !== deviceId) throw new Error("Check this device first.");
    const temps = checked.temps.map((t) => t.path).filter((p) => TEMP_NAME.test(p));
    if (!temps.length) return { removed: 0 };
    const adb = await deviceLink(deviceId);
    for (let i = 0; i < temps.length; i += 100) {
      await adb.removeTemps(temps.slice(i, i + 100));
    }
    checked.temps = [];
    return { removed: temps.length };
  });
  handle("sync:cancel", () => {
    if (job) job.cancelled = true;
    return !!job;
  });
}

// ---- Web access ----

const WEB_FILES = [
  "index.html",
  "style.css",
  "web-bridge.js",
  "ui.js",
  "storage-browser.js",
  "view-folders.js",
  "view-devices.js",
  "view-receiver.js",
  "view-profiles.js",
  "view-library.js",
  "view-media.js",
  "view-sync.js",
  "view-settings.js",
  "view-web.js",
  "app.js",
];

sessions.on("changed", (status) => {
  send("session:changed", status);
  web?.broadcast("session", status);
});

// Starts, stops or restarts the web server to match the settings.
async function applyWebServer() {
  // Always on: the installer, the app's pairing and sign-in, and the web UI.
  const wanted = webPort();
  if (web && web.port !== wanted) {
    await web.stop();
    web = null;
  }
  webError = "";
  if (!wanted || web) return;
  const server = createWebServer({
    root: __dirname,
    files: WEB_FILES,
    sessions,
    limiter,
    password: () => config.web?.password || null,
    verify: verifyPassword,
    channels: [...handlers.keys()],
    invoke: (channel, args, token) => dispatch("web", token, channel, args),
    apk: RECEIVER_APK,
    pair: pairApp,
    upload: webUpload,
    download: webDownload,
    uploadDir: dataPath("uploads"),
    tickets,
    deviceTicket: (header, method, target) => {
      const receiverId = desktopLink.verifyAppRequest(header, method, target, receiverKey);
      return config.devices.find((d) => receiverId && d.receiver?.id === receiverId)?.id || null;
    },
    // ODIN_SYNC_WEB_HOST limits the server to one address (tests use 127.0.0.1).
    host: process.env.ODIN_SYNC_WEB_HOST || "0.0.0.0",
  });
  try {
    await server.start(wanted);
    server.port = wanted;
    web = server;
  } catch (error) {
    webError = error.message;
  }
}

// ---- Scraped media (covers, screenshots, metadata) ----

const mediaDir = dataPath("media");
const DEFAULT_GAMENATIVE_FOLDER = "/sdcard/GameNative/configs";
const scrapeCache = dataPath("scrape-cache");
let scrapeJob = null;

// Small JPEG thumbnails for the Library list, made with Electron's image tools.
function screenscraperAccount() {
  const s = config.scraping || {};
  const account = {
    user: s.ssUser,
    password: s.ssPassword,
    devId: s.ssDevId,
    devPassword: s.ssDevPassword,
  };
  return screenscraper.configured(account) ? account : null;
}

function makeThumb(buffer) {
  const image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) return null;
  return image.resize({ height: 96, quality: "good" }).toJPEG(80);
}

function libraryFolder(folderId) {
  const folder = config.folders.find((f) => f.id === folderId);
  if (!folder) throw new Error("That local folder no longer exists.");
  if (!["roms", "games"].includes(folder.type))
    throw new Error("Scraping is for ROMs and Games folders.");
  return folder;
}

function registerMediaHandlers() {
  handle("media:thumbs", async (folderId, itemIds) => {
    const all = await media.list(mediaDir, folderId);
    const result = {};
    for (const itemId of (itemIds || []).slice(0, 1000)) {
      const meta = all[itemId];
      if (!meta) continue;
      result[itemId] = {
        title: meta.title || "",
        notFound: !!meta.notFound,
        thumb: await media.dataUrl(mediaDir, folderId, itemId, meta.files?.thumb),
      };
    }
    return result;
  });
  handle("media:details", async (folderId, itemId) => {
    const meta = await media.read(mediaDir, folderId, itemId);
    if (!meta) return null;
    return {
      ...meta,
      cover: await media.dataUrl(mediaDir, folderId, itemId, meta.files?.cover),
      screenshot: await media.dataUrl(mediaDir, folderId, itemId, meta.files?.screenshot),
    };
  });
  handle("steam:search", (term) => steam.search(String(term || "").slice(0, 100)));
  // A pasted Steam store/community link or app id -> that exact app.
  handle("steam:resolve", async (text) => {
    const appId = steam.parseAppRef(text);
    if (!appId)
      throw new Error(
        "Paste a Steam store link (store.steampowered.com/app/<id>/...) or an app id.",
      );
    const info = await steam.details(appId);
    return { appId, title: info.title };
  });
  handle("profile:option", (deviceId, key, value) =>
    update((current) => settings.setProfileOption(current, deviceId, key, value)),
  );
  // The best GameNative configs for a game on this device's GPU.
  // pasted: optional game name, Steam store link, or GameNative link/id.
  handle("gamenative:configs", async (folderId, itemId, deviceId, pasted) => {
    const meta = await media.read(mediaDir, folderId, itemId);
    const device = config.devices.find((d) => d.id === deviceId);
    let title = meta?.title || itemId;
    const ref = gamenative.parseGameRef(pasted) || { query: title };
    if (ref.query) title = ref.query;
    if (ref.steamAppId)
      title = (await steam.details(ref.steamAppId).catch(() => null))?.title || title;
    const result = await gamenative.bestConfigs(
      scrapeCache,
      { title, gameId: ref.gameId, steamAppId: ref.steamAppId },
      device?.gpu || gamenative.DEFAULT_GPU,
    );
    const profile = config.profiles.find((p) => p.deviceId === deviceId);
    return { ...result, title, folder: profile?.gameNativeFolder || DEFAULT_GAMENATIVE_FOLDER };
  });
  // Saves one report's config as <folder>/<game>.json on the device, verified.
  handle("gamenative:save", async (deviceId, gameId, gpu, runId, title) => {
    const configJson = await gamenative.configFor(scrapeCache, gameId, gpu, runId);
    const profile = config.profiles.find((p) => p.deviceId === deviceId);
    const folder = profile?.gameNativeFolder || DEFAULT_GAMENATIVE_FOLDER;
    const name =
      String(title || "game")
        .replace(/[\\/:*?"<>|]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 100) || "game";
    const target = destination(`${folder}/${name}.json`);
    const local = dataPath("tmp-gamenative.json");
    await fs.writeFile(local, JSON.stringify(configJson, null, 2));
    try {
      const adb = await deviceLink(deviceId);
      const size = (await fs.stat(local)).size;
      const entry = {
        action: "Update",
        source: local,
        size,
        target,
        relative: name + ".json",
        folder: "GameNative",
      };
      const outcome = await runSync([entry], adb, { onProgress: () => {} });
      const result = outcome.results[0];
      if (result.status !== "copied")
        throw new Error(result.reason || "The config could not be saved on the device.");
      return { target };
    } finally {
      await fs.rm(local, { force: true });
    }
  });
  // Scrapes a local folder (or part of it) in the background, one job at a time.
  handle("scrape:start", async (folderId, options = {}) => {
    if (scrapeJob) throw new Error("Scraping is already running.");
    const folder = libraryFolder(folderId);
    scrapeJob = { folderId, cancelled: false };
    try {
      send("scrape:progress", { phase: "Reading the folder", folderId });
      let items = await catalog.allItems(folder, config.typeFilters, options.relative || "");
      if (Array.isArray(options.itemIds))
        items = items.filter((i) => options.itemIds.includes(i.id));
      const result = await scrapeItems(items, {
        folder,
        mediaDir,
        cacheDir: scrapeCache,
        missingOnly: !!options.missingOnly,
        // ScreenScraper allows few parallel requests: one at a time when used.
        screenscraper:
          folder.type === "roms" && screenscraperAccount()
            ? screenscraper.createProvider(screenscraperAccount())
            : null,
        concurrency: folder.type === "roms" && screenscraperAccount() ? 1 : 2,
        appIds: options.appIds || {},
        makeThumb,
        cancelled: () => scrapeJob.cancelled,
        onProgress: (value) => send("scrape:progress", { ...value, folderId }),
      });
      return result;
    } finally {
      scrapeJob = null;
      send("scrape:progress", { phase: "Done", folderId, finished: true });
    }
  });
  handle("scrape:cancel", () => {
    if (scrapeJob) scrapeJob.cancelled = true;
    return !!scrapeJob;
  });
  handle("scraping:configure", (values = {}) =>
    update((current) => settings.setScraping(current, values)),
  );
  handle("scraping:test", async () => {
    const account = screenscraperAccount();
    if (!account)
      throw new Error(
        "Enter the ScreenScraper user, password, developer id and developer password.",
      );
    return screenscraper.createProvider(account).check();
  });
  handle("scrape:systems", () =>
    Object.entries(SYSTEMS).map(([id, system]) => ({ id, name: system.name })),
  );
}

function registerWebHandlers() {
  handle("session:status", () => sessions.status());
  handle("session:takeBack", () => {
    sessions.end("taken back");
    return snapshot();
  });
  // Shares the receiver installer for 15 minutes (or stops sharing it).
  // Port and PIN. A new PIN or port ends the browser session.
  handle("web:configure", async (input = {}) => {
    const changes = {};
    if (input.port !== undefined) changes.port = Number(input.port);
    if (input.pin) changes.password = hashPin(String(input.pin));
    const before = config.web;
    await update((current) => settings.setWeb(current, changes));
    if (changes.password) sessions.end("PIN changed");
    if (config.web.port !== before?.port) sessions.end("the web port changed");
    await applyWebServer();
    return snapshot();
  });
  handle("app:startup", (enabled) => {
    setStartup(enabled);
    return snapshot();
  });
  handle("web:restart", async () => {
    sessions.end("the server restarted");
    if (web) await web.stop();
    web = null;
    await applyWebServer();
    return snapshot();
  });
}

app.whenReady().then(async () => {
  if (!primaryInstance) return;
  await fs.mkdir(dataDir, { recursive: true });
  const loaded = await settings.loadConfig(dataDir);
  config = settings.ensureProfiles(loaded.config);
  notice = loaded.notice;
  await settings.saveConfig(dataDir, config);
  registerSettingsHandlers();
  registerLibraryHandlers();
  registerDeviceHandlers();
  registerSyncHandlers();
  registerWebHandlers();
  registerMediaHandlers();
  registerIpc();
  await applyWebServer();
  await appListener.start().catch((error) => {
    notice ||= `The Odin Sync app cannot find this PC by itself (UDP ${desktopLink.APP_PORT}: ${error.message}). Use Reconnect.`;
  });
  const smoke = process.argv.includes("--smoke-test");
  // Started with the system (--hidden): only the tray icon until opened.
  const hidden = process.argv.includes("--hidden");
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1080,
    minHeight: 720,
    show: !smoke && !hidden,
    backgroundColor: "#10151e",
    title: "Odin Sync",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // ODIN_SYNC_NO_TRAY: the end-to-end tests close the window to quit.
  if (!smoke && !process.env.ODIN_SYNC_NO_TRAY) createTray();
  if (app.isPackaged && !config.startupDefaulted) {
    try {
      setStartup(true);
    } catch {
      // Not available here.
    }
    await update((current) => ({ ...structuredClone(current), startupDefaulted: true }));
  }
  win.on("close", (event) => {
    if (quitting || !tray) return;
    event.preventDefault();
    win.hide();
    if (!trayHintShown && process.platform === "win32") {
      trayHintShown = true;
      tray.displayBalloon({
        title: product.name,
        content: "Odin Sync is still running in the tray, so your devices can find this PC. Right-click the icon to quit.",
        iconType: "info",
      });
    }
  });
  // Links to these sites open in the system browser; nothing opens in the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    // This app's own LAN addresses (web access, the receiver installer) too.
    const own = lanUrls(webPort()).some((base) => url === base || url.startsWith(base + "/"));
    if (own || /^https:\/\/(gamenative\.app|store\.steampowered\.com)\//.test(url))
      shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  await win.loadFile("index.html");
  if (smoke) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const state = await win.webContents.executeJavaScript(
      `({api: typeof window.odin.invoke, views: document.querySelectorAll('.view').length, status: document.getElementById('status').textContent})`,
    );
    console.log("SMOKE_TEST", JSON.stringify(state));
    const shot = process.env.ODIN_SYNC_SCREENSHOT || path.join(dataDir, "preview.png");
    await fs.writeFile(shot, (await win.webContents.capturePage()).toPNG());
    app.quit();
  }
});
// Closing the window keeps Odin Sync running in the tray, so devices can still
// find this PC and sync; Quit in the tray menu ends it.
app.on("window-all-closed", () => {
  if (!tray) app.quit();
});
