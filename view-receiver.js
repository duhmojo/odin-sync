// Devices → Add a device: the install link for the Odin Sync app, then the
// device pairs itself from the app with the PC's PIN and appears here. A
// device paired again (for example after reinstalling) can take over an
// existing device's profile.

function renderReceiverInstaller() {
  const installer = state.web?.installer || {};
  // On the web (often the device itself) the install page is on this server.
  const urls = webMode ? ["/receiver"] : installer.urls || [];
  $("receiver-urls").replaceChildren(
    ...urls.map((url) => {
      const item = el("li");
      item.append(link(url, webMode ? "Install the app on this device" : url));
      return item;
    }),
  );
  $("receiver-install-text").textContent = !installer.built
    ? "The app is not built into this copy of Odin Sync."
    : urls.length
      ? ""
      : state.web?.error || "The web server is not running. Restart it in Settings.";
}

// After a pairing: say so, and offer the profile of an existing device.
function showPaired(deviceId, fresh) {
  const device = deviceById(deviceId);
  if (!device) return;
  const box = $("receiver-paired");
  box.hidden = false;
  box.replaceChildren(el("p", `${device.name} is paired.`));
  const others = state.config.devices.filter((d) => d.id !== deviceId);
  if (!fresh || !others.length) return;
  const select = el("select");
  for (const other of others) select.append(new Option(other.name, other.id));
  const use = button("Use that device's profile", () =>
    task(async () => {
      const result = await api("device:merge", deviceId, select.value);
      applySnapshot(result);
      box.replaceChildren(el("p", `${deviceById(result.deviceId)?.name} is paired, with its profile and inventory.`));
      status("Pairing moved to the existing device.");
    }, use),
  );
  const row = el("div", undefined, "connected-row");
  row.append(el("span", "Is this a device you already had (app reinstalled, or settings reset)?"), select, use);
  box.append(row);
}

window.odin.onDeviceState?.((value) => {
  if (!value.paired) return;
  task(async () => {
    applySnapshot(await api("config:get"));
    showPaired(value.deviceId, value.fresh);
  });
});

// In a browser on an Android device: the install button comes first.
function renderInstallHere() {
  const box = $("install-here");
  const android = webMode && /Android/i.test(navigator.userAgent);
  box.hidden = !android || !state.web?.installer?.built;
  if (box.hidden) return;
  const install = link("/receiver", "Install the Odin Sync app on this device");
  install.className = "button-link primary";
  box.replaceChildren(
    install,
    el("p", "Then open it, tap Find Odin Sync on the PC and enter your PIN. Already installed? Open the app instead.", "muted"),
  );
}

onRender(renderReceiverInstaller);
onRender(renderInstallHere);
