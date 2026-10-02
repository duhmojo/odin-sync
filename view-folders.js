// Local folders: the PC folders that make up the library, and type-wide filters.
const folderTypeHelp = {
  roms: "ROM files that match the extensions. CUE and M3U playlists are kept together with the disc files they reference.",
  games:
    "Each folder directly inside this one is a game (for example C:\\Games\\Game1). A game always syncs complete, with every file and subfolder. Filters never apply to games.",
  music: "Audio files that match the extensions, in their folders.",
  videos: "Video files that match the extensions, in their folders.",
  files: "Any files. Leave extensions empty (or *) to include everything.",
};
let editingFolder = null;
let editorType = "";

function renderFolders() {
  const folders = state.config.folders;
  $("folders-empty").hidden = folders.length > 0;
  $("folder-rows").replaceChildren(
    ...folders.map((folder) => {
      const row = el("tr");
      const name = el("td");
      name.append(el("strong", folder.name));
      const details = [];
      if (folder.type !== "games" && !folder.includeSubfolders) details.push("No subfolders");
      if (folder.excludeFolders || folder.excludeFiles) details.push("Has exclude filters");
      if (folder.extensions) details.push(`Extensions: ${folder.extensions}`);
      if (details.length) name.append(el("small", details.join(" · ")));
      const actions = el("td");
      actions.append(button("Edit", () => editFolder(folder.id)));
      row.append(name, el("td", folder.path), el("td", typeLabel(folder.type)), actions);
      return row;
    }),
  );
  renderTypeFilters();
}

let renderedTypeFilters = "";

// Redrawn only when the saved filters change, so typing is never interrupted.
function renderTypeFilters() {
  const key = JSON.stringify(state.config.typeFilters);
  if (key === renderedTypeFilters) return;
  renderedTypeFilters = key;
  const rows = ["roms", "music", "videos", "files"].map((type) => {
    const filters = state.config.typeFilters[type] || {};
    const row = el("div", undefined, "form-grid filter-row");
    const folders = el("label", `${typeLabel(type)} · exclude folders`);
    const folderInput = el("input");
    folderInput.name = `${type}.excludeFolders`;
    folderInput.value = filters.excludeFolders || "";
    folderInput.placeholder = "regex, e.g. ^(media|images)$";
    folders.append(folderInput);
    const files = el("label", `${typeLabel(type)} · exclude files`);
    const fileInput = el("input");
    fileInput.name = `${type}.excludeFiles`;
    fileInput.value = filters.excludeFiles || "";
    fileInput.placeholder = "regex, e.g. \\(Beta\\)";
    files.append(fileInput);
    row.append(folders, files);
    return row;
  });
  $("type-filter-rows").replaceChildren(...rows);
}

$("type-filters").onsubmit = (event) => {
  event.preventDefault();
  const filters = {};
  for (const input of $("type-filters").querySelectorAll("input")) {
    const [type, key] = input.name.split(".");
    (filters[type] ||= {})[key] = input.value;
  }
  task(async () => {
    applySnapshot(await api("filters:save", filters));
    resetLibraryListings();
    status("Type filters saved.");
  }, event.submitter);
};

function showFolderEditor(open) {
  $("folder-list").hidden = open;
  $("folder-editor").hidden = !open;
}

function editFolder(id) {
  const folder = id ? folderById(id) : null;
  editingFolder = folder
    ? structuredClone(folder)
    : {
        id: "",
        name: "",
        path: "",
        type: "roms",
        includeSubfolders: true,
        extensions: "",
        excludeFolders: typeDefault("roms", "excludeFolders"),
        excludeFiles: typeDefault("roms", "excludeFiles"),
      };
  $("folder-editor-title").textContent = folder ? "Edit folder." : "Add folder.";
  $("folder-name").value = editingFolder.name;
  $("folder-path").value = editingFolder.path;
  $("folder-type").value = editingFolder.type;
  $("folder-subfolders").checked = editingFolder.includeSubfolders !== false;
  $("folder-list-files").checked = editingFolder.listFiles ?? editingFolder.type !== "games";
  fillSystems().then(() => ($("folder-system").value = editingFolder.system || ""));
  $("folder-extensions").value = editingFolder.extensions;
  $("folder-exclude-folders").value = editingFolder.excludeFolders;
  $("folder-exclude-files").value = editingFolder.excludeFiles;
  $("folder-remove").hidden = !folder;
  editorType = editingFolder.type;
  $("folder-error").textContent = "";
  updateFolderType();
  showFolderEditor(true);
  $("folder-name").focus();
}

let systemsLoaded = false;

// ES-DE systems for the folder editor, loaded once.
async function fillSystems() {
  if (systemsLoaded) return;
  const systems = await api("scrape:systems");
  systems.sort((a, b) => a.name.localeCompare(b.name));
  $("folder-system").append(...systems.map((s) => new Option(`${s.name} (${s.id})`, s.id)));
  systemsLoaded = true;
}

function typeDefault(type, key) {
  return state.types[type]?.[key] || "";
}

// Switching type swaps in the new type's default filters, unless they were edited.
function swapTypeDefaults(from, to) {
  const fields = [
    ["folder-exclude-folders", "excludeFolders"],
    ["folder-exclude-files", "excludeFiles"],
  ];
  for (const [id, key] of fields) {
    if ($(id).value === typeDefault(from, key)) $(id).value = typeDefault(to, key);
  }
}

function updateFolderType() {
  const type = $("folder-type").value;
  if (editorType && editorType !== type) {
    swapTypeDefaults(editorType, type);
    $("folder-list-files").checked = type !== "games";
  }
  editorType = type;
  $("folder-system-label").hidden = type !== "roms";
  $("folder-filter-fields").hidden = type === "games";
  $("folder-type-help").textContent = folderTypeHelp[type];
  const defaults = state.types[type]?.extensions;
  $("folder-extensions").placeholder =
    defaults && defaults !== "*"
      ? `Empty uses the defaults: ${defaults}`
      : "Empty or * includes all files";
}

function closeFolderEditor() {
  editingFolder = null;
  showFolderEditor(false);
}

$("folder-type").onchange = updateFolderType;
$("folder-cancel").onclick = closeFolderEditor;
$("folder-cancel-top").onclick = closeFolderEditor;
$("add-folder").onclick = () => editFolder();
$("folder-browse").onclick = () =>
  task(async () => {
    const chosen = await api("pick:folder");
    if (!chosen) return;
    $("folder-path").value = chosen;
    if (!$("folder-name").value.trim())
      $("folder-name").value = chosen.split(/[\\/]/).filter(Boolean).at(-1) || "";
  });

$("folder-form").onsubmit = (event) => {
  event.preventDefault();
  const input = {
    id: editingFolder.id,
    name: $("folder-name").value,
    path: $("folder-path").value,
    type: $("folder-type").value,
    includeSubfolders: $("folder-subfolders").checked,
    extensions: $("folder-extensions").value,
    excludeFolders: $("folder-exclude-folders").value,
    excludeFiles: $("folder-exclude-files").value,
    listFiles: $("folder-list-files").checked,
    system: $("folder-type").value === "roms" ? $("folder-system").value : "",
  };
  const original = editingFolder.id ? folderById(editingFolder.id) : null;
  task(async () => {
    $("folder-error").textContent = "";
    if (original && (original.path !== input.path || original.type !== input.type)) {
      const ok = await confirmDialog(
        "Change folder location or type?",
        "Selections and location overrides for this folder will be cleared on every device. Default destinations are kept.",
        "Save changes",
      );
      if (!ok) return;
    }
    try {
      const result = applySnapshot(await api("folder:save", input));
      resetLibraryListings(result.folderId);
      closeFolderEditor();
      const gapCount = readyDevices().filter((d) =>
        (state.gaps[d.id] || []).includes(result.folderId),
      ).length;
      status(
        gapCount
          ? `Folder saved. Choose where it goes on ${plural(gapCount, "device")} in Device profiles.`
          : "Folder saved.",
      );
    } catch (error) {
      $("folder-error").textContent = cleanError(error);
      throw error;
    }
  }, event.submitter);
};

$("folder-remove").onclick = () =>
  task(async () => {
    const folder = folderById(editingFolder.id);
    const ok = await confirmDialog(
      `Remove “${folder.name}”?`,
      "It leaves the library and its destinations, overrides and selections are removed from every device profile. Files on this PC and on devices are not touched.",
      "Remove folder",
    );
    if (!ok) return;
    applySnapshot(await api("folder:remove", folder.id));
    resetLibraryListings(folder.id);
    closeFolderEditor();
    status("Folder removed from the library.");
  });

onRender(renderFolders);
