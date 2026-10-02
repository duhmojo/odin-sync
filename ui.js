// Shared renderer state and helpers. Every view script uses these globals.
const $ = (id) => document.getElementById(id);
const api = (name, ...args) => window.odin.invoke(name, ...args);

const state = {
  config: null,
  gaps: {},
  types: {},
  dataDir: "",
  deviceId: "",
  syncing: false,
};

const renderers = [];

function onRender(fn) {
  renderers.push(fn);
}

function renderAll() {
  for (const fn of renderers) fn();
}

// Takes a snapshot returned by the main process and redraws every view.
function applySnapshot(snapshot) {
  if (!snapshot || !snapshot.config) return snapshot;
  state.config = snapshot.config;
  state.gaps = snapshot.gaps || {};
  state.types = snapshot.types || state.types;
  state.dataDir = snapshot.dataDir || state.dataDir;
  state.web = snapshot.web || state.web;
  state.startup = snapshot.startup || state.startup;
  state.session = snapshot.session || state.session;
  state.remoteSync = snapshot.sync || null;
  const devices = state.config.devices.filter((d) => d.hardwareId);
  if (!devices.some((d) => d.id === state.deviceId)) state.deviceId = devices[0]?.id || "";
  renderAll();
  return snapshot;
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

// A clickable address (opened in the browser on the PC, followed on the web).
function link(url, text = url) {
  const node = el("a", text);
  node.href = url;
  node.target = "_blank";
  node.rel = "noopener";
  return node;
}

function button(text, onClick, className) {
  const node = el("button", text, className);
  node.type = "button";
  node.onclick = onClick;
  return node;
}

function bytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function duration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "";
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${Math.round(seconds % 60)} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function status(message, error = false) {
  $("status").textContent = message;
  $("status").className = error ? "result-error" : "";
}

let busyCount = 0;

// Runs an action, shows a busy indicator and reports errors in the status bar.
// It does not lock the rest of the UI.
async function task(fn, control) {
  if (control?.disabled) return undefined;
  busyCount++;
  $("busy-indicator").hidden = false;
  if (control) control.disabled = true;
  try {
    return await fn();
  } catch (error) {
    status(cleanError(error), true);
    return undefined;
  } finally {
    busyCount--;
    $("busy-indicator").hidden = busyCount === 0;
    if (control) control.disabled = false;
  }
}

// Electron prefixes errors from the main process; show only the message.
function cleanError(error) {
  return String(error?.message || error).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    "",
  );
}

// Modal dialog: focus stays inside it and Esc cancels.
function openDialog(title, text, okLabel, danger, input) {
  const dialog = $("confirm-dialog");
  $("confirm-title").textContent = title;
  $("confirm-text").textContent = text;
  $("confirm-ok").textContent = okLabel;
  $("confirm-ok").className = danger ? "danger" : "primary";
  const field = $("confirm-input");
  field.hidden = !input;
  field.value = "";
  field.placeholder = input?.placeholder || "";
  dialog.returnValue = "";
  dialog.showModal();
  if (input) field.focus();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true });
  });
}

$("confirm-input").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  $("confirm-dialog").close("ok");
});

function confirmDialog(title, text, okLabel = "Confirm") {
  return openDialog(title, text, okLabel, true, null);
}

// Asks for a single line of text; resolves to null when cancelled.
async function promptDialog(title, text, okLabel, placeholder) {
  const ok = await openDialog(title, text, okLabel, false, { placeholder });
  return ok ? $("confirm-input").value : null;
}

const viewNames = {
  library: "Library",
  sync: "Sync",
  devices: "Devices",
  profiles: "Device profiles",
  folders: "Local folders",
  settings: "Settings",
};
const viewHooks = {};

function showView(name) {
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== name));
  document
    .querySelectorAll("nav button")
    .forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  $("breadcrumb").textContent = viewNames[name];
  viewHooks[name]?.();
}

function folderById(id) {
  return state.config.folders.find((f) => f.id === id);
}

function deviceById(id) {
  return state.config.devices.find((d) => d.id === id);
}

function profileFor(deviceId) {
  return state.config.profiles.find((p) => p.deviceId === deviceId);
}

function readyDevices() {
  return state.config.devices.filter((d) => d.hardwareId);
}

function typeLabel(type) {
  return state.types[type]?.label || type;
}

// Fills a device <select> and keeps the shared current-device choice in sync.
function fillDeviceSelect(select, emptyText) {
  const devices = readyDevices();
  const options = devices.map((d) => new Option(d.name, d.id));
  if (!devices.length) options.unshift(new Option(emptyText, ""));
  select.replaceChildren(...options);
  select.value = state.deviceId;
  select.disabled = !devices.length;
}

function chooseDevice(deviceId) {
  state.deviceId = deviceId;
  renderAll();
}

// ---- Selection helpers (mirror config.cjs so the UI can draw checkboxes) ----

function inBranch(relative, folder) {
  return !folder || relative === folder || relative.startsWith(folder + "/");
}

function folderRule(selection, relative) {
  let result = false;
  let depth = -1;
  for (const [folder, value] of Object.entries(selection?.folders || {})) {
    if (inBranch(relative, folder) && folder.length > depth) {
      result = value;
      depth = folder.length;
    }
  }
  return result;
}

function itemSelected(selection, id, folder) {
  if (!selection) return false;
  if (selection.items.includes(id)) return true;
  return folderRule(selection, folder) && !selection.excluded.includes(id);
}

// True when some choice inside the branch differs from the branch's own rule.
function branchMixed(selection, relative) {
  if (!selection) return false;
  const own = folderRule(selection, relative);
  const inside = (key) => key !== relative && inBranch(key, relative);
  for (const [folder, value] of Object.entries(selection.folders)) {
    if (inside(folder) && value !== own) return true;
  }
  if (own) return selection.excluded.some(inside);
  return selection.items.some(inside);
}

function destinationFor(profile, folderId, relative) {
  if (!profile) return "";
  const overrides = profile.overrides[folderId] || {};
  let chosen = null;
  for (const key of Object.keys(overrides)) {
    if (key && inBranch(relative, key) && (!chosen || key.length > chosen.length)) chosen = key;
  }
  if (chosen) {
    const rest = relative === chosen ? "" : relative.slice(chosen.length + 1);
    return rest ? `${overrides[chosen]}/${rest}` : overrides[chosen];
  }
  const base = profile.destinations[folderId];
  if (!base) return "";
  return relative ? `${base}/${relative}` : base;
}
