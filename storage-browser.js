// Device storage browser. Folders and files are listed; unticking "Show files" hides the
// files of the current folder (remembered per folder for this session).
// With `choose`, it becomes a folder picker whose button hands the current
// folder path to `choose.onChoose`.
const foldersHidingFiles = new Set();

function storageBrowser(device, choose) {
  const root = el("div", undefined, "device-storage");
  const volumes = el("div", undefined, "storage-volumes");
  const crumbs = el("nav", undefined, "crumbs");
  const pathRow = el("div", undefined, "storage-path-row");
  const input = el("input");
  const up = button("↑ Up", () => data?.parent && navigate(data.parent));
  const go = button("Go", () => navigate(input.value.trim()));
  const refresh = button("↻ Refresh", () => navigate(data?.path || input.value.trim()));
  const create = button("New folder…", () => data?.writable && createFolder());
  const upload = button("Upload files…", () => data?.writable && uploadFiles());
  // In a browser: a file input stands in for the PC's file picker.
  const filePicker = el("input");
  filePicker.type = "file";
  filePicker.multiple = true;
  filePicker.hidden = true;
  const tools = el("div", undefined, "storage-tools");
  const info = el("span", undefined, "muted");
  const filesToggle = el("label", undefined, "inline-check");
  const filesCheck = el("input");
  const message = el("p", undefined, "storage-message");
  const tableWrap = el("div", undefined, "table-wrap storage-table-wrap");
  const table = el("table");
  const body = el("tbody");
  let data = null;
  let chooseButton = null;
  // Bumped on every listing: size requests for an older listing are dropped.
  let generation = 0;

  input.value = choose?.start || "/storage";
  input.setAttribute("aria-label", `Device path for ${device.name}`);
  input.onkeydown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      navigate(input.value.trim());
    }
  };
  filesCheck.type = "checkbox";
  filesToggle.append(filesCheck, document.createTextNode("Show files"));
  filesToggle.hidden = !!choose;
  filesCheck.onchange = () => {
    if (!data) return;
    if (filesCheck.checked) foldersHidingFiles.delete(data.path);
    else foldersHidingFiles.add(data.path);
    navigate(data.path);
  };
  message.setAttribute("role", "status");
  const head = el("thead");
  const headRow = el("tr");
  headRow.append(...["Name", "Type", "Size", "Modified", ""].map((title) => el("th", title)));
  head.append(headRow);
  table.append(head, body);
  tableWrap.append(table);
  pathRow.append(up, input, go, refresh);
  tools.append(info, filesToggle, create);
  if (!choose) tools.append(upload, filePicker);
  if (choose) {
    chooseButton = button(choose.label || "Use this folder", () =>
      task(() => choose.onChoose(data.path), chooseButton),
    );
    chooseButton.classList.add("primary");
    chooseButton.disabled = true;
    tools.append(chooseButton);
  }
  root.append(volumes, crumbs, pathRow, tools, message, tableWrap);

  // Folder sizes are added up on the device, except in the folder picker.
  function options(target) {
    return { foldersOnly: !!choose || foldersHidingFiles.has(target) };
  }

  async function load(target) {
    input.value = target;
    if (chooseButton) chooseButton.disabled = true;
    message.replaceChildren(
      el("span", undefined, "spinner"),
      document.createTextNode(" Loading folder…"),
    );
    message.className = "storage-message loading";
    create.disabled = true;
    upload.disabled = true;
    up.disabled = true;
    body.replaceChildren();
    info.textContent = "";
    try {
      render(await api("storage:browse", device.id, target, options(target)));
    } catch (error) {
      data = null;
      message.textContent = cleanError(error);
      message.className = "storage-message result-error";
      info.textContent = "Storage unavailable";
      throw error;
    }
  }

  function navigate(target) {
    return task(() => load(target));
  }

  function typeName(entry) {
    if (entry.type === "volume") {
      return (
        { internal: "Internal", sd: "SD card", usb: "USB", removable: "Removable" }[
          entry.volumeKind
        ] || "Storage"
      );
    }
    return { folder: "Folder", link: "Link", file: "File" }[entry.type] || "Other";
  }

  function render(result) {
    data = result;
    input.value = data.path;
    create.disabled = !data.writable;
    create.title = data.writable ? "Create a folder here" : "This location is not writable";
    upload.disabled = !data.writable || data.path === "/storage";
    up.disabled = !data.parent;
    message.textContent = data.warnings?.join(" · ") || "";
    message.className = "storage-message";
    const access = data.path === "/storage" ? "" : data.writable ? " · Writable" : " · Read only";
    const hidden = data.hiddenFiles ? ` · ${plural(data.hiddenFiles, "file")} not shown` : "";
    info.textContent = `${plural(data.entries.length, "item")}${hidden}${access}`;
    filesToggle.hidden = !!choose || data.path === "/storage";
    filesCheck.checked = !foldersHidingFiles.has(data.path);
    if (chooseButton) chooseButton.disabled = !data.writable || data.path === "/storage";
    volumes.replaceChildren(
      ...data.volumes.map((v) => {
        const node = button(v.total ? `${v.label} · ${bytes(v.available)} free of ${bytes(v.total)}` : v.label, () => navigate(v.path));
        node.classList.toggle("active", data.volume?.id === v.id);
        return node;
      }),
    );
    const trail = [button("Storage", () => navigate("/storage"))];
    if (data.volume) {
      let current = data.volume.path;
      const volumePath = current;
      trail.push(
        el("span", "/"),
        button(data.volume.label, () => navigate(volumePath)),
      );
      for (const part of data.path.slice(current.length).split("/").filter(Boolean)) {
        current += "/" + part;
        const target = current;
        trail.push(
          el("span", "/"),
          button(part, () => navigate(target)),
        );
      }
    }
    crumbs.replaceChildren(...trail);
    body.replaceChildren(...data.entries.map(entryRow));
    if (!choose) fillSizes(++generation);
    if (!data.entries.length) {
      const row = el("tr");
      const cell = el(
        "td",
        data.hiddenFiles
          ? "No folders here. Tick Show files to see the files."
          : "This folder is empty.",
      );
      cell.colSpan = 5;
      row.append(cell);
      body.append(row);
    }
  }

  function entryRow(entry) {
    const row = el("tr");
    const name = el("td");
    name.title = entry.path;
    name.append(
      el(
        "span",
        entry.type === "volume" ? "▣ " : entry.type === "folder" ? "▸ " : "▤ ",
        "storage-icon",
      ),
    );
    if (entry.navigable) {
      const open = button(entry.name, () => navigate(entry.path), "link-button");
      open.title = entry.path;
      name.append(open);
    } else {
      name.append(el("span", entry.name));
    }
    const kind = el("td", typeName(entry));
    if (entry.type !== "volume" && !entry.readable) kind.append(el("small", "No read access"));
    const modified = entry.modified
      ? new Date(entry.modified).toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        })
      : "—";
    const actions = el("td");
    const androidFolder =
      data.volume &&
      (entry.path === data.volume.path + "/Android" ||
        entry.path.startsWith(data.volume.path + "/Android/"));
    if (!choose && ["file", "folder"].includes(entry.type) && entry.readable !== false) {
      const get = iconButton("⬇", "Download", () => downloadEntry(entry), "storage-download");
      get.setAttribute("aria-label", `Download ${entry.name}`);
      actions.append(get);
    }
    if (!choose && data.writable && !androidFolder && ["file", "folder"].includes(entry.type)) {
      const remove = iconButton("✕", "Delete", () => deleteEntry(entry), "storage-delete");
      remove.setAttribute("aria-label", `Delete ${entry.name}`);
      actions.append(remove);
    }
    row.append(
      name,
      kind,
      (entry.cell = el("td", sizeText(entry))),
      el("td", modified),
      actions,
    );
    return row;
  }

  // Folder sizes arrive one by one after the listing, three at a time.
  function fillSizes(current) {
    const folders = data.entries.filter((e) => e.type === "folder" && e.size === -2);
    let next = 0;
    const worker = async () => {
      while (next < folders.length && current === generation && root.isConnected) {
        const entry = folders[next++];
        try {
          Object.assign(entry, await api("storage:size", device.id, entry.path));
        } catch {
          entry.size = -3;
        }
        if (current === generation && entry.cell) entry.cell.textContent = sizeText(entry);
      }
    };
    for (let i = 0; i < 3; i++) worker();
  }

  // An icon and a label; narrow screens show only the icon.
  function iconButton(icon, label, onClick, className) {
    const node = button("", onClick, className);
    node.title = label;
    node.append(el("span", icon + " ", "button-icon"), el("span", label, "button-label"));
    return node;
  }

  function sizeText(entry) {
    if (entry.type === "file") return bytes(entry.size);
    if (entry.type === "volume") return entry.total ? `${bytes(entry.total - entry.available)} used · ${bytes(entry.available)} free` : "—";
    if (entry.type === "folder") {
      if (entry.size >= 0) return `${bytes(entry.size)} · ${plural(entry.files || 0, "file")}`;
      if (entry.size === -1) return "Large (not counted)";
      if (entry.size === -2) return "…";
    }
    return "—";
  }

  // Files from the PC (or the browser's device) into the open folder. Existing
  // files with the same name are replaced only after confirming.
  function uploadFiles() {
    const folder = data.path;
    if (window.odin.mode === "web") {
      filePicker.value = "";
      filePicker.onchange = () => task(() => sendBrowserFiles(folder, [...filePicker.files]), upload);
      filePicker.click();
      return;
    }
    return task(async () => {
      const picked = await api("storage:pickFiles");
      if (!picked.length) return;
      if (!(await confirmReplace(folder, picked.map((f) => f.name)))) return;
      message.textContent = `Uploading ${plural(picked.length, "file")}…`;
      render(await api("storage:upload", device.id, folder, picked.map((f) => f.token), options(folder)));
      status(`Uploaded ${plural(picked.length, "file")} to ${folder}.`);
    }, upload);
  }

  async function sendBrowserFiles(folder, files) {
    if (!files.length) return;
    if (!(await confirmReplace(folder, files.map((f) => f.name)))) return;
    for (const [index, file] of files.entries()) {
      await window.odin.uploadFile(device.id, folder, file, (sent) => {
        message.textContent = `Sending ${file.name} (${index + 1} of ${files.length}) to the PC · ${Math.floor((sent * 100) / Math.max(file.size, 1))}%`;
      });
    }
    render(await api("storage:browse", device.id, folder, options(folder)));
    status(`Uploaded ${plural(files.length, "file")} to ${folder}.`);
  }

  async function confirmReplace(folder, names) {
    const listing = await api("storage:browse", device.id, folder, { foldersOnly: false });
    const existing = new Set(listing.entries.filter((e) => e.type === "file").map((e) => e.name));
    const clash = names.filter((n) => existing.has(n));
    if (!clash.length) return true;
    return confirmDialog(
      `Replace ${plural(clash.length, "file")}?`,
      `Already in ${folder}: ${clash.slice(0, 8).join(", ")}${clash.length > 8 ? "…" : ""}`,
      "Replace",
    );
  }

  // Upload progress from the PC to the device.
  window.odin.onStorage?.((value) => {
    if (!root.isConnected || !data) return;
    message.className = "storage-message";
    const verb = value.verb || "Uploading";
    message.textContent = value.done
      ? `${verb === "Downloading" ? "Download" : "Upload"} finished.`
      : `${verb} ${value.name} (${value.index} of ${value.count}) · ${Math.floor((value.bytes * 100) / Math.max(value.size, 1))}% `;
    if (verb === "Downloading" && !value.done) message.append(cancelDownload);
    else cancelDownload.remove();
  });

  // To the PC (desktop: choose a folder; progress here, with Cancel), or
  // straight to the browser's downloads (a folder as a zip).
  function downloadEntry(entry) {
    if (window.odin.mode === "web") {
      const query = new URLSearchParams({ device: device.id, path: entry.path, type: entry.type });
      const anchor = el("a");
      anchor.href = "/api/download?" + query;
      anchor.download = entry.type === "folder" ? entry.name + ".zip" : entry.name;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      status(`Downloading ${entry.name}${entry.type === "folder" ? " as a zip" : ""}…`);
      return;
    }
    return task(async () => {
      const result = await api("storage:download", device.id, entry.path, entry.type);
      cancelDownload.remove();
      if (result.cancelled) status("Download cancelled.");
      else status(`Downloaded ${plural(result.files, "file")} to ${result.folder}.`);
    });
  }
  const cancelDownload = button("Cancel", () => api("storage:cancel"));

  function createFolder() {
    const parent = data.path;
    return task(async () => {
      const name = await promptDialog(
        "Create a folder",
        `In ${parent}`,
        "Create folder",
        "Folder name",
      );
      if (name === null) return;
      render(await api("storage:mkdir", device.id, parent, name, options(parent)));
      status(`Folder “${name}” created.`);
    });
  }

  function deleteEntry(entry) {
    const parent = data.path;
    const folder = entry.type === "folder";
    return task(async () => {
      const contents = entry.size >= 0 ? `${plural(entry.files || 0, "file")}, ${bytes(entry.size)}` : "everything in it";
      const ok = await confirmDialog(
        folder ? `Delete folder “${entry.name}” and everything in it?` : `Delete file “${entry.name}”?`,
        `${entry.path}\n${folder ? `This permanently removes the folder and its contents (${contents}) from the device.` : "This permanently removes the file from the device."}`,
        folder ? "Delete folder" : "Delete file",
      );
      if (!ok) return;
      const expected = { type: entry.type, fingerprint: entry.fingerprint };
      render(await api("storage:delete", device.id, entry.path, expected, options(parent)));
      status(`Deleted “${entry.name}”.`);
    });
  }

  // A picker may start in a folder that does not exist yet; it then opens the
  // nearest existing parent instead.
  async function loadNearest(target) {
    let current = target;
    while (true) {
      try {
        await load(current);
        return;
      } catch (error) {
        const parts = current.split("/");
        if (!choose || current === "/storage" || parts.length <= 2) throw error;
        current = parts.length > 3 ? parts.slice(0, -1).join("/") : "/storage";
      }
    }
  }

  root.load = (target) => task(() => loadNearest(target || input.value.trim()));
  return root;
}
