// Starts the renderer: wires navigation and loads the saved configuration.
document.querySelectorAll("nav button").forEach((navButton) => {
  navButton.onclick = () => showView(navButton.dataset.view);
});

task(async () => {
  const snapshot = applySnapshot(await api("config:get"));
  // Opened from the Odin Sync app: #device=<id>&view=library shows that
  // device's library.
  const link = new URLSearchParams(location.hash.slice(1));
  if (link.get("device") && deviceById(link.get("device"))) {
    chooseDevice(link.get("device"));
    showView(link.get("view") || "library");
    history.replaceState(null, "", location.pathname);
  }
  if (snapshot.notice) {
    status(snapshot.notice);
  } else if (!state.config.folders.length) {
    status("Start by adding a local folder, then pair your device in Devices.");
  } else if (!readyDevices().length) {
    status("Pair your Android device in Devices to start syncing.");
  } else {
    status("Ready. Browse your library without connecting a device.");
  }
  // Show saved devices' status right away (this also finishes a device whose
  // pairing was saved but whose connection was not recognised).
  if (state.config.devices.length)
    task(refreshDeviceStatus).then(() => task(async () => applySnapshot(await api("config:get"))));
});
