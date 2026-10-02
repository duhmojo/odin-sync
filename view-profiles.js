// Device profiles: one per device. Each local folder gets a default destination;
// subfolders and games can be moved elsewhere (overrides) from Library.
let highlightDevice = "";

function openProfile(deviceId) {
  highlightDevice = deviceId;
  showView("profiles");
}

// Opens the device folder picker. `onChoose(path)` saves the result.
function pickDeviceFolder(device, title, hint, label, onChoose, start = "/storage") {
  const panel = $("destination-picker");
  const back = showView.bind(null, document.querySelector(".view:not([hidden])")?.id || "profiles");
  const close = () => {
    panel.hidden = true;
    $("profile-list").hidden = false;
    back();
  };
  const head = el("div", undefined, "panel-title");
  head.append(el("h2", title), button("Cancel", close));
  const browser = storageBrowser(device, {
    label,
    start,
    onChoose: async (path) => {
      await onChoose(path);
      close();
    },
  });
  panel.replaceChildren(head, el("p", hint), browser);
  showView("profiles");
  $("profile-list").hidden = true;
  panel.hidden = false;
  browser.load(start);
}

function parentPath(path) {
  const parts = path.split("/");
  return parts.length > 2 ? parts.slice(0, -1).join("/") : "/storage";
}

function chooseDestination(device, folder) {
  const current = profileFor(device.id)?.destinations[folder.id];
  pickDeviceFolder(
    device,
    `Destination for ${folder.name} on ${device.name}`,
    `Open the folder that should hold the contents of “${folder.name}”, then choose Use this folder. Its structure is kept below it.`,
    "Use this folder",
    async (path) => {
      applySnapshot(await api("profile:destination", device.id, folder.id, path));
      status(`${folder.name} → ${path} on ${device.name}.`);
    },
    current ? parentPath(current) : "/storage",
  );
}

// The override path is where the subfolder or game itself goes.
function chooseOverride(device, folder, relative) {
  const name = relative.split("/").at(-1);
  const current = destinationFor(profileFor(device.id), folder.id, relative);
  pickDeviceFolder(
    device,
    `Location for “${name}” on ${device.name}`,
    `Open the folder that should contain “${name}”, then choose Put “${name}” here. It is saved as <chosen folder>/${name}.`,
    `Put “${name}” here`,
    async (path) => {
      const target = `${path}/${name}`;
      applySnapshot(await api("profile:override", device.id, folder.id, relative, target));
      status(`${name} → ${target} on ${device.name}.`);
    },
    current ? parentPath(current) : "/storage",
  );
}

// Other per-device places: GameNative configs and ES-DE (artwork upload).
const openOptions = new Set();

function deviceOptions(device, profile) {
  const box = el("details", undefined, "device-options");
  // Stays open across redraws (each saved option redraws the profiles).
  box.open = openOptions.has(device.id);
  box.ontoggle = () => (box.open ? openOptions.add(device.id) : openOptions.delete(device.id));
  box.append(el("summary", "Device options: GameNative and ES-DE"));
  const field = (label, key, placeholder) => {
    const wrap = el("label", label);
    const input = el("input");
    input.value = profile?.[key] || "";
    input.placeholder = placeholder;
    input.onchange = () =>
      task(async () => {
        applySnapshot(await api("profile:option", device.id, key, input.value.trim()));
        status(`${label} saved.`);
      });
    wrap.append(input);
    return wrap;
  };
  const grid = el("div", undefined, "form-grid");
  grid.append(
    field("GameNative config folder", "gameNativeFolder", "/sdcard/GameNative/configs"),
    field(
      "ES-DE folder (gamelists, downloaded_media)",
      "esdeFolder",
      "e.g. /storage/ABCD-1234/ES-DE",
    ),
    field("ES-DE ROMs folder", "esdeRoms", "e.g. /storage/ABCD-1234/ROMs"),
  );
  const upload = el("label", undefined, "inline-check");
  const check = el("input");
  check.type = "checkbox";
  check.checked = !!profile?.esdeUpload;
  check.onchange = () =>
    task(async () => {
      applySnapshot(await api("profile:option", device.id, "esdeUpload", check.checked));
      status(
        check.checked
          ? "Artwork and metadata will be uploaded for ES-DE when syncing."
          : "ES-DE upload turned off.",
      );
    });
  upload.append(
    check,
    document.createTextNode("Upload artwork and metadata for ES-DE when syncing ROMs"),
  );
  box.append(grid, upload);
  return box;
}

function destinationRow(device, profile, folder) {
  const row = el("tr");
  const name = el("td");
  name.append(el("strong", folder.name), el("small", `${typeLabel(folder.type)} · ${folder.path}`));
  const target = profile?.destinations[folder.id] || "";
  const where = el("td");
  const input = el("input");
  input.value = target;
  input.placeholder = "Not set — choose a folder on the device";
  input.setAttribute("aria-label", `Destination for ${folder.name}`);
  input.onchange = () =>
    task(async () => {
      applySnapshot(await api("profile:destination", device.id, folder.id, input.value.trim()));
      status(input.value.trim() ? "Destination saved." : "Destination cleared.");
    });
  where.append(input);
  if (!target) {
    row.classList.add("gap");
    where.append(
      el("small", "New local folder: choose where it goes on this device.", "warning-text"),
    );
  }
  const overrides = Object.entries(profile?.overrides[folder.id] || {});
  if (overrides.length) {
    const list = el("ul", undefined, "override-list");
    for (const [relative, path] of overrides) {
      const item = el("li");
      item.append(
        el("span", `${relative} → ${path}`),
        button("Reset", () =>
          task(async () => {
            applySnapshot(await api("profile:override", device.id, folder.id, relative, ""));
            status(`${relative} follows the folder destination again.`);
          }),
        ),
      );
      list.append(item);
    }
    where.append(list);
  }
  const actions = el("td");
  actions.append(button("Browse device…", () => chooseDestination(device, folder)));
  row.append(name, where, actions);
  return row;
}

function renderProfiles() {
  const devices = readyDevices();
  $("profiles-empty").hidden = devices.length > 0;
  $("profile-cards").replaceChildren(
    ...devices.map((device) => {
      const profile = profileFor(device.id);
      const card = el("article", undefined, "panel profile-card");
      if (device.id === highlightDevice) card.classList.add("highlight");
      const top = el("div", undefined, "panel-title");
      const heading = el("div");
      heading.append(
        el("h2", device.name),
        el("p", "Default destination for each local folder on this device."),
      );
      top.append(
        heading,
        button(
          "Choose content in Library →",
          () => {
            chooseDevice(device.id);
            showView("library");
          },
          "primary",
        ),
      );
      card.append(top);
      const gaps = gapNotice(device.id);
      if (gaps) card.append(gaps);
      if (!state.config.folders.length) {
        card.append(el("p", "Add local folders first; each one then gets a destination here."));
        return card;
      }
      const wrap = el("div", undefined, "table-wrap");
      const table = el("table", undefined, "profile-table");
      const head = el("thead");
      const headRow = el("tr");
      headRow.append(el("th", "Local folder"), el("th", "Goes to on the device"), el("th", ""));
      head.append(headRow);
      const body = el("tbody");
      body.append(...state.config.folders.map((folder) => destinationRow(device, profile, folder)));
      table.append(head, body);
      wrap.append(table);
      card.append(wrap, deviceOptions(device, profile));
      return card;
    }),
  );
  // Devices saved but not connected yet get a profile once their identity is verified.
  for (const device of state.config.devices.filter((d) => !d.hardwareId)) {
    const card = el("article", undefined, "panel profile-card pending");
    const top = el("div", undefined, "panel-title");
    top.append(
      el("h2", device.name),
      button("Connect in Devices →", () => showView("devices")),
    );
    card.append(
      top,
      el(
        "p",
        "Paired but not connected yet. Its profile is set up here as soon as it connects and its identity is verified.",
      ),
    );
    $("profile-cards").append(card);
  }
  $("profiles-empty").hidden = state.config.devices.length > 0;
  if (highlightDevice) {
    document.querySelector(".profile-card.highlight")?.scrollIntoView({ block: "start" });
    highlightDevice = "";
  }
}

onRender(renderProfiles);
viewHooks.profiles = renderProfiles;
