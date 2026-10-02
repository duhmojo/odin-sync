// Settings: data folder, scraping and reset.
function renderSettings() {
  $("data-dir").textContent = state.dataDir;
  const startup = state.startup || {};
  $("startup-panel").hidden = webMode;
  $("startup-enabled").checked = !!startup.enabled;
  $("startup-enabled").disabled = !startup.supported;
  $("startup-note").textContent = startup.supported ? "" : "Available in the installed app.";
}

$("startup-enabled").onchange = () =>
  task(async () => {
    applySnapshot(await api("app:startup", $("startup-enabled").checked));
    status(state.startup?.enabled ? "Odin Sync starts with the system." : "Odin Sync no longer starts with the system.");
  });

$("reset-settings").onclick = (event) =>
  task(async () => {
    const ok = await confirmDialog(
      "Reset all settings?",
      "Local folders, filters, devices, device profiles and the library cache are cleared. A backup of the current settings is saved first. No files on this PC or on your devices are touched.",
      "Reset everything",
    );
    if (!ok) return;
    const result = await api("settings:reset");
    resetLibraryListings();
    sync.plan = null;
    sync.result = null;
    deviceStates = {};
    applySnapshot(result);
    status(result.notice || "All settings were reset.");
  }, event.currentTarget);

onRender(renderSettings);

// ScreenScraper account (optional). Passwords are never sent back to the page.
let renderedScraping = "";
function renderScraping() {
  const scraping = state.config.scraping || {};
  $("scraping-panel").hidden = window.odin.mode === "web";
  const key = JSON.stringify(scraping);
  if (key === renderedScraping) return;
  renderedScraping = key;
  $("ss-user").value = scraping.ssUser || "";
  $("ss-dev-id").value = scraping.ssDevId || "";
  $("ss-password").placeholder = scraping.hasPassword ? "Saved — leave empty to keep" : "";
  $("ss-dev-password").placeholder = scraping.hasDevPassword ? "Saved — leave empty to keep" : "";
  const ready =
    scraping.ssUser && scraping.hasPassword && scraping.ssDevId && scraping.hasDevPassword;
  $("scraping-status").textContent = ready
    ? "ScreenScraper is used for ROMs."
    : "Not set: libretro and Steam are used.";
}

$("scraping-form").onsubmit = (event) => {
  event.preventDefault();
  const values = { ssUser: $("ss-user").value, ssDevId: $("ss-dev-id").value };
  if ($("ss-password").value) values.ssPassword = $("ss-password").value;
  if ($("ss-dev-password").value) values.ssDevPassword = $("ss-dev-password").value;
  task(async () => {
    applySnapshot(await api("scraping:configure", values));
    $("ss-password").value = "";
    $("ss-dev-password").value = "";
    status("ScreenScraper settings saved.");
  }, event.submitter);
};

$("scraping-test").onclick = (event) =>
  task(async () => {
    const info = await api("scraping:test");
    $("scraping-status").textContent =
      `Account OK: ${info.requestsToday} of ${info.maxRequestsPerDay || "?"} requests used today, ${info.maxThreads} at a time allowed.`;
  }, event.currentTarget);

onRender(renderScraping);

