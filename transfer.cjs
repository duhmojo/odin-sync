// Copies planned files to the device through the Odin Sync app, with progress,
// verification and a log. Each file is received under a temporary name, its
// SHA-256 checked against what was sent, and only then moved into place.
const fs = require("node:fs/promises");
const path = require("node:path");

const REMOVE_BATCH = 200;
const MIN_SPEED_SECONDS = 3;

// The app's temporary names (target.odin-sync-<uuid>.part); nothing else is
// ever treated as ours.
const TEMP_NAME = /\.odin-sync-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.part$/;

// Creates every destination folder, a few hundred per request.
async function makeFolders(adb, entries) {
  const folders = [...new Set(entries.map((e) => path.posix.dirname(e.target)))].sort();
  for (let i = 0; i < folders.length; i += 500) await adb.mkdirs(folders.slice(i, i + 500));
}
class Speedometer {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.samples = [];
  }
  add(totalBytes) {
    const time = this.now();
    this.samples.push({ time, bytes: totalBytes });
    while (this.samples.length > 2 && time - this.samples[0].time > 8000) this.samples.shift();
  }
  // Zero until there are a few seconds of samples, so an early burst of tiny
  // files does not produce a wild estimate.
  bytesPerSecond() {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0];
    const last = this.samples.at(-1);
    const seconds = (last.time - first.time) / 1000;
    if (seconds < MIN_SPEED_SECONDS) return 0;
    return (last.bytes - first.bytes) / seconds;
  }
}

// Errors that mean the connection to the device is gone, as opposed to a
// problem with one file.
const TRANSPORT_ERRORS =
  /connection reset|broken pipe|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EPIPE|socket hang up|not open on the device|did not answer in time|aborted/i;

function isTransportError(error) {
  return TRANSPORT_ERRORS.test(String(error?.message || error));
}

class DisconnectedError extends Error {
  constructor(message) {
    super(message || "The device disconnected.");
  }
}

async function copyOne(adb, entry, options, onBytes) {
  const current = await fs.stat(entry.source).catch(() => null);
  if (!current || !current.isFile()) throw new Error("The local file is no longer available.");
  if (current.size !== entry.size)
    throw new Error("The local file changed since the check. Check again.");
  return uploadOne(adb, entry, options, onBytes, current);
}

// The receiver app writes to its own temporary name and hashes while it
// writes; the client hashes while it sends and commits only if they agree.
async function uploadOne(client, entry, options, onBytes, current) {
  try {
    await client.upload(entry.source, entry.target, entry.size, Math.floor(current.mtimeMs / 1000), (bytes) =>
      onBytes(Math.min(bytes, entry.size)),
    );
  } catch (error) {
    if (isTransportError(error)) throw new DisconnectedError(error.message);
    throw error;
  }
}

// entries: planned files with action Add/Different/Unchanged.
// Returns {results, copiedBytes, stopped}.
async function runSync(entries, adb, options = {}) {
  const settings = {
    replaceDifferent: false,
    onProgress: () => {},
    cancelled: () => false,
    now: () => Date.now(),
    ...options,
  };
  const queue = entries.filter(
    (e) =>
      e.action === "Add" ||
      e.action === "Update" ||
      (e.action === "Different" && settings.replaceDifferent),
  );
  const removals = settings.remove ? entries.filter((e) => e.action === "Remove") : [];
  const handled = new Set([...queue, ...removals]);
  const skipReasons = {
    Unchanged: "Already on the device (same size).",
    Different: "Different on the device; not replaced.",
    Remove: "No longer in the profile; left on the device (removal not chosen).",
  };
  const results = entries
    .filter((e) => !handled.has(e))
    .map((e) => ({ ...resultBase(e), status: "skipped", reason: skipReasons[e.action] }));
  let disconnected = "";
  const orphans = [];
  if (removals.length && !settings.cancelled()) {
    settings.onProgress({
      phase: "Removing unselected files",
      fileIndex: 0,
      fileCount: removals.length,
    });
    const removal = await removeFiles(adb, removals);
    results.push(...removal.results);
    if (removal.disconnected) disconnected = removal.disconnected;
  }
  const totalBytes = queue.reduce((n, e) => n + e.size, 0);
  const speed = new Speedometer(settings.now);
  let doneBytes = 0;
  let stopped = false;
  const report = (index, entry, fileBytes, phase = "Transferring") => {
    const moved = doneBytes + fileBytes;
    speed.add(moved);
    const rate = speed.bytesPerSecond();
    settings.onProgress({
      phase,
      fileIndex: index + 1,
      fileCount: queue.length,
      file: entry.relative,
      target: entry.target,
      fileBytes,
      fileSize: entry.size,
      doneBytes: moved,
      totalBytes,
      bytesPerSecond: rate,
      secondsLeft: rate > 0 ? Math.ceil((totalBytes - moved) / rate) : null,
    });
  };
  if (queue.length && !settings.cancelled() && !disconnected) {
    settings.onProgress({
      phase: "Preparing folders",
      fileIndex: 0,
      fileCount: queue.length,
      doneBytes: 0,
      totalBytes,
    });
    try {
      await makeFolders(adb, queue);
    } catch (error) {
      if (!isTransportError(error)) throw error;
      disconnected = error.message;
    }
  }
  for (const [index, entry] of queue.entries()) {
    const base = resultBase(entry);
    if (disconnected) {
      results.push({
        ...base,
        status: "skipped",
        reason: "The device disconnected before this file.",
      });
      continue;
    }
    if (stopped || settings.cancelled()) {
      stopped = true;
      results.push({ ...base, status: "skipped", reason: "Sync was stopped before this file." });
      continue;
    }
    report(index, entry, 0);
    try {
      await copyOne(adb, entry, settings, (bytes) => report(index, entry, bytes));
      doneBytes += entry.size;
      report(index, entry, 0, "Copied");
      results.push({ ...base, status: "copied", replaced: entry.action !== "Add" });
    } catch (error) {
      if (error instanceof DisconnectedError) {
        // Not a problem with this file: it is copied again on resume.
        disconnected = error.message;
        if (error.temporary) orphans.push(error.temporary);
        results.push({
          ...base,
          status: "skipped",
          reason: "The device disconnected during this file.",
        });
        continue;
      }
      doneBytes += entry.size;
      report(index, entry, 0, "Failed");
      results.push({ ...base, status: "failed", reason: error.message });
    }
  }
  return {
    results,
    stopped,
    disconnected,
    orphans,
    copiedBytes: results.filter((r) => r.status === "copied").reduce((n, r) => n + r.size, 0),
  };
}

// What a result records about its file; enough to update the inventory.
function resultBase(entry) {
  return {
    relative: entry.relative,
    folder: entry.folder,
    folderId: entry.folderId,
    itemId: entry.itemId,
    target: entry.target,
    size: entry.size,
    root: entry.root || "",
    unitRoot: entry.unitRoot || "",
  };
}

// Removes each file only if it is still a regular file with the size the app
// copied, then removes folders inside the destination root that became empty.
// rmdir never removes a folder that still has content.
async function removeFiles(adb, entries) {
  const results = [];
  const removed = [];
  let disconnected = "";
  for (let start = 0; start < entries.length; start += REMOVE_BATCH) {
    const batch = entries.slice(start, start + REMOVE_BATCH);
    // The app removes a file only if it still has the size the app copied.
    let deleted = new Set();
    if (!disconnected) {
      try {
        const answer = await adb.remove(batch.map((entry) => ({ path: entry.target, size: Number(entry.size) })));
        deleted = new Set(answer.removed);
      } catch (error) {
        if (isTransportError(error)) disconnected = error.message;
      }
    }
    for (const [index, entry] of batch.entries()) {
      if (deleted.has(index)) {
        removed.push(entry);
        results.push({ ...resultBase(entry), status: "removed" });
      } else {
        results.push({
          ...resultBase(entry),
          status: "kept",
          reason: disconnected
            ? "Not removed: the device disconnected."
            : "Not removed: the file changed or could not be removed.",
        });
      }
    }
  }
  const folders = new Set();
  for (const entry of removed) {
    const root = (entry.root || "").replace(/\/$/, "");
    let folder = path.posix.dirname(entry.target);
    while (root && folder.startsWith(root + "/")) {
      folders.add(folder);
      folder = path.posix.dirname(folder);
    }
  }
  const deepestFirst = [...folders].sort((a, b) => b.split("/").length - a.split("/").length);
  // The app removes only folders that are empty.
  for (let i = 0; i < deepestFirst.length; i += 100) {
    await adb.rmdirs(deepestFirst.slice(i, i + 100)).catch(() => {});
  }
  return { results, disconnected };
}

module.exports = {
  runSync,
  isTransportError,
  TEMP_NAME,
  DisconnectedError,
  makeFolders,
  removeFiles,
  Speedometer,
};
