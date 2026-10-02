// The web server: its settings and the PIN (PC only), the control overlay,
// and hiding PC-only actions in the browser.
const webMode = window.odin.mode === "web";
let sessionState = { controller: "app", web: null };

function renderWebSettings() {
  $("web-panel").hidden = webMode;
  if (webMode) return;
  const settings = state.config.web || {};
  const status = state.web || {};
  if (document.activeElement !== $("web-port")) $("web-port").value = settings.port || 8765;
  const parts = [];
  if (status.error) parts.push(`The web server could not start: ${status.error}`);
  else if (status.running) {
    parts.push("Running. Browsers open ");
    status.urls.forEach((url, i) => parts.push(...(i ? [" or "] : []), link(url)));
    parts.push(".");
  } else parts.push("The web server is not running.");
  $("web-status").replaceChildren(...parts);
  $("web-status").className = status.error ? "result-error" : "muted";
  askForPin();
}

$("web-form").onsubmit = (event) => {
  event.preventDefault();
  task(async () => {
    const input = { port: Number($("web-port").value) };
    if ($("web-pin").value) input.pin = $("web-pin").value;
    applySnapshot(await api("web:configure", input));
    $("web-pin").value = "";
    status(input.pin ? "PIN changed." : "Web server settings saved.", !!state.web?.error);
  }, event.submitter);
};

$("web-restart").onclick = (event) =>
  task(async () => {
    applySnapshot(await api("web:restart"));
    status(state.web?.running ? "Web server restarted." : "The web server could not start.", !state.web?.running);
  }, event.currentTarget);

// Without a PIN nothing can pair or sign in, so the PC app asks for one first
// and cannot be dismissed until it is set.
function askForPin() {
  const dialog = $("pin-dialog");
  if (webMode || state.web?.hasPin !== false || dialog.open) return;
  $("pin-error").textContent = "";
  $("welcome-startup-label").hidden = !state.startup?.supported;
  $("welcome-startup").checked = state.startup?.enabled !== false;
  dialog.showModal();
  $("pin-new").focus();
}

$("pin-dialog").addEventListener("cancel", (event) => event.preventDefault());
$("pin-form").onsubmit = (event) => {
  event.preventDefault();
  const pin = $("pin-new").value;
  if (pin !== $("pin-again").value) {
    $("pin-error").textContent = "The two PINs are different.";
    return;
  }
  task(async () => {
    try {
      applySnapshot(await api("web:configure", { pin }));
      if (state.startup?.supported && $("welcome-startup").checked !== state.startup.enabled) {
        applySnapshot(await api("app:startup", $("welcome-startup").checked));
      }
    } catch (error) {
      $("pin-error").textContent = cleanError(error);
      throw error;
    }
    $("pin-new").value = "";
    $("pin-again").value = "";
    $("pin-dialog").close();
    status("PIN set. Use it in the Odin Sync app and to sign in from a browser.");
    // First start: the next step is installing the app on a device.
    if (!state.config.devices.length) showView("devices");
  });
};

// The desktop is paused while a browser is in control; the browser shows why
// it was disconnected.
function renderControl() {
  const overlay = $("control-overlay");
  if (webMode) return;
  const web = sessionState.web;
  overlay.hidden = sessionState.controller !== "web";
  if (overlay.hidden) return;
  $("control-title").textContent = "Controlled from the web";
  $("control-text").textContent =
    `A browser at ${web.ip} has been in control since ${new Date(web.since).toLocaleTimeString()}. A running sync continues either way.`;
  $("control-action").textContent = "Take back control";
  $("control-action").onclick = () =>
    task(async () => {
      applySnapshot(await api("session:takeBack"));
      status("You took back control. The browser was disconnected.");
    });
}

function showDisconnected(message) {
  const overlay = $("control-overlay");
  overlay.hidden = false;
  $("control-title").textContent = "Disconnected";
  $("control-text").textContent = message;
  $("control-action").textContent = "Log in again";
  $("control-action").onclick = () => (window.location.href = "/login");
}

window.odin.onSession((value) => {
  if (value.ended) return showDisconnected(value.message);
  sessionState = value;
  renderControl();
  if (!webMode && value.controller === "app")
    task(async () => applySnapshot(await api("config:get")));
});

// Actions that open windows on the PC are not available in the browser.
function markPcOnly() {
  if (!webMode) return;
  document.body.classList.add("web-mode");
  $("web-logout").hidden = false;
  for (const id of ["folder-browse", "library-reveal"]) {
    const control = $(id);
    control.disabled = true;
    control.title = "Do this on the PC";
  }
  $("library-reveal").hidden = true;
  // Local folders are read-only in the browser (it cannot browse this PC).
  const note = el("div", "Local folders can only be added or changed in the Odin Sync desktop app on the PC.", "notice");
  $("folder-list").querySelector(".heading").after(note);
  $("library-no-folders").append(el("p", "Add local folders in the Odin Sync desktop app on the PC.", "muted"));
  $("folder-type-help").after(el("p", "Choosing a PC folder: do this on the PC.", "muted"));
}

onRender(() => {
  if (state.session) sessionState = state.session;
  renderWebSettings();
  renderControl();
});
markPcOnly();
