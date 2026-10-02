// Sync: check the device against its profile, review what will change, run it.
const REVIEW_PAGE = 100;
const sync = { plan: null, page: 0, running: false, checking: false, result: null, last: null };

const actionLabels = {
  Add: "New",
  Update: "Updated on the PC",
  Different: "Different on device",
  Unchanged: "Already on device",
  Remove: "No longer in profile",
};

function willCopy(entry) {
  if (entry.action === "Add" || entry.action === "Update") return true;
  return entry.action === "Different" && $("sync-replace").checked;
}

function willRemove(entry) {
  return entry.action === "Remove" && $("sync-remove").checked;
}

function statusLabel(entry) {
  if (entry.restore) return "Will be restored (deleted on device)";
  if (entry.action === "Different" && willCopy(entry)) return "Will replace";
  if (entry.action === "Remove") return willRemove(entry) ? "Will remove" : "Stays (not removing)";
  return actionLabels[entry.action];
}

function filteredEntries() {
  if (!sync.plan) return [];
  const filter = $("sync-filter").value;
  const query = $("sync-search").value.trim().toLowerCase();
  return sync.plan.entries.filter((entry) => {
    if (filter === "changes" && !willCopy(entry) && entry.action !== "Remove") return false;
    if (!["changes", "all"].includes(filter) && entry.action !== filter) return false;
    return !query || `${entry.relative} ${entry.target}`.toLowerCase().includes(query);
  });
}

function listsFiles(folderId, type) {
  const folder = folderById(folderId);
  return folder ? (folder.listFiles ?? folder.type !== "games") : type !== "games";
}

function dirname(target) {
  return target.slice(0, target.lastIndexOf("/"));
}

// Rows for the review: one row per game (or per item when the folder does not
// list files), otherwise files grouped under their destination folder.
function reviewRows(entries) {
  const rows = [];
  const units = new Map();
  const folders = new Map();
  for (const entry of entries) {
    if (!listsFiles(entry.folderId, entry.type)) {
      const key = JSON.stringify([entry.folderId, entry.itemId]);
      if (!units.has(key)) {
        units.set(key, { kind: "unit", entry, files: [] });
        rows.push(units.get(key));
      }
      units.get(key).files.push(entry);
    } else {
      const folder = dirname(entry.target);
      if (!folders.has(folder)) {
        folders.set(folder, { kind: "folder", path: folder, files: [] });
        rows.push(folders.get(folder));
      }
      folders.get(folder).files.push(entry);
    }
  }
  const flat = [];
  for (const row of rows) {
    if (row.kind === "unit") flat.push(row);
    else {
      flat.push({ kind: "header", path: row.path, files: row.files });
      for (const entry of row.files) flat.push({ kind: "file", entry });
    }
  }
  return flat;
}

function unitStatus(files) {
  const counts = {};
  for (const entry of files) counts[statusLabel(entry)] = (counts[statusLabel(entry)] || 0) + 1;
  const labels = Object.keys(counts);
  if (labels.length === 1) return labels[0];
  return labels.map((label) => `${label}: ${counts[label]}`).join(" · ");
}

function badgeClass(entry) {
  if (entry.action === "Remove") return willRemove(entry) ? "Remove" : "Unchanged";
  return entry.action;
}

function renderRow(row) {
  const tr = el("tr");
  if (row.kind === "header") {
    tr.className = "group-row";
    const cell = el("td");
    cell.colSpan = 4;
    const size = row.files.reduce((n, e) => n + e.size, 0);
    cell.append(
      el("strong", row.path),
      el("span", ` · ${plural(row.files.length, "file")} · ${bytes(size)}`, "muted"),
    );
    tr.append(cell);
    return tr;
  }
  if (row.kind === "unit") {
    const first = row.entry;
    const size = row.files.reduce((n, e) => n + e.size, 0);
    const name = el("td");
    name.append(
      el("strong", first.itemId),
      el("small", `${first.folder} · ${plural(row.files.length, "file")}`),
    );
    const status = el("td");
    status.append(el("span", unitStatus(row.files), "badge " + badgeClass(first)));
    const where = first.unitRoot || dirname(first.target);
    tr.append(name, status, el("td", bytes(size)), el("td", where));
    return tr;
  }
  const entry = row.entry;
  const name = el("td");
  name.append(
    el("strong", entry.relative.split("/").at(-1)),
    el("small", `${entry.folder} · ${entry.relative}`),
  );
  const status = el("td");
  status.append(el("span", statusLabel(entry), "badge " + badgeClass(entry)));
  if (entry.action === "Different" || entry.action === "Update") {
    status.append(el("small", `Device copy is ${bytes(entry.remoteSize)}`));
  }
  tr.append(name, status, el("td", bytes(entry.size)), el("td", entry.target, "muted"));
  return tr;
}

function renderSyncWarnings() {
  const plan = sync.plan;
  const blocked = plan?.blocked || [];
  $("sync-blocked").hidden = !blocked.length;
  if (blocked.length) {
    $("sync-blocked").replaceChildren(
      el("strong", "Not included: "),
      el(
        "span",
        `${blocked.map((b) => `“${b.folder}”`).join(", ")} ${blocked.length === 1 ? "has" : "have"} a selection but no destination on this device. `,
      ),
      button("Set destinations →", () => openProfile(plan.deviceId)),
    );
  }
  const warnings = plan?.warnings || [];
  $("sync-warnings").hidden = !warnings.length;
  if (warnings.length) {
    const list = el("ul");
    list.append(
      ...warnings
        .slice(0, 200)
        .map((w) => el("li", `${w.folder}${w.file ? " · " + w.file : ""}: ${w.message}`)),
    );
    if (warnings.length > 200) list.append(el("li", `…and ${warnings.length - 200} more.`));
    $("sync-warnings").replaceChildren(
      el("summary", `${plural(warnings.length, "item")} skipped with a warning`),
      list,
    );
  }
  const kept = plan?.kept || [];
  $("sync-kept").hidden = !kept.length;
  if (kept.length) {
    const list = el("ul");
    list.append(
      ...kept.map((k) => el("li", `${k.folder} · ${k.itemId}: ${k.reason}; left in place.`)),
    );
    $("sync-kept").replaceChildren(
      el("summary", `${plural(kept.length, "unselected item")} left on the device for safety`),
      list,
    );
  }
}

function spaceKey() {
  const replace = $("sync-replace").checked ? "replace" : "keep";
  const remove = $("sync-remove").checked ? "remove" : "stay";
  return `${replace}-${remove}`;
}

// Free space per device volume for the chosen options. Returns true when the
// sync does not fit (it is then blocked).
function renderSpace(plan) {
  const volumes = plan.space?.[spaceKey()] || [];
  const box = $("sync-space");
  if (!volumes.length) {
    box.replaceChildren();
    return false;
  }
  const short = volumes.filter((v) => v.short);
  box.replaceChildren(
    ...volumes.map((v) => {
      const line = el("div", undefined, v.short ? "result-error" : "muted");
      line.textContent = `${v.mount}: ${bytes(v.available)} free of ${bytes(v.total)}${v.needed ? ` · this sync needs ${bytes(v.needed)}` : ""}`;
      if (v.short)
        line.textContent +=
          " — not enough space (keep 100 MB free). Unselect content or free space on the device.";
      return line;
    }),
  );
  return short.length > 0;
}

function renderTemps(plan) {
  const temps = plan.temps || [];
  $("sync-temps").hidden = !temps.length;
  if (!temps.length) return;
  const size = temps.reduce((n, t) => n + t.size, 0);
  const remove = button("Remove them…", () =>
    task(async () => {
      const ok = await confirmDialog(
        `Remove ${plural(temps.length, "leftover temporary file")}?`,
        `These are partial copies from interrupted syncs (${bytes(size)}), named *.odin-sync-<id>.part:\n${temps
          .slice(0, 5)
          .map((t) => t.path)
          .join("\n")}${temps.length > 5 ? "\n…" : ""}`,
        "Remove",
      );
      if (!ok) return;
      const result = await api("sync:cleanTemps", plan.deviceId);
      plan.temps = [];
      renderSyncPlan();
      status(`Removed ${plural(result.removed, "temporary file")}.`);
    }),
  );
  $("sync-temps").replaceChildren(
    el(
      "span",
      `${plural(temps.length, "leftover temporary file")} from interrupted copies (${bytes(size)}). `,
    ),
    remove,
  );
}

function tile(id, entries) {
  $("count-" + id).textContent = entries.length;
  $("bytes-" + id).textContent = bytes(entries.reduce((n, e) => n + e.size, 0));
}

function renderSyncPlan() {
  const plan = sync.plan;
  $("sync-plan").hidden = !plan;
  if (!plan) return;
  const byAction = (action) => plan.entries.filter((e) => e.action === action);
  const removals = byAction("Remove");
  const different = byAction("Different");
  tile("copy", plan.entries.filter(willCopy));
  tile("remove", removals);
  tile("different", different);
  tile("unchanged", byAction("Unchanged"));
  $("sync-remove-label").hidden = !removals.length;
  $("sync-remove-text").textContent =
    `Remove ${plural(removals.length, "file")} no longer in the profile (${bytes(removals.reduce((n, e) => n + e.size, 0))}) — only files this app copied`;
  $("sync-replace-label").hidden = !different.length;
  $("sync-replace-text").textContent =
    `Also replace ${plural(different.length, "file")} that differ on the device and were not copied by this app`;
  const copies = plan.entries.filter(willCopy);
  const removing = plan.entries.filter(willRemove);
  const parts = [];
  if (copies.length)
    parts.push(
      `copy ${plural(copies.length, "file")} (${bytes(copies.reduce((n, e) => n + e.size, 0))})`,
    );
  if (removing.length) parts.push(`remove ${plural(removing.length, "file")}`);
  $("sync-total").textContent = parts.length
    ? "Will " + parts.join(" and ") + "."
    : removals.length
      ? `Nothing to copy. Tick the box above to remove the ${plural(removals.length, "file")} no longer in the profile.`
      : "Nothing to do — the device matches its profile.";
  renderRestore(plan);
  const short = renderSpace(plan);
  renderTemps(plan);
  $("sync-start").disabled = !parts.length || sync.running || short;
  const rows = reviewRows(filteredEntries());
  const pages = Math.max(1, Math.ceil(rows.length / REVIEW_PAGE));
  sync.page = Math.min(sync.page, pages - 1);
  const shown = rows.slice(sync.page * REVIEW_PAGE, (sync.page + 1) * REVIEW_PAGE);
  $("sync-rows").replaceChildren(...shown.map(renderRow));
  $("sync-empty").hidden = rows.length > 0;
  $("sync-page").textContent = `Page ${sync.page + 1} of ${pages}`;
  $("sync-prev").disabled = sync.page === 0;
  $("sync-next").disabled = sync.page >= pages - 1;
}

// Files this app copied before that were deleted on the device: the sync puts
// them back unless their items are deselected.
function renderRestore(plan) {
  const box = $("sync-restore");
  const restore = plan.entries.filter((e) => e.restore);
  box.hidden = !restore.length;
  if (!restore.length) return;
  const items = new Map();
  for (const e of restore) items.set(JSON.stringify([e.folderId, e.itemId]), e);
  const deselect = button("Deselect these", () =>
    task(async () => {
      const byFolder = new Map();
      for (const e of items.values()) {
        const parent = e.itemId.includes("/") ? e.itemId.slice(0, e.itemId.lastIndexOf("/")) : "";
        if (!byFolder.has(e.folderId)) byFolder.set(e.folderId, []);
        byFolder.get(e.folderId).push({ id: e.itemId, folder: parent });
      }
      for (const [folderId, list] of byFolder) {
        applySnapshot(await api("profile:selectItems", plan.deviceId, folderId, list, false));
      }
      status(`${plural(items.size, "item")} deselected. Checking the device again…`);
      await checkDevice();
    }, deselect),
  );
  box.replaceChildren(
    el("strong", `Will be restored: ${plural(items.size, "item")} (${plural(restore.length, "file")}, ${bytes(restore.reduce((n, e) => n + e.size, 0))}) `),
    el("span", "were synced before and deleted on the device since. "),
    deselect,
  );
}

function renderSyncResults() {
  const result = sync.result;
  $("sync-results").hidden = !result;
  if (!result) return;
  const by = (status) => result.results.filter((r) => r.status === status);
  const copied = by("copied");
  const failed = by("failed");
  const removed = by("removed");
  const kept = by("kept");
  const onDevice = by("skipped").filter((r) => /^Already on the device/.test(r.reason || ""));
  const skipped = by("skipped").filter((r) => !onDevice.includes(r));
  const head = el("div", undefined, "panel-title");
  const title = result.disconnected
    ? "Device disconnected"
    : result.stopped
      ? "Sync stopped"
      : failed.length
        ? "Sync finished with errors"
        : "Sync finished";
  const clear = button("Clear", () => {
    sync.result = null;
    renderSync();
  });
  const actions = el("div", undefined, "card-actions");
  if (result.disconnected) {
    const resume = button("Resume sync", () => task(resumeSync, resume), "primary");
    actions.append(resume);
  }
  actions.append(clear);
  head.append(el("h2", title), actions);
  const parts = [head];
  if (result.disconnected) {
    const planned = result.results.filter(
      (r) => r.status !== "skipped" || /disconnected/.test(r.reason || ""),
    );
    const done = copied.length + removed.length;
    parts.push(
      el(
        "div",
        `${done} of ${planned.length} changes done before the device disconnected (${result.disconnected}). ` +
          (result.reconnected
            ? "It is reachable again: Resume sync checks the device and continues with what is left."
            : "Reconnect it (Wireless debugging on, same network), then Resume sync to continue with what is left."),
        "notice warning",
      ),
    );
  }
  parts.push(
    el(
      "p",
      `${copied.length} copied (${bytes(result.copiedBytes)}) · ${removed.length} removed · ${failed.length} failed · ${skipped.length + kept.length} skipped · ${onDevice.length} already on the device. The full log is saved to ${result.log}`,
    ),
  );
  const section = (label, list, describe, open) => {
    if (!list.length) return;
    const details = el("details");
    details.open = open;
    const items = el("ul", undefined, "result-list");
    items.append(...list.slice(0, 500).map((r) => el("li", describe(r))));
    if (list.length > 500) items.append(el("li", `…and ${list.length - 500} more (see the log).`));
    details.append(el("summary", `${label} (${list.length})`), items);
    parts.push(details);
  };
  if (result.gamelists?.length) {
    const ok = result.gamelists.filter((g) => g.status === "copied").map((g) => g.system);
    const bad = result.gamelists.filter((g) => g.status !== "copied");
    if (ok.length)
      parts.push(
        el(
          "p",
          `ES-DE gamelists updated: ${ok.join(", ")} (previous file kept as gamelist.xml.odin-sync.bak).`,
          "muted",
        ),
      );
    for (const g of bad)
      parts.push(
        el("p", `ES-DE gamelist for ${g.system} not updated: ${g.reason}`, "result-error"),
      );
  }
  section("Failed", failed, (r) => `✕ ${r.relative} → ${r.target}: ${r.reason}`, true);
  section(
    "Copied",
    copied,
    (r) => `✓ ${r.relative} → ${r.target}${r.replaced ? " (replaced)" : ""}`,
    !failed.length,
  );
  section("Removed", removed, (r) => `− ${r.target}`, false);
  section("Skipped", [...kept, ...skipped], (r) => `– ${r.relative}: ${r.reason}`, false);
  section("Already on the device", onDevice, (r) => `= ${r.relative} → ${r.target}`, false);
  $("sync-results").replaceChildren(...parts);
}

function renderSync() {
  fillDeviceSelect($("sync-device"), "Add a device in Devices first");
  $("sync-check").disabled = !state.deviceId || sync.running || sync.checking;
  $("sync-device").disabled = $("sync-device").disabled || sync.running || sync.checking;
  if (sync.plan && sync.plan.deviceId !== state.deviceId && !sync.running) sync.plan = null;
  // A sync started by the other side (PC or web) shows its live progress too.
  const elsewhere = !!state.remoteSync?.running && !sync.running && !sync.checking;
  const busy = sync.running || sync.checking || elsewhere;
  $("sync-check").disabled = $("sync-check").disabled || elsewhere;
  $("sync-intro").hidden = !!sync.plan || !!sync.result || busy;
  $("sync-progress").hidden = !busy;
  $("sync-chip").hidden = !busy;
  renderSyncWarnings();
  renderSyncPlan();
  renderSyncResults();
}

function showProgress(progress) {
  if (progress.done) {
    // The end of a sync, possibly one started from the other side.
    const wasElsewhere = !!state.remoteSync;
    state.remoteSync = null;
    if (wasElsewhere && !sync.running) {
      status("The sync started from the other side finished. Its log is in the data folder.");
      renderSync();
    }
    return;
  }
  if (!sync.running && !sync.checking && !state.remoteSync) state.remoteSync = { running: true };
  sync.last = progress;
  $("sync-chip").hidden = false;
  $("progress-phase").textContent = progress.phase + (progress.file ? "" : "…");
  if (!progress.totalBytes && progress.totalBytes !== 0) {
    $("progress-numbers").textContent = "";
    $("progress-total").removeAttribute("value");
    $("progress-bytes").textContent = "";
    $("progress-speed").textContent = "";
    $("progress-eta").textContent = "";
    $("progress-file").textContent = "";
    $("progress-current").hidden = true;
    $("sync-chip").textContent = progress.phase + "…";
    return;
  }
  const fileLabel = progress.fileCount ? `File ${progress.fileIndex} of ${progress.fileCount}` : "";
  $("progress-numbers").textContent = fileLabel;
  $("progress-total").max = progress.totalBytes || 1;
  $("progress-total").value = progress.doneBytes;
  const percent = progress.totalBytes
    ? Math.floor((progress.doneBytes / progress.totalBytes) * 100)
    : 100;
  $("progress-bytes").textContent =
    `${bytes(progress.doneBytes)} of ${bytes(progress.totalBytes)} · ${percent}%`;
  $("progress-speed").textContent = progress.bytesPerSecond
    ? `${bytes(progress.bytesPerSecond)}/s`
    : "";
  $("progress-eta").textContent = progress.secondsLeft
    ? `about ${duration(progress.secondsLeft)} left`
    : "";
  $("progress-file").textContent = progress.file ? `${progress.file} → ${progress.target}` : "";
  $("progress-current").hidden = !progress.file;
  $("progress-current").max = progress.fileSize || 1;
  $("progress-current").value =
    progress.phase === "Copied" ? progress.fileSize : progress.fileBytes || 0;
  $("sync-chip").textContent = `Syncing · ${percent}% · ${fileLabel}`;
}

async function checkDevice() {
  const deviceId = state.deviceId;
  sync.checking = true;
  sync.plan = null;
  sync.result = null;
  $("sync-replace").checked = false;
  $("sync-remove").checked = false;
  showProgress({ phase: "Reading local folders" });
  renderSync();
  try {
    const plan = await api("sync:check", deviceId);
    sync.plan = { ...plan, deviceId };
    sync.page = 0;
    $("sync-filter").value = "changes";
    applySnapshot(await api("config:get"));
    refreshLibraryStatus();
    const s = plan.summary;
    const copy = s.Add.count + s.Update.count;
    const notes = [];
    if (copy) notes.push(`${plural(copy, "file")} to copy`);
    if (s.Remove.count) notes.push(`${plural(s.Remove.count, "file")} no longer in the profile`);
    status(
      notes.length ? `Checked: ${notes.join(", ")}.` : "Checked: the device matches its profile.",
    );
  } finally {
    sync.checking = false;
    renderSync();
  }
}

// Checks the device again and continues with what is left, using the same choices.
async function resumeSync() {
  const options = sync.lastOptions || {};
  await checkDevice();
  if (!sync.plan) return;
  $("sync-replace").checked = !!options.replaceDifferent;
  $("sync-remove").checked = !!options.remove;
  renderSyncPlan();
  if (!$("sync-start").disabled) await startSync();
}

async function startSync() {
  const deviceId = sync.plan.deviceId;
  const remove = $("sync-remove").checked;
  const removals = sync.plan.entries.filter((e) => e.action === "Remove");
  if (remove && removals.length) {
    const size = bytes(removals.reduce((n, e) => n + e.size, 0));
    const ok = await confirmDialog(
      `Remove ${plural(removals.length, "file")} from ${deviceById(deviceId).name}?`,
      `These files were copied by this app and are no longer in the device profile (${size}). Files the app did not copy are never removed.`,
      "Sync and remove",
    );
    if (!ok) return;
  }
  sync.lastOptions = { replaceDifferent: $("sync-replace").checked, remove };
  sync.running = true;
  sync.result = null;
  showProgress({ phase: "Starting" });
  renderSync();
  try {
    const result = await api("sync:start", deviceId, sync.lastOptions);
    sync.result = result;
    sync.plan = null;
    const count = (s) => result.results.filter((r) => r.status === s).length;
    status(
      `${result.disconnected ? "Device disconnected" : result.stopped ? "Stopped" : "Finished"}: ${count("copied")} copied, ${count("removed")} removed, ${count("failed")} failed.`,
      count("failed") > 0,
    );
  } finally {
    sync.running = false;
    // A sync replaces the comparison (results stay until then).
    library.compared = null;
    renderSync();
    refreshLibraryStatus();
  }
}

window.odin.onProgress(showProgress);

$("sync-device").onchange = () => chooseDevice($("sync-device").value);
for (const id of ["sync-filter", "sync-search"]) {
  $(id).addEventListener(id === "sync-search" ? "input" : "change", () => {
    sync.page = 0;
    renderSyncPlan();
  });
}
$("sync-replace").onchange = () => renderSyncPlan();
$("sync-remove").onchange = () => renderSyncPlan();
$("sync-prev").onclick = () => {
  sync.page--;
  renderSyncPlan();
};
$("sync-next").onclick = () => {
  sync.page++;
  renderSyncPlan();
};
$("sync-stop").onclick = () =>
  task(async () => {
    await api("sync:cancel");
    status(sync.checking ? "Stopping the check…" : "Stopping after the current file…");
    $("progress-phase").textContent = "Stopping…";
  });
$("sync-check").onclick = () => task(checkDevice);
$("sync-start").onclick = () => task(startSync);
$("sync-chip").onclick = () => showView("sync");
onRender(renderSync);
