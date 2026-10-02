// Library: browse local folders the way their type dictates and choose what the
// current device gets. Browsing works without a device.
const PAGE_ROWS = 300;
const library = {
  folderId: "",
  relative: "",
  listing: null,
  error: "",
  loading: false,
  limit: PAGE_ROWS,
  cache: new Map(),
  gameSizes: new Map(),
  status: null,
  statusDevice: null,
};

function listingKey(folderId, relative) {
  return folderId + "\n" + relative;
}

function resetLibraryListings(folderId) {
  for (const key of library.cache.keys()) {
    if (!folderId || key.startsWith(folderId + "\n")) library.cache.delete(key);
  }
  if (!folderId) library.gameSizes.clear();
  if (library.folderId && !folderById(library.folderId)) {
    library.folderId = "";
    library.listing = null;
  }
  if (library.folderId && (!folderId || folderId === library.folderId)) {
    openLibraryFolder(
      library.folderId,
      folderById(library.folderId).includeSubfolders ? library.relative : "",
    );
  }
}

async function openLibraryFolder(folderId, relative = "", refresh = false) {
  library.folderId = folderId;
  library.relative = relative;
  library.limit = PAGE_ROWS;
  library.error = "";
  $("library-search").value = "";
  const key = listingKey(folderId, relative);
  if (!refresh && library.cache.has(key)) {
    library.listing = library.cache.get(key);
    renderLibrary();
    return;
  }
  library.listing = null;
  library.loading = true;
  renderLibrary();
  try {
    const listing = await api("library:list", folderId, relative, refresh);
    library.cache.set(key, listing);
    if (library.folderId === folderId && library.relative === relative) library.listing = listing;
  } catch (error) {
    library.error = cleanError(error);
  } finally {
    library.loading = false;
    renderLibrary();
  }
  loadGameSizes();
  loadThumbs(folderId, library.listing?.items || []);
}

async function loadGameSizes() {
  const folder = folderById(library.folderId);
  if (!folder || folder.type !== "games" || !library.listing) return;
  const names = library.listing.items
    .map((item) => item.name)
    .filter((name) => !library.gameSizes.has(folder.id + "\n" + name))
    .slice(0, 200);
  if (!names.length) return;
  const sizes = await api("library:gameSizes", folder.id, names).catch(() => ({}));
  for (const [name, value] of Object.entries(sizes))
    library.gameSizes.set(folder.id + "\n" + name, value);
  if (library.folderId === folder.id) renderLibraryRows();
}

function currentSelection() {
  return profileFor(state.deviceId)?.selections[library.folderId];
}

function folderHasGap(folderId) {
  return !!state.deviceId && (state.gaps[state.deviceId] || []).includes(folderId);
}

function selectionLabel(folderId) {
  const selection = profileFor(state.deviceId)?.selections[folderId];
  if (!selection) return "";
  if (folderRule(selection, "")) {
    return branchMixed(selection, "") ? "Everything, with exceptions" : "Everything";
  }
  const rules = Object.values(selection.folders).filter(Boolean).length;
  const items = selection.items.length;
  const parts = [];
  if (rules) parts.push(plural(rules, "folder"));
  if (items) parts.push(plural(items, "item"));
  return parts.join(" · ");
}

function renderLibraryFolders() {
  const folders = state.config.folders;
  $("library-no-folders").hidden = folders.length > 0;
  $("library-folders").replaceChildren(
    ...folders.map((folder) => {
      const item = button("", () => task(() => openLibraryFolder(folder.id, "")), "folder-button");
      item.classList.toggle("active", folder.id === library.folderId);
      item.append(el("strong", folder.name), el("small", typeLabel(folder.type)));
      if (folderHasGap(folder.id))
        item.append(el("small", "⚠ No destination on this device", "warning-text"));
      else {
        const label = selectionLabel(folder.id);
        if (label) item.append(el("small", "✓ " + label, "selected-text"));
        const missing = comparedCounts().missing[folder.id];
        if (missing) item.append(el("small", `⚠ ${missing} deleted on device`, "warning-text"));
      }
      return item;
    }),
  );
}

// Items per state from the last Compare with device (or check) of this device.
function comparedCounts() {
  const counts = { missing: {}, missingTotal: 0, add: 0 };
  for (const [key, action] of Object.entries(library.status?.checked || {})) {
    const [folderId] = JSON.parse(key);
    if (action === "Missing") {
      counts.missing[folderId] = (counts.missing[folderId] || 0) + 1;
      counts.missingTotal++;
    } else if (action === "Add") counts.add++;
  }
  return counts;
}

function renderCompared() {
  const box = $("library-compared");
  const device = deviceById(state.deviceId);
  if (!device || !library.compared || library.compared !== state.deviceId) {
    box.hidden = true;
    return;
  }
  const counts = comparedCounts();
  box.hidden = false;
  box.className = counts.missingTotal ? "notice warning" : "notice";
  const parts = [];
  if (counts.missingTotal)
    parts.push(
      el("strong", `${plural(counts.missingTotal, "item")} you synced ${counts.missingTotal === 1 ? "was" : "were"} deleted on ${device.name}. `),
      el("span", "Syncing puts them back; uncheck them to leave them off. "),
    );
  if (counts.add) parts.push(el("span", `${plural(counts.add, "item")} not on the device yet. `));
  if (!parts.length) parts.push(el("span", `${device.name} has everything selected.`));
  box.replaceChildren(...parts);
}

function renderLibraryHeader() {
  fillDeviceSelect($("library-device"), "Browse only — no device saved");
  $("library-review").disabled = !state.deviceId;
  $("library-compare").disabled = !state.deviceId;
  renderCompared();
  const gaps = (state.gaps[state.deviceId] || []).map(folderById).filter(Boolean);
  const device = deviceById(state.deviceId);
  $("library-gaps").hidden = !gaps.length;
  if (gaps.length) {
    $("library-gaps").replaceChildren(
      el(
        "strong",
        `New local folder${gaps.length === 1 ? "" : "s"} without a place on ${device.name}: `,
      ),
      el(
        "span",
        gaps.map((f) => `“${f.name}”`).join(", ") +
          ". Selecting and syncing them is blocked until you choose a destination. ",
      ),
      button("Set destinations →", () => openProfile(state.deviceId)),
    );
  }
}

function renderCrumbs(folder) {
  const trail = [button(folder.name, () => task(() => openLibraryFolder(folder.id, "")))];
  let current = "";
  for (const part of library.relative.split("/").filter(Boolean)) {
    current = current ? `${current}/${part}` : part;
    const target = current;
    trail.push(
      el("span", "/"),
      button(part, () => task(() => openLibraryFolder(folder.id, target))),
    );
  }
  $("library-crumbs").replaceChildren(...trail);
}

function renderLocation(folder) {
  const box = $("library-location");
  const device = deviceById(state.deviceId);
  if (!device) {
    box.replaceChildren(
      el("span", "Browsing only. Choose a device above to select content for it.", "muted"),
    );
    return;
  }
  if (folderHasGap(folder.id)) {
    box.replaceChildren(
      el(
        "span",
        `New local folder: choose where “${folder.name}” goes on ${device.name}.`,
        "warning-text",
      ),
      button("Choose destination…", () => chooseDestination(device, folder), "primary"),
    );
    return;
  }
  const profile = profileFor(device.id);
  const target = destinationFor(profile, folder.id, library.relative);
  const parts = [el("span", `On ${device.name}: `), el("code", target)];
  const whole = el("label", undefined, "inline-check whole-folder");
  const check = el("input");
  check.type = "checkbox";
  const selection = currentSelection();
  check.checked = folderRule(selection, library.relative);
  check.indeterminate = branchMixed(selection, library.relative);
  check.onchange = () => selectFolder(folder, library.relative, check.checked);
  const what =
    folder.type === "games"
      ? "Sync all games, including ones added later"
      : "Sync everything here, including files added later";
  whole.append(check, document.createTextNode(what));
  parts.push(whole);
  if (library.relative) parts.push(...overrideActions(device, folder, library.relative));
  box.replaceChildren(...parts);
}

function overrideActions(device, folder, relative) {
  const profile = profileFor(device.id);
  const own = profile?.overrides[folder.id]?.[relative];
  const actions = [button("Change location", () => chooseOverride(device, folder, relative))];
  if (own) {
    actions.push(
      button("Reset location", () =>
        task(async () => {
          applySnapshot(await api("profile:override", device.id, folder.id, relative, ""));
          status(`${relative.split("/").at(-1)} follows the folder destination again.`);
        }),
      ),
    );
  }
  return actions;
}

function selectFolder(folder, relative, selected) {
  return task(async () => {
    applySnapshot(await api("profile:selectFolder", state.deviceId, folder.id, relative, selected));
    const name = relative ? relative.split("/").at(-1) : folder.name;
    status(
      selected
        ? `“${name}” selected. New files in it are included automatically.`
        : `“${name}” unselected.`,
    );
  });
}

function selectItems(folder, items, selected) {
  return task(async () => {
    const payload = items.map((item) => ({ id: item.id, folder: item.folder }));
    applySnapshot(await api("profile:selectItems", state.deviceId, folder.id, payload, selected));
    status(`${plural(items.length, "item")} ${selected ? "selected" : "unselected"}.`);
  });
}

function visibleRows() {
  const listing = library.listing;
  if (!listing) return { folders: [], items: [] };
  const query = $("library-search").value.trim().toLowerCase();
  const match = (name) => !query || name.toLowerCase().includes(query);
  return {
    folders: listing.folders.filter((f) => match(f.name)),
    items: listing.items.filter((i) => match(i.name)),
  };
}

function checkCell(checked, indeterminate, disabled, label, onChange) {
  const cell = el("td", undefined, "check-column");
  const check = el("input");
  check.type = "checkbox";
  check.checked = checked;
  check.indeterminate = indeterminate;
  check.disabled = disabled;
  check.setAttribute("aria-label", label);
  check.onchange = () => onChange(check.checked);
  cell.append(check);
  return cell;
}

// Device status of an item, from the inventory and the last check:
// on the device, will be added, will be removed, or different/updated.
async function refreshLibraryStatus() {
  const deviceId = state.deviceId;
  library.statusDevice = deviceId;
  if (!deviceId) {
    library.status = null;
    return;
  }
  try {
    library.status = await api("inventory:status", deviceId);
  } catch {
    library.status = null;
  }
  if (state.deviceId === deviceId) renderLibraryRows();
}

function itemBadge(folder, item, selected) {
  const status = library.status;
  if (!status || !state.deviceId || folderHasGap(folder.id)) return null;
  const key = JSON.stringify([folder.id, item.id]);
  const checked = status.checked[key];
  const onDevice = !!status.onDevice[key];
  let label = "";
  let kind = "";
  // Synced before, deleted on the device since (from Compare with device or a check).
  if (checked === "Missing") [label, kind] = selected ? ["Deleted on device · sync restores it", "Missing"] : ["Deleted on device", "Unchanged"];
  else if (selected && checked === "Add") [label, kind] = ["Will add", "Add"];
  else if (selected && checked === "Different")
    [label, kind] = ["Different on device", "Different"];
  else if (selected && checked === "Update") [label, kind] = ["Will update", "Update"];
  else if (selected) [label, kind] = onDevice ? ["On device", "Unchanged"] : ["Will add", "Add"];
  else if (onDevice && Object.keys(status.checked).length && checked !== "Remove") {
    // The last check decided to keep it (for example, extra files in the game folder).
    [label, kind] = ["Left on device", "Unchanged"];
  } else if (onDevice) [label, kind] = ["Will remove", "Remove"];
  if (!label) return null;
  const badge = el("span", label, `badge item-status ${kind}`);
  const wrap = el("div");
  wrap.append(badge);
  return wrap;
}

function locationCell(folder, relative) {
  const cell = el("td", undefined, "location-cell");
  if (!state.deviceId || folderHasGap(folder.id)) return cell;
  const profile = profileFor(state.deviceId);
  cell.textContent = destinationFor(profile, folder.id, relative);
  if (profile?.overrides[folder.id]?.[relative]) cell.append(el("small", "Custom location"));
  return cell;
}

function folderRow(folder, sub, selection, locked) {
  const row = el("tr", undefined, "folder-row");
  const checked = folderRule(selection, sub.relative);
  row.append(
    checkCell(
      checked,
      branchMixed(selection, sub.relative),
      locked,
      `Sync folder ${sub.name}`,
      (value) => selectFolder(folder, sub.relative, value),
    ),
  );
  const name = el("td");
  name.append(
    button(
      "▸ " + sub.name,
      () => task(() => openLibraryFolder(folder.id, sub.relative)),
      "link-button",
    ),
  );
  const actions = el("td");
  if (!locked) actions.append(...overrideActions(deviceById(state.deviceId), folder, sub.relative));
  row.append(name, el("td", "Folder", "muted"), locationCell(folder, sub.relative), actions);
  return row;
}

function itemRow(folder, item, selection, locked) {
  const row = el("tr");
  const selected = itemSelected(selection, item.id, item.folder);
  row.append(
    checkCell(selected, false, locked, `Sync ${item.name}`, (value) =>
      selectItems(folder, [item], value),
    ),
  );
  const name = el("td", undefined, "item-name");
  name.append(...mediaName(folder, item));
  if (item.files && item.files.length > 1) {
    const files = item.files.slice(1).map((f) => f.relative.split("/").at(-1));
    const extra = el(
      "small",
      `+ ${plural(files.length, "related file")}: ${files.slice(0, 4).join(", ")}${files.length > 4 ? "…" : ""}`,
    );
    extra.title = files.join("\n");
    name.append(extra);
  }
  let size = item.size;
  let sizeNote = "";
  if (folder.type === "games") {
    const info = library.gameSizes.get(folder.id + "\n" + item.name);
    size = info?.size ?? null;
    sizeNote = info ? (info.error ? info.error : plural(info.files, "file")) : "Measuring…";
  }
  const sizeCell = el("td", size === null ? "—" : bytes(size));
  if (sizeNote) sizeCell.append(el("small", sizeNote));
  const actions = el("td");
  if (folder.type === "games" && !locked)
    actions.append(...overrideActions(deviceById(state.deviceId), folder, item.id));
  const where = locationCell(folder, item.id);
  const badge = itemBadge(folder, item, selected);
  if (badge) where.prepend(badge);
  row.append(name, sizeCell, where, actions);
  return row;
}

function renderLibraryRows() {
  const folder = folderById(library.folderId);
  if (!folder || !library.listing) {
    $("library-rows").replaceChildren();
    return;
  }
  const selection = currentSelection();
  const locked = !state.deviceId || folderHasGap(folder.id);
  const rows = visibleRows();
  const all = [
    ...rows.folders.map((sub) => () => folderRow(folder, sub, selection, locked)),
    ...rows.items.map((item) => () => itemRow(folder, item, selection, locked)),
  ];
  $("library-rows").replaceChildren(...all.slice(0, library.limit).map((make) => make()));
  $("library-more").hidden = all.length <= library.limit;
  $("library-more").textContent = `Show more (${all.length - library.limit} more)`;
  const empty = !all.length;
  $("library-empty").hidden = !empty;
  if (empty) {
    const message = $("library-search").value.trim()
      ? "Nothing here matches the filter."
      : folder.type === "games"
        ? "No game folders found. Each game should be a folder directly inside this one."
        : "No matching files or folders here.";
    $("library-empty").replaceChildren(el("p", message));
  }
}

function renderLibraryNote(folder) {
  const listing = library.listing;
  const parts = [];
  if (listing) {
    parts.push(
      folder.type === "games"
        ? plural(listing.items.length, "game")
        : `${plural(listing.folders.length, "folder")} · ${plural(listing.items.length, folder.type === "roms" ? "game" : "file")}`,
    );
    const hidden = listing.hidden || {};
    if (hidden.folders) parts.push(`${plural(hidden.folders, "folder")} hidden by filters`);
    if (hidden.files) parts.push(`${plural(hidden.files, "file")} hidden by extensions or filters`);
    parts.push(`read ${new Date(listing.readAt).toLocaleTimeString()}`);
  }
  $("library-note").textContent = parts.join(" · ");
  const warnings = listing?.warnings || [];
  $("library-warnings").hidden = !warnings.length;
  if (warnings.length) {
    const list = el("ul");
    list.append(...warnings.slice(0, 50).map((w) => el("li", `${w.file}: ${w.message}`)));
    $("library-warnings").replaceChildren(
      el("summary", `${plural(warnings.length, "file")} skipped`),
      list,
    );
  }
}

function renderLibraryBulk(folder) {
  const tools = $("library-browser").querySelector(".browser-tools");
  tools.querySelectorAll(".bulk").forEach((node) => node.remove());
  if (!library.listing || !state.deviceId || folderHasGap(folder.id)) return;
  const items = () => visibleRows().items;
  const all = button("Select shown", () => selectItems(folder, items(), true), "bulk");
  const none = button("Unselect shown", () => selectItems(folder, items(), false), "bulk");
  tools.prepend(all, none);
}

function renderLibrary() {
  if (library.statusDevice !== state.deviceId) refreshLibraryStatus();
  renderLibraryHeader();
  renderLibraryFolders();
  const folder = folderById(library.folderId);
  $("library-browser").hidden = !folder;
  $("library-pick").hidden = !!folder;
  if (!folder) return;
  renderCrumbs(folder);
  renderLocation(folder);
  if (library.loading) {
    $("library-note").textContent = "Reading folder…";
    $("library-rows").replaceChildren();
    $("library-empty").hidden = true;
    $("library-more").hidden = true;
    return;
  }
  if (library.error) {
    $("library-note").textContent = "";
    $("library-rows").replaceChildren();
    $("library-empty").hidden = false;
    $("library-empty").replaceChildren(el("p", library.error, "result-error"));
    return;
  }
  renderLibraryNote(folder);
  renderLibraryBulk(folder);
  renderScrapeTools(folder);
  renderLibraryRows();
}

$("library-device").onchange = () => chooseDevice($("library-device").value);
$("library-review").onclick = () => showView("sync");
// Reads the device and marks what was deleted there and what is not synced yet.
$("library-compare").onclick = (event) =>
  task(async () => {
    const deviceId = state.deviceId;
    status(`Comparing with ${deviceById(deviceId)?.name}…`);
    await api("sync:check", deviceId);
    library.compared = deviceId;
    await refreshLibraryStatus();
    renderLibrary();
    const counts = comparedCounts();
    status(counts.missingTotal ? `${plural(counts.missingTotal, "item")} deleted on the device.` : "Compared with the device.");
  }, event.currentTarget);
$("library-add-folder").onclick = () => {
  showView("folders");
  editFolder();
};
// Reload re-reads the PC and forgets every cached listing of this local folder.
$("library-refresh").onclick = (event) => {
  if (!library.folderId) return;
  const folderId = library.folderId;
  for (const key of library.cache.keys()) {
    if (key.startsWith(folderId + "\n")) library.cache.delete(key);
  }
  for (const key of library.gameSizes.keys()) {
    if (key.startsWith(folderId + "\n")) library.gameSizes.delete(key);
  }
  task(async () => {
    await openLibraryFolder(folderId, library.relative, true);
    status("Reloaded from the PC.");
  }, event.currentTarget);
};
$("library-reveal").onclick = () =>
  library.folderId && task(() => api("library:reveal", library.folderId, library.relative));
$("library-search").oninput = () => {
  library.limit = PAGE_ROWS;
  renderLibraryRows();
};
$("library-more").onclick = () => {
  library.limit += PAGE_ROWS;
  renderLibraryRows();
};

onRender(renderLibrary);
