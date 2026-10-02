// Per-device inventory: every file this app copied to a device, so a sync can
// later remove what was unselected. Files the app did not copy are never in it
// and are therefore never removed.
const fs = require("node:fs/promises");
const path = require("node:path");

const VERSION = 1;

function fileName(deviceId) {
  if (!/^[\w-]+$/.test(deviceId)) throw new Error("Invalid device id.");
  return `inventory-${deviceId}.json`;
}

function empty(deviceId) {
  return { version: VERSION, deviceId, files: {} };
}

function key(target) {
  return target.toLowerCase();
}

// Seeds a new inventory from earlier sync logs of this device (logs written
// before inventories existed), so files copied then can be managed too.
async function fromLogs(dataDir, deviceId, config) {
  const inventory = empty(deviceId);
  let names = [];
  try {
    names = (await fs.readdir(dataDir)).filter((n) => /^sync-log-.*\.json$/.test(n)).sort();
  } catch {
    return inventory;
  }
  for (const name of names) {
    let log;
    try {
      log = JSON.parse(await fs.readFile(path.join(dataDir, name), "utf8"));
    } catch {
      continue;
    }
    if (log?.device?.id !== deviceId || !Array.isArray(log.results)) continue;
    for (const result of log.results) {
      if (result.status !== "copied" || typeof result.target !== "string") continue;
      const folder = config.folders.find(
        (f) => f.id === result.folderId || f.name === result.folder,
      );
      if (!folder) continue;
      const relative = String(result.relative || "");
      const itemId = result.itemId || (folder.type === "games" ? relative.split("/")[0] : relative);
      record(inventory, {
        target: result.target,
        size: result.size,
        folderId: folder.id,
        folder: folder.name,
        itemId,
        relative,
        root: result.root || "",
        unitRoot: result.unitRoot || "",
        syncedAt: log.finishedAt || "",
      });
    }
  }
  return inventory;
}

async function load(dataDir, deviceId, config) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dataDir, fileName(deviceId)), "utf8"));
    if (parsed?.version === VERSION && parsed.files && typeof parsed.files === "object")
      return parsed;
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  return fromLogs(dataDir, deviceId, config);
}

async function save(dataDir, inventory) {
  const file = path.join(dataDir, fileName(inventory.deviceId));
  await fs.writeFile(file + ".tmp", JSON.stringify(inventory, null, 1));
  await fs.rename(file + ".tmp", file);
}

async function remove(dataDir, deviceId) {
  await fs.rm(path.join(dataDir, fileName(deviceId)), { force: true });
}

function record(inventory, entry) {
  inventory.files[key(entry.target)] = {
    target: entry.target,
    size: entry.size,
    folderId: entry.folderId,
    folder: entry.folder || "",
    itemId: entry.itemId,
    relative: entry.relative,
    root: entry.root || "",
    unitRoot: entry.unitRoot || "",
    syncedAt: entry.syncedAt || new Date().toISOString(),
  };
}

// Updates the inventory from sync results: copied files are added, removed
// files and files no longer found on the device are dropped.
function apply(inventory, results, gone = []) {
  for (const target of gone) forget(inventory, target);
  for (const result of results) {
    if (result.status === "copied") record(inventory, result);
    if (result.status === "removed") forget(inventory, result.target);
  }
  return inventory;
}

function forget(inventory, target) {
  delete inventory.files[key(target)];
}

function has(inventory, target) {
  return !!inventory.files[key(target)];
}

function get(inventory, target) {
  return inventory.files[key(target)] || null;
}

function entries(inventory) {
  return Object.values(inventory.files);
}

module.exports = { load, save, remove, record, apply, forget, has, get, entries, empty, fileName };
