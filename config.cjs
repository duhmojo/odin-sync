// Configuration model (version 3): local folders, type-wide filters, devices and
// exactly one sync profile per device. The main process owns this object; the
// renderer changes it only through the named operations exported here.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { destination } = require("./core.cjs");

const VERSION = 3;

const TYPES = {
  roms: {
    label: "ROMs",
    extensions:
      ".zip .7z .nes .sfc .smc .gb .gbc .gba .nds .3ds .n64 .z64 .v64 .iso .chd .cso .pbp .cue .bin .img .m3u .gdi .md .gen .sms .gg .pce .nsp .xci .rvz .wbfs .wad .d64 .adf .a26 .a78",
    // Pre-filled for new ROM folders: frontend artwork, BIOS and media folders.
    excludeFolders: "^(media|bios|snap|snaps|wheel|mixart|boxart|images|videos|manuals)$",
  },
  games: { label: "Games", extensions: "" },
  music: { label: "Music", extensions: ".mp3 .flac .m4a .aac .ogg .wav .opus .wma .alac" },
  videos: { label: "Videos", extensions: ".mp4 .mkv .avi .mov .webm .m4v .mpeg .mpg .ts" },
  files: { label: "General files", extensions: "*" },
};

// Games are never filtered: a game folder always syncs complete.
const FILTERED_TYPES = ["roms", "music", "videos", "files"];

function emptyTypeFilters() {
  const filters = {};
  for (const type of FILTERED_TYPES) {
    filters[type] = { excludeFolders: "", excludeFiles: "" };
  }
  return filters;
}

function emptyConfig() {
  return {
    version: VERSION,
    folders: [],
    typeFilters: emptyTypeFilters(),
    devices: [],
    profiles: [],
    web: emptyWeb(),
    desktopId: crypto.randomUUID(),
  };
}

// The web server (always on): its port and the PIN, stored only as a scrypt
// hash and salt (kept in "password", where earlier versions stored it).
function emptyWeb() {
  return { port: 8765, password: null };
}

function validWeb(web) {
  if (web === undefined) return true;
  if (!isPlainObject(web) || (web.enabled !== undefined && typeof web.enabled !== "boolean")) return false;
  if (!Number.isInteger(web.port) || web.port < 1024 || web.port > 65535) return false;
  if (web.password === null) return true;
  return (
    isPlainObject(web.password) &&
    /^[0-9a-f]+$/.test(web.password.hash) &&
    /^[0-9a-f]+$/.test(web.password.salt)
  );
}

// A device's pairing with the Odin Sync receiver app: its id, the shared key
// (base64) and where it was last found.
function validReceiver(receiver) {
  return (
    isPlainObject(receiver) &&
    typeof receiver.id === "string" &&
    /^[0-9a-f-]{36}$/i.test(receiver.id) &&
    typeof receiver.key === "string" &&
    Buffer.from(receiver.key, "base64").length === 32 &&
    (receiver.host === undefined || typeof receiver.host === "string") &&
    (receiver.port === undefined || Number.isInteger(receiver.port))
  );
}

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function checkRegex(value, label) {
  if (typeof value !== "string") fail(`${label} must be text.`);
  if (value.length > 500) fail(`${label} is too long (500 characters at most).`);
  if (!value.trim()) return "";
  try {
    new RegExp(value, "i");
  } catch (error) {
    fail(`${label} is not a valid regular expression: ${error.message}`);
  }
  return value;
}

// Relative paths inside a local folder always use forward slashes.
function relativePath(value) {
  if (
    typeof value !== "string" ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.split("/").some((part) => part === ".." || part === ".") ||
    value.split("/").some((part, index, parts) => part === "" && parts.length > 1) ||
    /[\x00-\x1f]/.test(value)
  ) {
    fail("Invalid relative path.");
  }
  return value;
}

function extensionList(folder) {
  const chosen = (folder.extensions || "").trim() || TYPES[folder.type].extensions;
  if (chosen === "*") return [];
  return chosen
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map((ext) => (ext.startsWith(".") ? ext : "." + ext).toLowerCase());
}

function normalizeFolder(input) {
  if (!isPlainObject(input)) fail("Invalid local folder.");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 120) fail("Enter a folder name (up to 120 characters).");
  if (!TYPES[input.type]) fail("Choose a supported content type.");
  if (typeof input.path !== "string" || !path.isAbsolute(input.path)) {
    fail("Choose a folder on this PC.");
  }
  const games = input.type === "games";
  const extensions = typeof input.extensions === "string" ? input.extensions.trim() : "";
  if (extensions.length > 1000) fail("The extension list is too long.");
  if (extensions && extensions !== "*" && !/^[\w.\s,;+-]+$/.test(extensions)) {
    fail("Extensions may contain letters, digits and dots, separated by spaces or commas.");
  }
  return {
    id: typeof input.id === "string" && input.id ? input.id : crypto.randomUUID(),
    name,
    path: input.path,
    type: input.type,
    includeSubfolders: games ? false : input.includeSubfolders !== false,
    extensions: games ? "" : extensions,
    excludeFolders: games ? "" : checkRegex(input.excludeFolders || "", "Exclude folders"),
    excludeFiles: games ? "" : checkRegex(input.excludeFiles || "", "Exclude files"),
    // Sync review lists each file, or (off) one row per game/item.
    listFiles: typeof input.listFiles === "boolean" ? input.listFiles : !games,
    // ES-DE system for scraping ROMs; empty means guessed from folder names.
    system: input.type === "roms" ? systemName(input.system) : "",
  };
}

function systemName(value) {
  if (!value) return "";
  if (typeof value !== "string" || !/^[a-z0-9]{1,30}$/.test(value))
    fail("Choose a known ES-DE system.");
  return value;
}

function normalizeTypeFilters(input) {
  if (!isPlainObject(input)) fail("Invalid type filters.");
  const filters = emptyTypeFilters();
  for (const type of FILTERED_TYPES) {
    const value = input[type] || {};
    filters[type] = {
      excludeFolders: checkRegex(
        value.excludeFolders || "",
        `${TYPES[type].label} exclude folders`,
      ),
      excludeFiles: checkRegex(value.excludeFiles || "", `${TYPES[type].label} exclude files`),
    };
  }
  return filters;
}

function emptyProfile(deviceId) {
  return { deviceId, destinations: {}, overrides: {}, selections: {} };
}

function emptySelection() {
  return { folders: {}, items: [], excluded: [] };
}

function validateConfig(config) {
  if (!isPlainObject(config) || config.version !== VERSION) fail("Unsupported settings version.");
  for (const key of ["folders", "devices", "profiles"]) {
    if (!Array.isArray(config[key])) fail(`Invalid ${key} list.`);
  }
  const folderIds = new Set();
  for (const folder of config.folders) {
    const normal = normalizeFolder(folder);
    if (normal.id !== folder.id || folderIds.has(folder.id)) fail("Invalid or duplicate folder.");
    folderIds.add(folder.id);
  }
  normalizeTypeFilters(config.typeFilters);
  if (!validWeb(config.web)) fail("Invalid web access settings.");
  if (config.desktopId !== undefined && !/^[0-9a-f-]{36}$/i.test(config.desktopId)) fail("Invalid PC id.");
  if (config.scraping !== undefined && !isPlainObject(config.scraping))
    fail("Invalid scraping settings.");
  const deviceIds = new Set();
  for (const device of config.devices) {
    if (!isPlainObject(device) || typeof device.id !== "string" || !device.id) {
      fail("Invalid device.");
    }
    if (deviceIds.has(device.id)) fail("Duplicate device.");
    if (device.transport !== "receiver" || !device.receiver) fail("Unsupported device transport.");
    if (device.receiver !== undefined && !validReceiver(device.receiver)) fail("Invalid receiver pairing.");
    if (typeof device.name !== "string") fail("Invalid device name.");
    deviceIds.add(device.id);
  }
  const profileDevices = new Set();
  for (const profile of config.profiles) {
    if (!isPlainObject(profile) || !deviceIds.has(profile.deviceId)) fail("Invalid profile.");
    if (profileDevices.has(profile.deviceId)) fail("A device can have only one profile.");
    profileDevices.add(profile.deviceId);
    for (const key of ["destinations", "overrides", "selections"]) {
      if (!isPlainObject(profile[key])) fail("Invalid profile.");
    }
    for (const [key, check] of Object.entries(PROFILE_OPTIONS)) {
      if (profile[key] !== undefined) check(profile[key]);
    }
    for (const [folderId, target] of Object.entries(profile.destinations)) {
      if (!folderIds.has(folderId)) fail("Profile refers to an unknown folder.");
      destination(target);
    }
    for (const [folderId, overrides] of Object.entries(profile.overrides)) {
      if (!folderIds.has(folderId) || !isPlainObject(overrides)) fail("Invalid override.");
      for (const [relative, target] of Object.entries(overrides)) {
        relativePath(relative);
        destination(target);
      }
    }
    for (const [folderId, selection] of Object.entries(profile.selections)) {
      if (!folderIds.has(folderId) || !isPlainObject(selection)) fail("Invalid selection.");
      if (!isPlainObject(selection.folders)) fail("Invalid selection.");
      for (const [relative, value] of Object.entries(selection.folders)) {
        if (relative !== "") relativePath(relative);
        if (typeof value !== "boolean") fail("Invalid selection.");
      }
      for (const key of ["items", "excluded"]) {
        if (!Array.isArray(selection[key])) fail("Invalid selection.");
        for (const id of selection[key]) relativePath(id);
      }
    }
  }
  return config;
}

function timestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

// Reads config.json from the data folder. Anything that is not a valid version 3
// file is moved aside to a timestamped backup and the app starts empty, with a
// notice the UI shows to the user.
async function loadConfig(dataDir, now = new Date()) {
  const file = path.join(dataDir, "config.json");
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { config: emptyConfig(), notice: "" };
    throw error;
  }
  const backupName = `config-backup-${timestamp(now)}.json`;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    await fs.rename(file, path.join(dataDir, backupName));
    return {
      config: emptyConfig(),
      notice: `Saved settings could not be read (invalid JSON) and were moved to ${backupName}. Starting with empty settings.`,
    };
  }
  if (!isPlainObject(parsed) || parsed.version !== VERSION) {
    await fs.rename(file, path.join(dataDir, backupName));
    return {
      config: emptyConfig(),
      notice: `Odin Sync 0.3 uses a new settings format. Previous settings were saved to ${backupName}. Add your local folders and pair your devices again.`,
    };
  }
  try {
    const dropped = dropAdbDevices(parsed);
    const config = validateConfig(parsed);
    config.typeFilters = normalizeTypeFilters(config.typeFilters);
    config.web ||= emptyWeb();
    // Identifies this PC to receiver apps it pairs with.
    config.desktopId ||= crypto.randomUUID();
    return {
      config,
      notice: dropped.length
        ? `Wi-Fi ADB was removed: pair ${dropped.join(", ")} again with the Odin Sync app in Devices.`
        : "",
    };
  } catch (error) {
    await fs.rename(file, path.join(dataDir, backupName));
    return {
      config: emptyConfig(),
      notice: `Saved settings were invalid (${error.message}) and were moved to ${backupName}. Starting with empty settings.`,
    };
  }
}

async function saveConfig(dataDir, config) {
  validateConfig(config);
  const file = path.join(dataDir, "config.json");
  const temporary = file + ".tmp";
  await fs.writeFile(temporary, JSON.stringify(config, null, 2));
  await fs.rename(temporary, file);
}

async function backupConfig(dataDir, config, now = new Date()) {
  const name = `config-backup-${timestamp(now)}.json`;
  await fs.writeFile(path.join(dataDir, name), JSON.stringify(config, null, 2));
  return name;
}

// ---- Operations. Each takes the current config and returns a changed copy. ----

function clone(config) {
  return structuredClone(config);
}

function findFolder(config, folderId) {
  const folder = config.folders.find((f) => f.id === folderId);
  if (!folder) fail("That local folder no longer exists.");
  return folder;
}

function findDevice(config, deviceId) {
  const device = config.devices.find((d) => d.id === deviceId);
  if (!device) fail("That device no longer exists.");
  return device;
}

function profileFor(config, deviceId) {
  findDevice(config, deviceId);
  let profile = config.profiles.find((p) => p.deviceId === deviceId);
  if (!profile) {
    profile = emptyProfile(deviceId);
    config.profiles.push(profile);
  }
  return profile;
}

function ensureProfiles(config) {
  for (const device of config.devices) profileFor(config, device.id);
  return config;
}

function saveFolder(config, input) {
  const next = clone(config);
  const folder = normalizeFolder(input);
  const index = next.folders.findIndex((f) => f.id === folder.id);
  if (index >= 0) {
    const previous = next.folders[index];
    next.folders[index] = folder;
    // Selections point at paths inside the old folder; they no longer apply.
    if (previous.path !== folder.path || previous.type !== folder.type) {
      for (const profile of next.profiles) {
        delete profile.selections[folder.id];
        delete profile.overrides[folder.id];
      }
    }
  } else {
    next.folders.push(folder);
  }
  return { config: next, folder };
}

function removeFolder(config, folderId) {
  const next = clone(config);
  findFolder(next, folderId);
  next.folders = next.folders.filter((f) => f.id !== folderId);
  for (const profile of next.profiles) {
    delete profile.destinations[folderId];
    delete profile.overrides[folderId];
    delete profile.selections[folderId];
  }
  return next;
}

function setTypeFilters(config, filters) {
  const next = clone(config);
  next.typeFilters = normalizeTypeFilters(filters);
  return next;
}

function setDestination(config, deviceId, folderId, target) {
  const next = clone(config);
  findFolder(next, folderId);
  const profile = profileFor(next, deviceId);
  if (target) profile.destinations[folderId] = destination(target);
  else delete profile.destinations[folderId];
  return next;
}

// Per-device options beside the destinations: where GameNative configs and
// ES-DE live on the device, and whether to upload ES-DE artwork.
const PROFILE_OPTIONS = {
  gameNativeFolder: (value) => destination(value),
  esdeFolder: (value) => destination(value),
  esdeRoms: (value) => destination(value),
  esdeUpload: (value) => {
    if (typeof value !== "boolean") fail("Invalid ES-DE upload setting.");
    return value;
  },
};

function setProfileOption(config, deviceId, key, value) {
  const next = clone(config);
  if (!PROFILE_OPTIONS[key]) fail("Unknown device option.");
  const profile = profileFor(next, deviceId);
  if (value === "" || value === null || value === undefined) delete profile[key];
  else profile[key] = PROFILE_OPTIONS[key](value);
  return next;
}

function setOverride(config, deviceId, folderId, relative, target) {
  const next = clone(config);
  findFolder(next, folderId);
  relativePath(relative);
  const profile = profileFor(next, deviceId);
  const overrides = (profile.overrides[folderId] ||= {});
  if (target) overrides[relative] = destination(target);
  else delete overrides[relative];
  if (!Object.keys(overrides).length) delete profile.overrides[folderId];
  return next;
}

function inBranch(relative, folder) {
  return !folder || relative === folder || relative.startsWith(folder + "/");
}

function selectionFor(profile, folderId) {
  return (profile.selections[folderId] ||= emptySelection());
}

function requireDestination(profile, folder) {
  if (!profile.destinations[folder.id]) {
    fail(`Choose where “${folder.name}” goes on this device before selecting its content.`);
  }
}

// Checking a folder saves a rule for the whole branch; rules and item choices
// inside that branch are replaced by it.
function setFolderSelection(config, deviceId, folderId, relative, selected) {
  const next = clone(config);
  const folder = findFolder(next, folderId);
  if (relative !== "") relativePath(relative);
  const profile = profileFor(next, deviceId);
  requireDestination(profile, folder);
  const selection = selectionFor(profile, folderId);
  for (const key of Object.keys(selection.folders)) {
    if (inBranch(key, relative)) delete selection.folders[key];
  }
  const outside = (id) => !inBranch(id, relative);
  selection.items = selection.items.filter(outside);
  selection.excluded = selection.excluded.filter(outside);
  const inherited = folderRule(selection, relative);
  if (selected !== inherited) selection.folders[relative] = selected;
  cleanSelection(profile, folderId);
  return next;
}

// items: [{id, folder}] where folder is the relative folder that contains the item.
function setItemSelection(config, deviceId, folderId, items, selected) {
  const next = clone(config);
  const folder = findFolder(next, folderId);
  const profile = profileFor(next, deviceId);
  requireDestination(profile, folder);
  const selection = selectionFor(profile, folderId);
  const chosen = new Set(selection.items);
  const excluded = new Set(selection.excluded);
  for (const item of items) {
    relativePath(item.id);
    const byFolder = folderRule(selection, item.folder || "");
    chosen.delete(item.id);
    excluded.delete(item.id);
    if (selected && !byFolder) chosen.add(item.id);
    if (!selected && byFolder) excluded.add(item.id);
  }
  selection.items = [...chosen].sort();
  selection.excluded = [...excluded].sort();
  cleanSelection(profile, folderId);
  return next;
}

function cleanSelection(profile, folderId) {
  const selection = profile.selections[folderId];
  if (!selection) return;
  const empty =
    !Object.keys(selection.folders).length && !selection.items.length && !selection.excluded.length;
  if (empty) delete profile.selections[folderId];
}

// The nearest folder rule at or above `relative` decides; the default is unselected.
function folderRule(selection, relative) {
  let result = false;
  let depth = -1;
  for (const [folder, value] of Object.entries(selection?.folders || {})) {
    if (inBranch(relative, folder) && folder.length > depth) {
      result = value;
      depth = folder.length;
    }
  }
  return result;
}

function itemSelected(selection, id, folder) {
  if (!selection) return false;
  if (selection.items.includes(id)) return true;
  return folderRule(selection, folder) && !selection.excluded.includes(id);
}

function hasSelection(profile, folderId) {
  const selection = profile?.selections[folderId];
  if (!selection) return false;
  return Object.values(selection.folders).some(Boolean) || selection.items.length > 0;
}

// Local folders that have no destination on this device yet.
function gaps(config, deviceId) {
  const profile = config.profiles.find((p) => p.deviceId === deviceId);
  return config.folders.filter((f) => !profile?.destinations[f.id]).map((f) => f.id);
}

function renameDevice(config, deviceId, name) {
  const next = clone(config);
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed || trimmed.length > 120) fail("Enter a device name (up to 120 characters).");
  findDevice(next, deviceId).name = trimmed;
  return next;
}

function removeDevice(config, deviceId) {
  const next = clone(config);
  findDevice(next, deviceId);
  next.devices = next.devices.filter((d) => d.id !== deviceId);
  next.profiles = next.profiles.filter((p) => p.deviceId !== deviceId);
  return next;
}

// Optional ScreenScraper account for scraping (user and developer credentials).
const SCRAPING_KEYS = ["ssUser", "ssPassword", "ssDevId", "ssDevPassword"];

function setScraping(config, values) {
  const next = clone(config);
  const scraping = { ...(next.scraping || {}) };
  for (const key of SCRAPING_KEYS) {
    if (values[key] === undefined) continue;
    if (typeof values[key] !== "string" || values[key].length > 100)
      fail("Invalid ScreenScraper setting.");
    if (values[key]) scraping[key] = values[key].trim();
    else delete scraping[key];
  }
  next.scraping = scraping;
  return next;
}

function setWeb(config, web) {
  const next = clone(config);
  next.web = { ...emptyWeb(), ...next.web, ...web };
  delete next.web.enabled;
  if (!validWeb(next.web)) fail("Choose a port between 1024 and 65535.");
  return next;
}

// Settings from the Wi-Fi ADB era: a device paired with the app becomes an
// app device; one without the app is dropped with its profile (and named, so
// the person can pair it again). Returns the dropped devices' names.
function dropAdbDevices(config) {
  delete config.adbPath;
  delete config.awakeMode;
  if (!Array.isArray(config.devices)) return [];
  const dropped = [];
  config.devices = config.devices.filter((device) => {
    if (device?.transport !== "adb") return true;
    if (device.receiver) {
      device.transport = "receiver";
      device.hardwareId ||= "receiver:" + device.receiver.id;
      for (const key of ["serial", "endpoint", "serviceName", "address", "wifiIp", "tlsPort", "mac", "lastConnectionError"]) {
        delete device[key];
      }
      return true;
    }
    dropped.push(device.name || "a device");
    if (Array.isArray(config.profiles)) config.profiles = config.profiles.filter((p) => p?.deviceId !== device.id);
    return false;
  });
  return dropped;
}

module.exports = {
  VERSION,
  TYPES,
  FILTERED_TYPES,
  emptyConfig,
  validateConfig,
  loadConfig,
  saveConfig,
  backupConfig,
  normalizeFolder,
  relativePath,
  extensionList,
  profileFor,
  ensureProfiles,
  saveFolder,
  removeFolder,
  setTypeFilters,
  setDestination,
  setOverride,
  setFolderSelection,
  setItemSelection,
  folderRule,
  itemSelected,
  hasSelection,
  inBranch,
  gaps,
  renameDevice,
  removeDevice,
  setWeb,
  setProfileOption,
  setScraping,
  emptyWeb,
};
