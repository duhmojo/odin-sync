// Builds the sync plan: which local files go where on the device, and how each
// compares with what is already there.
const { destination } = require("./core.cjs");
const { hasSelection, inBranch } = require("./config.cjs");
const fs = require("node:fs/promises");
const { selectedFiles } = require("./catalog.cjs");
const { TEMP_NAME } = require("./transfer.cjs");

const LISTING_END = "__ODIN_SYNC_LISTING_END__";

function posixJoin(base, rest) {
  return rest ? base.replace(/\/$/, "") + "/" + rest : base;
}

// The deepest override at or above `relative` wins; otherwise the folder's
// destination. The override path is where that subfolder or game itself goes.
function targetFor(profile, folderId, relative) {
  const overrides = profile.overrides[folderId] || {};
  let chosen = null;
  for (const key of Object.keys(overrides)) {
    if (key && inBranch(relative, key) && (!chosen || key.length > chosen.length)) chosen = key;
  }
  if (chosen) {
    const rest = relative === chosen ? "" : relative.slice(chosen.length + 1);
    return { root: overrides[chosen], target: destination(posixJoin(overrides[chosen], rest)) };
  }
  const base = profile.destinations[folderId];
  return { root: base, target: destination(posixJoin(base, relative)) };
}

// Resolves the device profile into files. Folders with a selection but no
// destination are reported as blocked; problems with single files are warnings.
// keepFolders lists folders whose device files must not be removed this time
// (blocked, or the folder on the PC is unavailable).
async function resolvePlanFiles(config, deviceId, options = {}) {
  const list = options.selectedFiles || selectedFiles;
  const cancelled = options.cancelled || (() => false);
  const profile = config.profiles.find((p) => p.deviceId === deviceId);
  const warnings = [];
  const blocked = [];
  const files = [];
  const roots = new Set();
  const keepFolders = new Set();
  if (!profile) return { files, warnings, blocked, roots: [], keepFolders };
  const targets = new Map();
  for (const folder of config.folders) {
    if (cancelled()) throw new Error("Stopped.");
    const available = await fs
      .access(folder.path)
      .then(() => true)
      .catch(() => false);
    if (!available) keepFolders.add(folder.id);
    if (!hasSelection(profile, folder.id)) continue;
    if (!profile.destinations[folder.id]) {
      blocked.push({ folderId: folder.id, folder: folder.name });
      keepFolders.add(folder.id);
      continue;
    }
    const found = await list(folder, profile.selections[folder.id], config.typeFilters, warnings);
    for (const file of found) {
      let resolved;
      try {
        resolved = targetFor(profile, folder.id, file.relative);
      } catch (error) {
        warnings.push({
          folderId: folder.id,
          folder: folder.name,
          file: file.relative,
          message: error.message,
        });
        continue;
      }
      const key = resolved.target.toLowerCase();
      const previous = targets.get(key);
      if (previous) {
        if (previous !== file.source) {
          warnings.push({
            folderId: folder.id,
            folder: folder.name,
            file: file.relative,
            message: `Skipped: another selected file also goes to ${resolved.target}.`,
          });
        }
        continue;
      }
      targets.set(key, file.source);
      roots.add(resolved.root);
      files.push({
        folderId: folder.id,
        folder: folder.name,
        type: folder.type,
        itemId: file.itemId,
        root: resolved.root,
        unitRoot: folder.type === "games" ? targetFor(profile, folder.id, file.itemId).target : "",
        relative: file.relative,
        source: file.source,
        size: file.size,
        mtime: file.mtime,
        target: resolved.target,
      });
    }
  }
  files.sort((a, b) => a.target.localeCompare(b.target));
  return { files, warnings, blocked, roots: minimalRoots([...roots]), keepFolders };
}

// Drops roots that sit inside another root, so each device folder is listed once.
function minimalRoots(roots) {
  const sorted = [...new Set(roots)].sort((a, b) => a.length - b.length);
  const result = [];
  for (const root of sorted) {
    const lower = root.toLowerCase();
    if (result.some((r) => lower === r.toLowerCase() || lower.startsWith(r.toLowerCase() + "/"))) {
      continue;
    }
    result.push(root);
  }
  return result;
}

function parseListing(output) {
  const text = output.replace(/\r/g, "");
  if (!text.trimEnd().endsWith(LISTING_END)) {
    throw new Error("The device file listing was incomplete. Check the connection and try again.");
  }
  const remote = new Map();
  // This app's own leftover temporary files, by their exact path.
  remote.temps = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^(\d+)\|(\/.*)$/);
    if (!match) continue;
    if (TEMP_NAME.test(match[2])) {
      remote.temps.push({ path: match[2], size: Number(match[1]) });
      continue;
    }
    remote.set(match[2].toLowerCase(), Number(match[1]));
  }
  return remote;
}

async function deviceSpace(adb, roots) {
  if (!roots.length) return [];
  try {
    // {root, total, available, mount} per root, measured by the app.
    return await adb.space(roots);
  } catch {
    return [];
  }
}

function spaceKey(options) {
  return `${options.replaceDifferent ? "replace" : "keep"}-${options.remove ? "remove" : "stay"}`;
}

// Room kept free on every volume, on top of what the sync needs.
const SPACE_MARGIN = 100 * 1024 * 1024;

// Bytes each volume needs for a sync with the given choices. Removals run
// first and free space; a replaced file needs only its growth, plus room for
// the largest temporary copy.
function spaceNeeds(entries, space, options = {}) {
  const byRoot = new Map(space.map((s) => [s.root, s]));
  const mounts = new Map();
  for (const s of space) {
    if (!mounts.has(s.mount)) {
      mounts.set(s.mount, {
        mount: s.mount,
        available: s.available,
        total: s.total,
        needed: 0,
        temp: 0,
      });
    }
  }
  for (const entry of entries) {
    const volume = byRoot.get(entry.root);
    if (!volume) continue;
    const m = mounts.get(volume.mount);
    if (entry.action === "Add") m.needed += entry.size;
    const replaced =
      entry.action === "Update" || (entry.action === "Different" && options.replaceDifferent);
    if (replaced) {
      m.needed += Math.max(0, entry.size - (entry.remoteSize || 0));
      m.temp = Math.max(m.temp, entry.size);
    }
    if (entry.action === "Remove" && options.remove) m.needed -= entry.size;
  }
  return [...mounts.values()].map((m) => {
    const needed = Math.max(0, m.needed) + m.temp;
    return {
      mount: m.mount,
      available: m.available,
      total: m.total,
      needed,
      short: needed > 0 && needed + SPACE_MARGIN > m.available,
    };
  });
}

async function listRemote(adb, roots) {
  if (!roots.length) return new Map();
  return parseListing(await adb.listing(roots));
}

// Add: missing on the device. Unchanged: same size. Update: a file this app
// copied earlier that changed on the PC. Different: a file the app did not copy
// is there with another size (replaced only when the user chooses).
function compare(files, remote, managed = () => null) {
  return files.map((file) => {
    const remoteSize = remote.get(file.target.toLowerCase());
    let action = "Add";
    if (remoteSize !== undefined) {
      const known = managed(file.target);
      if (remoteSize === file.size) action = "Unchanged";
      else if (known && known.size === remoteSize) action = "Update";
      else action = "Different";
    }
    // restore: this app copied it before and it was deleted on the device since.
    const restore = action === "Add" && !!managed(file.target);
    return { ...file, action, remoteSize: remoteSize ?? null, ...(restore ? { restore } : {}) };
  });
}

// Inventory entries that are no longer planned: candidates for removal.
function removalCandidates(inventoryEntries, files, keepFolders) {
  const planned = new Set(files.map((f) => f.target.toLowerCase()));
  return inventoryEntries.filter(
    (entry) => !planned.has(entry.target.toLowerCase()) && !keepFolders.has(entry.folderId),
  );
}

// Device folders to list so removal candidates can be checked.
function candidateRoots(candidates) {
  return candidates.map(
    (c) => c.root || c.unitRoot || c.target.slice(0, c.target.lastIndexOf("/")),
  );
}

function unitKey(entry) {
  return JSON.stringify([entry.folderId, entry.itemId]);
}

// Decides what to remove. A file is removed only if it is still on the device
// with the size the app copied. An item (a game, a CUE/M3U set) is removed as a
// whole or not at all; a game folder that also holds files the app did not copy
// is left in place.
function planRemovals(candidates, remote, inventoryEntries) {
  const remove = [];
  const kept = [];
  const gone = [];
  const units = new Map();
  for (const entry of candidates) {
    if (!units.has(unitKey(entry))) units.set(unitKey(entry), []);
    units.get(unitKey(entry)).push(entry);
  }
  const managed = new Set(inventoryEntries.map((e) => e.target.toLowerCase()));
  for (const unit of units.values()) {
    const present = unit.filter((e) => remote.has(e.target.toLowerCase()));
    gone.push(...unit.filter((e) => !remote.has(e.target.toLowerCase())));
    if (!present.length) continue;
    const changed = present.filter((e) => remote.get(e.target.toLowerCase()) !== e.size);
    let reason = "";
    if (changed.length)
      reason = `${changed.length} file(s) changed on the device since they were copied`;
    const unitRoot = unit[0].unitRoot;
    if (!reason && unitRoot) {
      const prefix = unitRoot.toLowerCase() + "/";
      const extra = [...remote.keys()].filter((p) => p.startsWith(prefix) && !managed.has(p));
      if (extra.length) reason = `has ${extra.length} extra file(s) the app did not copy`;
    }
    const base = (e) => ({ ...e, remoteSize: remote.get(e.target.toLowerCase()) });
    if (reason)
      kept.push({
        folderId: unit[0].folderId,
        folder: unit[0].folder,
        itemId: unit[0].itemId,
        reason,
        files: present.map(base),
      });
    else remove.push(...present.map((e) => ({ ...base(e), action: "Remove" })));
  }
  return { remove, kept, gone };
}

// Lists the device once and compares it with the resolved plan and the
// inventory: copies to make, and inventory files to remove or keep.
async function checkDevice(resolved, adb, inventoryEntries) {
  const byTarget = new Map(inventoryEntries.map((e) => [e.target.toLowerCase(), e]));
  const candidates = removalCandidates(inventoryEntries, resolved.files, resolved.keepFolders);
  const roots = minimalRoots([...resolved.roots, ...candidateRoots(candidates)]);
  const remote = await listRemote(adb, roots);
  const copies = compare(resolved.files, remote, (target) => byTarget.get(target.toLowerCase()));
  const removals = planRemovals(candidates, remote, inventoryEntries);
  const entries = [...copies, ...removals.remove];
  const spaceRoots = [...new Set(entries.map((e) => e.root).filter(Boolean))];
  const space = await deviceSpace(adb, spaceRoots);
  // Needs for each combination of the review's two options ("replace" + "remove").
  const needs = {};
  for (const replaceDifferent of [false, true]) {
    for (const remove of [false, true]) {
      needs[spaceKey({ replaceDifferent, remove })] = spaceNeeds(entries, space, {
        replaceDifferent,
        remove,
      });
    }
  }
  return {
    entries,
    space: needs,
    temps: remote.temps || [],
    kept: removals.kept,
    gone: removals.gone.map((e) => e.target),
    warnings: resolved.warnings,
    blocked: resolved.blocked,
    summary: summarize(entries),
  };
}

function summarize(entries) {
  const summary = {};
  for (const action of ["Add", "Update", "Different", "Unchanged", "Remove"]) {
    const matching = entries.filter((e) => e.action === action);
    summary[action] = { count: matching.length, bytes: matching.reduce((n, e) => n + e.size, 0) };
  }
  return summary;
}

module.exports = {
  LISTING_END,
  targetFor,
  resolvePlanFiles,
  minimalRoots,
  parseListing,
  listRemote,
  compare,
  removalCandidates,
  candidateRoots,
  planRemovals,
  checkDevice,
  spaceNeeds,
  spaceKey,
  SPACE_MARGIN,
  summarize,
};
