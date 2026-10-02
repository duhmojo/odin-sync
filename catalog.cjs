// Local library: lists a local folder the way its type dictates, and resolves a
// device profile's selection into the concrete files to sync.
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  relativePath,
  extensionList,
  folderRule,
  itemSelected,
  inBranch,
  FILTERED_TYPES,
} = require("./config.cjs");

const STAT_BATCH = 64;

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function join(...parts) {
  return parts.filter(Boolean).join("/");
}

function parentOf(relative) {
  return relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "";
}

// Folder-level and type-wide filters. Games never have filters.
function compileFilters(folder, typeFilters = {}) {
  const result = { folders: [], files: [], extensions: [] };
  if (folder.type === "games") return result;
  const typeWide = FILTERED_TYPES.includes(folder.type) ? typeFilters[folder.type] || {} : {};
  for (const [key, list] of [
    ["excludeFolders", result.folders],
    ["excludeFiles", result.files],
  ]) {
    for (const pattern of [folder[key], typeWide[key]]) {
      if (pattern && pattern.trim()) list.push(new RegExp(pattern, "i"));
    }
  }
  result.extensions = extensionList(folder);
  return result;
}

function folderHidden(filters, name) {
  return filters.folders.some((regex) => regex.test(name));
}

function fileMatches(filters, name) {
  if (filters.files.some((regex) => regex.test(name))) return false;
  if (!filters.extensions.length) return true;
  return filters.extensions.includes(path.extname(name).toLowerCase());
}

async function resolveInside(root, relative) {
  const target = await fs.realpath(path.join(root, ...relative.split("/").filter(Boolean)));
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error("That folder resolves outside its local folder.");
  }
  return target;
}

async function statFiles(directory, dirRelative, names) {
  const result = [];
  for (let i = 0; i < names.length; i += STAT_BATCH) {
    const batch = names.slice(i, i + STAT_BATCH);
    const stats = await Promise.all(
      batch.map((name) => fs.stat(path.join(directory, name)).catch(() => null)),
    );
    batch.forEach((name, index) => {
      const stat = stats[index];
      if (!stat || !stat.isFile()) return;
      result.push({
        name,
        relative: join(dirRelative, name),
        source: path.join(directory, name),
        size: stat.size,
        mtime: Math.floor(stat.mtimeMs / 1000),
      });
    });
  }
  return result;
}

function unsupportedName(name) {
  return /[\r\n\0]/.test(name);
}

// Operating-system metadata is never part of a library. macOS metadata is
// skipped everywhere, including inside games; Windows thumbnails and folder
// settings are skipped outside games.
const MAC_FOLDERS = new Set([
  "__macosx",
  ".spotlight-v100",
  ".trashes",
  ".fseventsd",
  ".temporaryitems",
  ".documentrevisions-v100",
]);
const WINDOWS_FILES = new Set(["thumbs.db", "desktop.ini"]);

function systemFolder(name) {
  return MAC_FOLDERS.has(name.toLowerCase());
}

function systemFile(name, type) {
  const lower = name.toLowerCase();
  if (lower === ".ds_store" || name.startsWith("._")) return true;
  return type !== "games" && WINDOWS_FILES.has(lower);
}

// ---- CUE / M3U grouping (ROMs only) ----

function playlistReferences(extension, text) {
  if (extension === ".cue") {
    return [...text.matchAll(/^\s*FILE\s+(?:"([^"]+)"|(\S+))/gim)].map((m) => m[1] || m[2]);
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith(";"));
}

// Collects a playlist and everything it references (recursively), as one unit.
async function collectGroup(root, file, sameDir, seen = new Set(), stack = new Set()) {
  if (stack.has(file.relative)) {
    throw new Error(`Circular playlist reference involving ${file.relative}.`);
  }
  if (seen.has(file.relative)) return [];
  seen.add(file.relative);
  const extension = path.extname(file.relative).toLowerCase();
  const files = [file];
  if (extension !== ".cue" && extension !== ".m3u") return files;
  const text = await fs.readFile(file.source, "utf8");
  const references = playlistReferences(extension, text);
  if (!references.length) {
    throw new Error(`${file.relative} has no game file references; skipped.`);
  }
  const nextStack = new Set([...stack, file.relative]);
  for (const reference of references) {
    const cleaned = reference.replace(/\\/g, "/");
    if (path.posix.isAbsolute(cleaned) || /^[a-z]:/i.test(cleaned)) {
      throw new Error(`${file.relative} references content outside its local folder.`);
    }
    const relative = path.posix.normalize(path.posix.join(parentOf(file.relative), cleaned));
    if (relative.startsWith("../") || relative === "..") {
      throw new Error(`${file.relative} references content outside its local folder.`);
    }
    let dependency = sameDir.get(relative.toLowerCase());
    if (!dependency) dependency = await statReference(root, relative);
    if (!dependency) throw new Error(`${file.relative} references missing file ${reference}.`);
    files.push(...(await collectGroup(root, dependency, sameDir, seen, nextStack)));
  }
  return files;
}

async function statReference(root, relative) {
  const target = path.join(root, ...relative.split("/"));
  try {
    const real = await fs.realpath(target);
    if (!real.startsWith(root + path.sep)) return null;
    const stat = await fs.stat(real);
    if (!stat.isFile()) return null;
    return {
      name: path.posix.basename(relative),
      relative,
      source: real,
      size: stat.size,
      mtime: Math.floor(stat.mtimeMs / 1000),
    };
  } catch {
    return null;
  }
}

function makeItem(folder, dirRelative, files) {
  const primary = files[0];
  return {
    id: primary.relative,
    name: primary.name,
    folder: dirRelative,
    kind: "file",
    files: files.map(({ relative, source, size, mtime }) => ({ relative, source, size, mtime })),
    size: files.reduce((sum, f) => sum + f.size, 0),
  };
}

// Reads one directory of a non-games folder: its subfolders and its items.
async function readDirectory(folder, root, dirRelative, filters, warnings) {
  const directory = await resolveInside(root, dirRelative);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const result = { folders: [], items: [], hidden: { folders: 0, files: 0 } };
  const fileNames = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || unsupportedName(entry.name)) continue;
    if (entry.isDirectory()) {
      if (!folder.includeSubfolders || systemFolder(entry.name)) continue;
      if (folderHidden(filters, entry.name)) {
        result.hidden.folders++;
        continue;
      }
      result.folders.push({ name: entry.name, relative: join(dirRelative, entry.name) });
    } else if (entry.isFile() && !systemFile(entry.name, folder.type)) {
      fileNames.push(entry.name);
    }
  }
  const allFiles = await statFiles(directory, dirRelative, fileNames);
  const sameDir = new Map(allFiles.map((f) => [f.relative.toLowerCase(), f]));
  const candidates = allFiles.filter((f) => fileMatches(filters, f.name));
  result.hidden.files = allFiles.length - candidates.length;
  const groups = [];
  const referenced = new Set();
  for (const file of candidates) {
    if (folder.type !== "roms") {
      groups.push([file]);
      continue;
    }
    try {
      const group = await collectGroup(root, file, sameDir);
      for (const member of group.slice(1)) referenced.add(member.relative.toLowerCase());
      groups.push(group);
    } catch (error) {
      warnings.push({
        folderId: folder.id,
        folder: folder.name,
        file: file.relative,
        message: error.message,
      });
    }
  }
  for (const group of groups) {
    if (referenced.has(group[0].relative.toLowerCase())) continue;
    result.items.push(makeItem(folder, dirRelative, group));
  }
  result.folders.sort((a, b) => compareNames(a.name, b.name));
  result.items.sort((a, b) => compareNames(a.name, b.name));
  return result;
}

function compareNames(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

// Games: each immediate subfolder of the local folder is one game.
async function readGames(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter(
      (e) =>
        e.isDirectory() && !e.isSymbolicLink() && !unsupportedName(e.name) && !systemFolder(e.name),
    )
    .map((e) => ({ id: e.name, name: e.name, folder: "", kind: "game", files: null, size: null }))
    .sort((a, b) => compareNames(a.name, b.name));
}

async function listFolder(folder, relative = "", typeFilters = {}) {
  if (relative !== "") relativePath(relative);
  const root = await fs.realpath(folder.path);
  const warnings = [];
  if (folder.type === "games") {
    if (relative) throw new Error("Games are listed one level deep; open the Games folder itself.");
    const items = await readGames(root);
    return { relative, folders: [], items, hidden: { folders: 0, files: 0 }, warnings };
  }
  if (relative && !folder.includeSubfolders) {
    throw new Error("Subfolders are turned off for this local folder.");
  }
  const filters = compileFilters(folder, typeFilters);
  const listing = await readDirectory(folder, root, relative, filters, warnings);
  return { relative, ...listing, warnings };
}

// All files inside a game folder, recursively and unfiltered.
async function gameFiles(root, name) {
  relativePath(name);
  if (name.includes("/")) throw new Error("Invalid game folder.");
  const top = await resolveInside(root, name);
  const files = [];
  async function walk(directory, dirRelative) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const names = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() ? systemFolder(entry.name) : systemFile(entry.name, "games"))
        continue;
      if (unsupportedName(entry.name)) {
        throw new Error(`${join(dirRelative, entry.name)} has an unsupported file name.`);
      }
      if (entry.isDirectory())
        await walk(path.join(directory, entry.name), join(dirRelative, entry.name));
      else if (entry.isFile()) names.push(entry.name);
    }
    for (const file of await statFiles(directory, dirRelative, names)) {
      files.push({
        relative: file.relative,
        source: file.source,
        size: file.size,
        mtime: file.mtime,
      });
    }
  }
  await walk(top, name);
  return files;
}

async function gameSizes(folder, names) {
  const root = await fs.realpath(folder.path);
  const sizes = {};
  for (const name of names) {
    try {
      const files = await gameFiles(root, name);
      sizes[name] = { size: files.reduce((sum, f) => sum + f.size, 0), files: files.length };
    } catch (error) {
      sizes[name] = { error: error.message };
    }
  }
  return sizes;
}

// True when any rule or chosen item selects something inside `branch`.
function branchHasSelection(selection, branch) {
  if (folderRule(selection, branch)) return true;
  for (const [folder, value] of Object.entries(selection.folders)) {
    if (value && inBranch(folder, branch)) return true;
  }
  return selection.items.some((id) => inBranch(id, branch));
}

// Resolves one local folder's selection into files: [{relative, source, size, mtime, itemId}].
async function selectedFiles(folder, selection, typeFilters = {}, warnings = []) {
  const found = new Set();
  const files = [];
  const warn = (file, message) =>
    warnings.push({ folderId: folder.id, folder: folder.name, file, message });
  let root;
  try {
    root = await fs.realpath(folder.path);
  } catch (error) {
    warn("", `Local folder is unavailable: ${error.message}`);
    return files;
  }
  if (folder.type === "games") {
    const games = await readGames(root);
    for (const game of games) {
      if (!itemSelected(selection, game.id, "")) continue;
      found.add(game.id);
      try {
        for (const file of await gameFiles(root, game.id)) files.push({ ...file, itemId: game.id });
      } catch (error) {
        warn(game.id, error.message);
      }
    }
  } else {
    const filters = compileFilters(folder, typeFilters);
    async function visit(dirRelative) {
      let listing;
      try {
        listing = await readDirectory(folder, root, dirRelative, filters, warnings);
      } catch (error) {
        warn(dirRelative, `Folder could not be read: ${error.message}`);
        return;
      }
      for (const item of listing.items) {
        if (!itemSelected(selection, item.id, dirRelative)) continue;
        found.add(item.id);
        for (const file of item.files) files.push({ ...file, itemId: item.id });
      }
      for (const sub of listing.folders) {
        if (branchHasSelection(selection, sub.relative)) await visit(sub.relative);
      }
    }
    await visit("");
  }
  for (const id of selection.items) {
    if (!found.has(id))
      warn(id, "Selected item was not found (renamed, moved or filtered out); skipped.");
  }
  return files;
}

// Every item of a local folder (all subfolders for ROMs and files, every
// game for Games), as the Library would list them.
async function allItems(folder, typeFilters = {}, relative = "") {
  const listing = await listFolder(folder, relative, typeFilters);
  const items = [...listing.items];
  for (const sub of listing.folders)
    items.push(...(await allItems(folder, typeFilters, sub.relative)));
  return items;
}

module.exports = {
  compileFilters,
  listFolder,
  allItems,
  gameSizes,
  gameFiles,
  selectedFiles,
  branchHasSelection,
  playlistReferences,
};
