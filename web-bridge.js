// In a web browser, this stands in for Electron's preload: window.odin talks to
// the PC app over HTTP (POST /api/invoke) and Server-Sent Events.
(function () {
  const progressListeners = [];
  const sessionListeners = [];
  const scrapeListeners = [];
  const deviceListeners = [];
  const storageListeners = [];
  let ended = false;

  function showEnded(reason) {
    if (ended) return;
    ended = true;
    const messages = {
      "taken back": "Disconnected: the PC took back control.",
      replaced: "Disconnected: another web session logged in.",
      "web access turned off": "Disconnected: web access was turned off on the PC.",
      "logged out": "You are logged out.",
    };
    for (const listener of sessionListeners) {
      listener({ ended: true, message: messages[reason] || "Disconnected from Odin Sync." });
    }
  }

  async function invoke(channel, ...args) {
    const response = await fetch("/api/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Odin-Request": "1" },
      credentials: "same-origin",
      body: JSON.stringify({ channel, args }),
    });
    const result = await response.json().catch(() => ({ error: "No answer from the PC." }));
    if (result.loggedOut) {
      showEnded("logged out");
      throw new Error("You are logged out.");
    }
    if (result.error) throw new Error(result.error);
    return result.value;
  }

  // A browser file to a device folder, through the PC. onSent(bytes) reports
  // the browser-to-PC part; the PC-to-device part arrives as storage events.
  function uploadFile(deviceId, folder, file, onSent = () => {}) {
    return new Promise((resolve, reject) => {
      const query = new URLSearchParams({ device: deviceId, folder, name: file.name });
      const request = new XMLHttpRequest();
      request.open("PUT", "/api/upload?" + query);
      request.setRequestHeader("X-Odin-Request", "1");
      request.upload.onprogress = (event) => onSent(event.loaded);
      request.onload = () => {
        let result = {};
        try {
          result = JSON.parse(request.responseText);
        } catch {
          result = { error: "No answer from the PC." };
        }
        if (result.loggedOut) showEnded("logged out");
        if (result.error) reject(new Error(result.error));
        else resolve(result.value);
      };
      request.onerror = () => reject(new Error("The upload to the PC failed."));
      request.send(file);
    });
  }

  function connect() {
    const source = new EventSource("/api/events");
    source.addEventListener("progress", (event) => {
      const value = JSON.parse(event.data);
      for (const listener of progressListeners) listener(value);
    });
    source.addEventListener("scrape", (event) => {
      const value = JSON.parse(event.data);
      for (const listener of scrapeListeners) listener(value);
    });
    source.addEventListener("device", (event) => {
      const value = JSON.parse(event.data);
      for (const listener of deviceListeners) listener(value);
    });
    source.addEventListener("storage", (event) => {
      const value = JSON.parse(event.data);
      for (const listener of storageListeners) listener(value);
    });
    source.addEventListener("session", (event) => {
      const value = JSON.parse(event.data);
      for (const listener of sessionListeners) listener(value);
    });
    source.addEventListener("ended", (event) => {
      source.close();
      showEnded(JSON.parse(event.data).reason);
    });
  }

  window.odin = {
    mode: "web",
    invoke,
    onProgress: (callback) => progressListeners.push(callback),
    onSession: (callback) => sessionListeners.push(callback),
    onScrape: (callback) => scrapeListeners.push(callback),
    onDeviceState: (callback) => deviceListeners.push(callback),
    onStorage: (callback) => storageListeners.push(callback),
    uploadFile,
  };
  connect();
})();
