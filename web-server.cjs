// Web access: serves the app's own UI over HTTP on the LAN, behind a password.
// The page talks to the same channel handlers as the desktop window through
// POST /api/invoke, and receives progress through Server-Sent Events.
const http = require("node:http");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { isLanAddress } = require("./web-session.cjs");

const COOKIE = "odin_session";
const APK_NAME = "odin-sync-receiver.apk";
const MAX_BODY = 1024 * 1024;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'";

function lanUrls(port) {
  const urls = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const a of addresses || []) {
      if (a.family === "IPv4" && !a.internal) urls.push(`http://${a.address}:${port}`);
    }
  }
  return urls;
}

function cookies(req) {
  const result = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0)
      result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}

function clientIp(req) {
  return (req.socket.remoteAddress || "").replace(/^::ffff:/i, "");
}

function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("Request too large."));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function loginPage(message = "") {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Odin Sync · Log in</title><link rel="stylesheet" href="style.css"></head>
<body class="login-page"><main class="login-box panel">
<div class="brand"><span class="logo">O</span><div>ODIN <b>SYNC</b><small>WEB ACCESS</small></div></div>
<form method="post" action="/login">
<label>PIN<input type="password" name="password" inputmode="numeric" autocomplete="current-password" autofocus required></label>
${message ? `<p class="result-error">${escapeHtml(message)}</p>` : ""}
<button type="submit" class="primary">Log in</button>
</form>
<p class="muted">Logging in here takes control of Odin Sync; the PC app is paused until you log out or it takes control back.</p>
</main></body></html>`;
}

// options: { root, files, sessions, limiter, password: () => record|null,
//            verify(password, record), invoke(channel, args, token), channels }
// The page the device's browser opens to install the receiver app.
function receiverPage(ready, size) {
  const steps = ready
    ? `<a class="button-link primary" href="/receiver/odin-sync-receiver.apk" download>Download the Odin Sync app (${Math.max(1, Math.round(size / 1024))} KB)</a>
    <ol>
      <li>Tap the download above, then open the file when it finishes.</li>
      <li>If Android asks, allow your browser to install apps, then tap <b>Install</b>.</li>
      <li>Open <b>Odin Sync</b> and allow access to files.</li>
      <li>Tap <b>Find Odin Sync on the PC</b>, choose this PC and enter your Odin Sync PIN. Keep the app open to sync.</li>
    </ol>`
    : `<p>The receiver app has not been built into this copy of Odin Sync yet.</p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Install Odin Sync</title><link rel="stylesheet" href="/style.css"></head>
<body class="login-page"><main class="login-box panel">
  <div class="brand"><span class="logo">O</span><div>ODIN <b>SYNC</b><small>ANDROID APP</small></div></div>
  <p class="muted">Receives files from Odin Sync on the PC over Wi-Fi.</p>
  ${steps}
</main></body></html>`;
}

function createWebServer(options) {
  const clients = new Set();
  let server = null;

  function send(res, status, body, headers = {}) {
    res.writeHead(status, {
      "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
      ...headers,
    });
    res.end(body);
  }

  function json(res, status, value) {
    send(res, status, JSON.stringify(value), { "Content-Type": "application/json; charset=utf-8" });
  }

  function token(req) {
    return cookies(req)[COOKIE] || "";
  }

  async function serveFile(res, name) {
    let body = await fs.readFile(path.join(options.root, name), "utf8");
    if (name === "index.html") {
      // Web pages get the HTTP bridge instead of Electron's preload.
      body = body.replace(
        '<script src="ui.js"></script>',
        '<script src="web-bridge.js"></script>\n    <script src="ui.js"></script>',
      );
      // The desktop page may not connect anywhere; the web page talks to this server.
      body = body.replace("connect-src 'none'", "connect-src 'self'");
    }
    send(res, 200, body, { "Content-Type": TYPES[path.extname(name)] });
  }

  function installPage(res) {
    const ready = !!options.apk && fsSync.existsSync(options.apk);
    send(res, 200, receiverPage(ready, ready ? fsSync.statSync(options.apk).size : 0), { "Content-Type": TYPES[".html"] });
  }

  function serveApk(res) {
    if (!options.apk || !fsSync.existsSync(options.apk)) return send(res, 404, "The receiver app has not been built.");
    send(res, 200, fsSync.readFileSync(options.apk), {
      "Content-Type": "application/vnd.android.package-archive",
      "Content-Disposition": `attachment; filename="${APK_NAME}"`,
    });
  }

  // A file from the browser for a device folder: streamed to a temporary file
  // on the PC (never held in memory), then sent to the device by options.upload.
  async function upload(req, res, url) {
    if (req.headers["x-odin-request"] !== "1") return json(res, 403, { error: "Missing request header." });
    const session = token(req);
    if (!options.sessions.valid(session)) return json(res, 401, { error: "Logged out.", loggedOut: true });
    if (!options.upload) return json(res, 404, { error: "Uploads are not available." });
    await fs.mkdir(options.uploadDir, { recursive: true });
    const file = path.join(options.uploadDir, `${require("node:crypto").randomUUID()}.part`);
    try {
      await require("node:stream/promises").pipeline(req, fsSync.createWriteStream(file));
      const value = await options.upload(
        url.searchParams.get("device") || "",
        url.searchParams.get("folder") || "",
        url.searchParams.get("name") || "",
        file,
        session,
      );
      json(res, 200, { value });
    } catch (error) {
      if (!res.headersSent) json(res, 200, { error: error.message || String(error) });
    } finally {
      await fs.rm(file, { force: true });
    }
  }

  // A device file or folder (as a zip) to the browser, streamed through.
  // Signed-in sessions only; the SameSite=Strict cookie keeps other sites out.
  async function download(req, res, url) {
    if (!options.sessions.valid(token(req))) return json(res, 401, { error: "Logged out.", loggedOut: true });
    if (!options.download) return json(res, 404, { error: "Downloads are not available." });
    try {
      await options.download(url.searchParams.get("device") || "", url.searchParams.get("path") || "", url.searchParams.get("type") || "file", res);
    } catch (error) {
      if (!res.headersSent) json(res, 400, { error: error.message || String(error) });
      else res.destroy(error);
    }
  }

  async function devicePair(req, res, ip, step) {
    if (options.limiter.blocked(ip)) return json(res, 429, { error: "Too many attempts. Wait a minute and try again." });
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: "Invalid pairing request." });
    }
    try {
      json(res, 200, await options.pair(step, body, ip));
    } catch (error) {
      json(res, error.status || 400, { error: error.message });
    }
  }

  // The app's signed request (X-Odin-Receiver) for a single-use login ticket.
  async function deviceTicket(req, res, ip) {
    await readBody(req);
    const deviceId = options.deviceTicket?.(req.headers["x-odin-receiver"], req.method, req.url, ip);
    if (!deviceId) return json(res, 401, { error: "Not paired with this PC." });
    json(res, 200, { path: `/device/login?ticket=${options.tickets.issue(deviceId, ip)}` });
  }

  // Signs the browser in (taking control, like a password login) and opens
  // that device's library. An HTML hop instead of a redirect, so the browser
  // sends the new SameSite=Strict cookie on the next page.
  function deviceLogin(res, url, ip) {
    const deviceId = options.tickets?.use(url.searchParams.get("ticket") || "", ip);
    const page = (body, head = "") =>
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${head}<title>Odin Sync</title><link rel="stylesheet" href="/style.css"></head><body class="login-page"><main class="login-box panel">${body}</main></body></html>`;
    if (!deviceId) {
      return send(res, 401, page("<p>This sign-in link has expired or was already used. Tap Open Odin Sync in the app again.</p>"), {
        "Content-Type": TYPES[".html"],
      });
    }
    const session = options.sessions.login(ip);
    const target = `/#device=${encodeURIComponent(deviceId)}&view=library`;
    send(res, 200, page(`<p>Signed in. <a href="${target}">Open Odin Sync</a></p>`, `<meta http-equiv="refresh" content="0;url=${target}">`), {
      "Content-Type": TYPES[".html"],
      "Set-Cookie": `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/`,
    });
  }

  async function login(req, res, ip) {
    if (options.limiter.blocked(ip)) {
      return send(res, 429, loginPage("Too many attempts. Wait a minute and try again."), {
        "Content-Type": TYPES[".html"],
      });
    }
    const body = new URLSearchParams(await readBody(req));
    const record = options.password();
    if (!record || !options.verify(body.get("password") || "", record)) {
      options.limiter.fail(ip);
      return send(res, 401, loginPage("Wrong PIN."), { "Content-Type": TYPES[".html"] });
    }
    options.limiter.reset(ip);
    const session = options.sessions.login(ip);
    send(res, 303, "", {
      Location: "/",
      "Set-Cookie": `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/`,
    });
  }

  async function invoke(req, res) {
    // A custom header cannot be sent cross-site without CORS, which is never allowed.
    if (req.headers["x-odin-request"] !== "1")
      return json(res, 403, { error: "Missing request header." });
    const session = token(req);
    if (!options.sessions.valid(session))
      return json(res, 401, { error: "Logged out.", loggedOut: true });
    let request;
    try {
      request = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: "Invalid request." });
    }
    if (!options.channels.includes(request.channel) || !Array.isArray(request.args)) {
      return json(res, 400, { error: "Unsupported operation" });
    }
    try {
      const value = await options.invoke(request.channel, request.args, session);
      json(res, 200, { value: value === undefined ? null : value });
    } catch (error) {
      json(res, 200, { error: error.message || String(error) });
    }
  }

  function events(req, res) {
    const session = token(req);
    if (!options.sessions.valid(session))
      return json(res, 401, { error: "Logged out.", loggedOut: true });
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    const client = { res, session };
    clients.add(client);
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => {
      clearInterval(ping);
      clients.delete(client);
    });
  }

  async function route(req, res) {
    const ip = clientIp(req);
    if (!isLanAddress(ip)) return send(res, 403, "Web access is limited to the local network.");
    const url = new URL(req.url, "http://localhost");
    const signedIn = options.sessions.valid(token(req));
    // The receiver app's install page and APK need no sign-in: they hold nothing private.
    if (req.method === "GET" && url.pathname === "/receiver") return installPage(res);
    if (req.method === "GET" && url.pathname === "/receiver/" + APK_NAME) return serveApk(res);
    if (url.pathname === "/style.css") return serveFile(res, "style.css");
    // A paired Odin Sync app signs in its device's browser with a ticket.
    if (req.method === "POST" && url.pathname === "/device/ticket") return deviceTicket(req, res, ip);
    // The app pairing itself with the PC's PIN (start: key exchange; finish: the sealed PIN).
    if (req.method === "POST" && url.pathname === "/device/pair/start") return devicePair(req, res, ip, "start");
    if (req.method === "POST" && url.pathname === "/device/pair/finish") return devicePair(req, res, ip, "finish");
    if (req.method === "GET" && url.pathname === "/device/login") return deviceLogin(res, url, ip);
    // With web access off, a device signed in by its app still gets the UI.
    if (options.webEnabled && !options.webEnabled() && !signedIn) {
      // Sharing only the installer: the bare address is enough to type.
      if (req.method === "GET" && url.pathname === "/") return send(res, 303, "", { Location: "/receiver" });
      return send(res, 404, "Web access is off.");
    }
    if (req.method === "GET" && url.pathname === "/login") {
      return send(res, 200, loginPage(), { "Content-Type": TYPES[".html"] });
    }
    if (req.method === "POST" && url.pathname === "/login") return login(req, res, ip);
    if (req.method === "POST" && url.pathname === "/logout") {
      if (signedIn) options.sessions.end("logged out");
      return send(res, 303, "", {
        Location: "/login",
        "Set-Cookie": `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      });
    }
    if (req.method === "POST" && url.pathname === "/api/invoke") return invoke(req, res);
    if (req.method === "PUT" && url.pathname === "/api/upload") return upload(req, res, url);
    if (req.method === "GET" && url.pathname === "/api/download") return download(req, res, url);
    if (req.method === "GET" && url.pathname === "/api/events") return events(req, res);
    if (req.method !== "GET") return send(res, 405, "Method not allowed.");
    if (url.pathname === "/style.css") return serveFile(res, "style.css");
    if (!signedIn) return send(res, 303, "", { Location: "/login" });
    const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (!options.files.includes(name)) return send(res, 404, "Not found.");
    return serveFile(res, name);
  }

  // Sends an event to every connected page of the current web session.
  function broadcast(event, data) {
    const text = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
      if (options.sessions.valid(client.session)) client.res.write(text);
    }
  }

  // Tells the pages of an ended session why, then closes their streams.
  function ended(session, reason) {
    for (const client of [...clients]) {
      if (client.session !== session) continue;
      client.res.write(`event: ended\ndata: ${JSON.stringify({ reason })}\n\n`);
      client.res.end();
      clients.delete(client);
    }
  }

  function start(port) {
    return new Promise((resolve, reject) => {
      server = http.createServer((req, res) => {
        route(req, res).catch((error) => {
          if (!res.headersSent) send(res, 500, "Server error: " + error.message);
          else res.end();
        });
      });
      server.once("error", (error) => {
        server = null;
        reject(
          error.code === "EADDRINUSE"
            ? new Error(`Port ${port} is already in use. Choose another port.`)
            : error,
        );
      });
      server.listen(port, options.host || "0.0.0.0", () => resolve(server.address().port));
    });
  }

  function stop() {
    options.sessions.off("ended", onEnded);
    for (const client of clients) client.res.end();
    clients.clear();
    return new Promise((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
      server.closeAllConnections?.();
      server = null;
    });
  }

  // An ended session (replaced, taken back, logged out) is told why at once.
  const onEnded = ({ token: session, reason }) => ended(session, reason);
  options.sessions.on("ended", onEnded);

  return { start, stop, broadcast, ended, running: () => !!server };
}

module.exports = { createWebServer, lanUrls, loginPage, receiverPage, COOKIE, APK_NAME };
