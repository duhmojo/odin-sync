// Devices: devices paired with the Odin Sync app, their status and storage.
let deviceStates = {};

function deviceStateLabel(device) {
  const state = deviceStates[device.id];
  if (state?.state === "online") return ["Online", "Online"];
  if (state?.state === "offline") return ["Offline", "Offline"];
  return ["Status not checked", "Offline"];
}

function gapNotice(deviceId, action) {
  const missing = (state.gaps[deviceId] || []).map(folderById).filter(Boolean);
  if (!missing.length) return null;
  const box = el("div", undefined, "notice warning");
  const names = missing.map((f) => `“${f.name}”`).join(", ");
  box.append(
    el(
      "strong",
      missing.length === 1
        ? "New local folder: choose where it goes on this device. "
        : "New local folders: choose where they go on this device. ",
    ),
    el("span", names + ". "),
  );
  if (action) box.append(action);
  return box;
}

// Where the device was last seen: its IP (and MAC, when the PC knows it).
function lastSeen(device) {
  const r = device.receiver || {};
  const parts = [r.host, r.mac].filter(Boolean);
  if (r.lastSeen) parts.push("last seen " + new Date(r.lastSeen).toLocaleString());
  return parts.join(" · ");
}

// The app version this PC carries (outside deviceCard, whose `state` is the device's).
function bundledApp() {
  return state.web?.installer?.app || null;
}

function deviceCard(device) {
  const card = el("article", undefined, "panel device-card");
  const top = el("div", undefined, "panel-title");
  const [label, badge] = deviceStateLabel(device);
  const state = deviceStates[device.id];
  top.append(el("h2", device.name), el("span", label, "badge " + badge));
  card.append(top);
  card.append(el("p", state?.detail || "Refresh status to check this device."));
  if (lastSeen(device)) card.append(el("p", lastSeen(device), "muted"));
  if (state?.memoryMb) {
    card.append(
      el("p", `App memory: ${state.memoryMb} MB${state.lastTrim ? ` · Android asked for memory (level ${state.lastTrim})` : ""}`, "muted"),
    );
  }
  if (device.filesAccess === false) {
    card.append(
      el(
        "div",
        "Allow file access on the device: open the Odin Sync app there and tap Allow access to files. Nothing can be synced until then.",
        "notice warning",
      ),
    );
  }
  // The app version on the device; an older one than this PC carries can update.
  const latest = bundledApp();
  if (device.app) {
    const line = el("p", `Odin Sync app ${device.app.versionName} (${device.app.versionCode})`, "muted");
    if (latest && device.app.versionCode < latest.versionCode) {
      line.append(" ", el("span", `Update available: ${latest.versionName} (${latest.versionCode}). Open the app on the device to install it.`, "badge Pending"));
    }
    card.append(line);
  }
  const gaps = gapNotice(device.id, button("Set destinations →", () => openProfile(device.id)));
  if (gaps) card.append(gaps);
  const actions = el("div", undefined, "card-actions");
  const reconnect = button("Reconnect", (event) => task(refreshDeviceStatus, event.currentTarget));
  reconnect.disabled = state?.state === "online";
  actions.append(reconnect, button("Device profile", () => openProfile(device.id)));
  actions.append(
    button("Remove device", () =>
      task(async () => {
        const ok = await confirmDialog(
          `Remove ${device.name}?`,
          "Its device profile (destinations, overrides and selections) is removed too. Files on the device are not touched.",
          "Remove device",
        );
        if (!ok) return;
        delete deviceStates[device.id];
        applySnapshot(await api("device:remove", device.id));
        status(`${device.name} removed.`);
      }),
    ),
  );
  card.append(actions);
  const settings = el("details");
  const rename = el("label", "Device name");
  const nameInput = el("input");
  nameInput.value = device.name;
  nameInput.onchange = () =>
    task(async () => {
      applySnapshot(await api("device:rename", device.id, nameInput.value));
      status("Device renamed.");
    });
  rename.append(nameInput);
  // Low impact transfers: for playing on the device while it syncs.
  const low = device.lowImpact || { enabled: false, mbPerSecond: 5 };
  const lowLabel = el("label", undefined, "inline-check");
  const lowCheck = el("input");
  lowCheck.type = "checkbox";
  lowCheck.checked = !!low.enabled;
  const speed = el("input");
  speed.type = "number";
  speed.min = "0.5";
  speed.max = "500";
  speed.step = "0.5";
  speed.value = low.mbPerSecond || 5;
  speed.className = "speed-input";
  const saveLow = () =>
    task(async () => {
      applySnapshot(await api("device:lowImpact", device.id, lowCheck.checked, Number(speed.value)));
      status(lowCheck.checked ? `Transfers to ${device.name} are capped at ${speed.value} MB/s.` : `Transfers to ${device.name} run at full speed.`);
    });
  lowCheck.onchange = saveLow;
  speed.onchange = saveLow;
  lowLabel.append(lowCheck, document.createTextNode("Low impact transfers (for playing while it syncs), up to "), speed, document.createTextNode(" MB/s"));
  settings.append(el("summary", "Device settings"), rename, lowLabel);
  card.append(settings);
  if (state?.state === "online" && state.verified) {
    const storage = el("details", undefined, "device-storage-details");
    const browser = storageBrowser(device);
    let loaded = false;
    storage.append(el("summary", "Browse device storage"), browser);
    storage.ontoggle = () => {
      if (storage.open && !loaded) {
        loaded = true;
        browser.load("/storage");
      }
    };
    card.append(storage);
  }
  return card;
}

function renderDevices() {
  const cards = state.config.devices.map(deviceCard);
  if (!cards.length)
    cards.push(el("div", "No devices yet. Install the Odin Sync app on your handheld and pair it below.", "notice"));
  $("saved-devices").replaceChildren(...cards);
}

async function refreshDeviceStatus() {
  $("devices-status").textContent = "Checking devices…";
  try {
    deviceStates = await api("device:status");
    renderDevices();
    $("devices-status").textContent = "Last checked: " + new Date().toLocaleTimeString();
  } catch (error) {
    $("devices-status").textContent = "Could not check devices: " + cleanError(error);
    throw error;
  }
}

$("refresh-status").onclick = (event) => task(refreshDeviceStatus, event.currentTarget);
$("show-add-device").onclick = () => {
  $("receiver-panel").scrollIntoView({ behavior: "smooth" });
};

viewHooks.devices = () => {
  if (state.config.devices.length) task(refreshDeviceStatus);
};
onRender(renderDevices);

// A device that reconnected or announced itself in the background.
window.odin.onDeviceState?.((value) => {
  // New details for the device (its address or app version): reload them.
  if (value.changed) task(async () => applySnapshot(await api("config:get")));
  deviceStates[value.deviceId] = {
    state: value.state,
    verified: value.state === "online",
    detail: value.detail,
  };
  renderDevices();
  const device = deviceById(value.deviceId);
  if (device && value.state === "online") status(`${device.name} is connected.`);
});
