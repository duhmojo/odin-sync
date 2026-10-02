// A Node version of the Android receiver app (android-receiver/), speaking the
// same protocol: UDP discovery, pairing with the PC's PIN (pairWith), signed
// requests, and file operations on a folder that stands in for the device's
// shared storage.
// Used by the unit and end-to-end tests. Run directly: node fake-receiver.cjs <root>
const crypto = require("node:crypto");
const dgram = require("node:dgram");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const link = require("../desktop-link.cjs");

const LISTING_END = "__ODIN_SYNC_LISTING_END__";
const TEMP_NAME = /\.odin-sync-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.part$/;

function hmac(key, text) {
  return crypto.createHmac("sha256", key).update(text).digest();
}

// Pass the id and paired map of an earlier instance to reopen "the same app".
function createFakeReceiver({
  root,
  name = "Fake Odin",
  httpPort = 0,
  discoveryPort = 0,
  host = "127.0.0.1",
  id = crypto.randomUUID(),
  paired = new Map(),
}) {
  const state = { session: null, received: [], corrupt: false, offline: false, uploads: 0, dropAfter: Infinity };
  const uploads = new Map();
  const local = (devicePath) => {
    if (typeof devicePath !== "string" || !devicePath.startsWith("/") || devicePath.split("/").includes("..")) {
      throw new Error("Invalid path.");
    }
    const canonical = devicePath.replace(/^\/sdcard(?=\/|$)/, "/storage/emulated/0").replace(/\/+$/, "");
    if (!canonical.startsWith("/storage")) throw new Error("Only shared storage and SD cards are allowed.");
    return path.join(root, ...canonical.split("/").filter(Boolean));
  };

  function verify(req) {
    const header = req.headers["x-odin-auth"] || "";
    const [desktopId, time, mac] = header.split(":");
    const key = paired.get(desktopId);
    if (!key || Math.abs(Date.now() - Number(time)) > 300000) return null;
    const expected = hmac(key, `${req.method}\n${req.url}\n${time}`).toString("hex");
    return expected === mac ? desktopId : null;
  }

  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
    });
  const json = async (req) => {
    const text = (await readBody(req)).toString("utf8");
    return text ? JSON.parse(text) : {};
  };

  function walk(dir, shown, lines) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(child, `${shown}/${entry.name}`, lines);
      else lines.push(`${fs.statSync(child).size}|${shown}/${entry.name}`);
    }
  }

  // The storage browser's JSON, as the app's FileOps.browse makes it.
  const VOLUME = { id: "internal", path: "/storage/emulated/0", label: "Internal storage", kind: "internal", readOnly: false };
  function browse(devicePath, foldersOnly) {
    if (!devicePath || devicePath === "/storage") {
      return {
        volumes: [VOLUME],
        path: "/storage",
        parent: null,
        writable: false,
        hiddenFiles: 0,
        entries: [{ name: VOLUME.label, path: VOLUME.path, type: "volume", volumeKind: "internal", navigable: true, readable: true, writable: true }],
      };
    }
    const canonical = devicePath.replace(/^\/sdcard(?=\/|$)/, VOLUME.path).replace(/\/+$/, "");
    const dir = local(canonical);
    let hidden = 0;
    const entries = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() && foldersOnly) {
        hidden++;
        continue;
      }
      const stat = fs.statSync(path.join(dir, entry.name));
      entries.push({
        name: entry.name,
        path: `${canonical}/${entry.name}`,
        type: entry.isDirectory() ? "folder" : "file",
        size: entry.isDirectory() ? 0 : stat.size,
        modified: Math.floor(stat.mtimeMs),
        readable: true,
        writable: true,
        navigable: entry.isDirectory(),
        fingerprint: `${entry.isDirectory() ? 0 : stat.size} ${Math.floor(stat.mtimeMs)}`,
      });
    }
    entries.sort((a, b) => Number(b.type === "folder") - Number(a.type === "folder") || a.name.localeCompare(b.name));
    return {
      volumes: [VOLUME],
      volume: VOLUME,
      path: canonical,
      parent: canonical === VOLUME.path ? "/storage" : path.posix.dirname(canonical),
      writable: true,
      entries,
      hiddenFiles: hidden,
      warnings: [],
    };
  }

  async function route(req, res) {
    // state.offline: the app is closed (no answers); state.dropAfter: the
    // connection drops at that upload, and the app stays unreachable.
    if (state.offline) return req.socket.destroy();
    if (req.method === "PUT" && ++state.uploads >= state.dropAfter) {
      state.offline = true;
      return req.socket.destroy();
    }
    const url = new URL(req.url, "http://x");
    const send = (status, value, type = "application/json") => {
      const body = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
      res.writeHead(status, { "Content-Type": type, "Content-Length": body.length });
      res.end(body);
    };
    if (req.method === "GET" && url.pathname === "/hello") {
      return send(200, { app: "odin-sync-receiver", version: 2, id, name, paired: paired.has(req.headers["x-odin-desktop"]), state: "Standby" });
    }
    if (!verify(req)) return send(401, { error: "Not paired with this PC." });
    const key = `${req.method} ${url.pathname}`;
    if (key === "POST /list") {
      const lines = [];
      for (const r of (await json(req)).roots) walk(local(r), r.replace(/\/+$/, ""), lines);
      return send(200, [...lines, LISTING_END].join("\n") + "\n", "text/plain");
    }
    if (key === "POST /space") {
      const body = await json(req);
      return send(200, body.roots.map((r) => ({ root: r, total: 100e9, available: Number(process.env.FAKE_RECEIVER_FREE || 50e9), mount: "/storage/emulated/0" })));
    }
    if (key === "POST /mkdirs") {
      for (const d of (await json(req)).dirs) fs.mkdirSync(local(d), { recursive: true });
      return send(200, { ok: true });
    }
    if (key === "PUT /file") {
      const target = local(url.searchParams.get("path"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const data = await readBody(req);
      // state.corrupt makes the stored copy differ from what was sent.
      if (state.corrupt) data[0] ^= 1;
      const temporary = `${url.searchParams.get("path")}.odin-sync-${crypto.randomUUID()}.part`;
      fs.writeFileSync(local(temporary), data);
      const sha256 = crypto.createHash("sha256").update(data).digest("hex");
      uploads.set(temporary, sha256);
      return send(200, { temporary, sha256 });
    }
    if (key === "POST /commit") {
      const body = await json(req);
      const sha = uploads.get(body.temporary);
      uploads.delete(body.temporary);
      if (!sha || !body.temporary.startsWith(body.path + ".odin-sync-")) return send(400, { error: "Unknown upload." });
      if (sha !== body.sha256) {
        fs.rmSync(local(body.temporary), { force: true });
        return send(400, { error: "The copy failed checksum verification and was removed." });
      }
      fs.renameSync(local(body.temporary), local(body.path));
      state.received.push(body.path);
      return send(200, { ok: true });
    }
    if (key === "POST /remove") {
      const removed = [];
      (await json(req)).files.forEach((f, i) => {
        const file = local(f.path);
        if (fs.existsSync(file) && fs.statSync(file).size === f.size) {
          fs.rmSync(file);
          removed.push(i);
        }
      });
      return send(200, { removed });
    }
    if (key === "POST /rmdirs") {
      for (const d of (await json(req)).dirs) {
        try {
          fs.rmdirSync(local(d));
        } catch {
          // Not empty.
        }
      }
      return send(200, { ok: true });
    }
    if (key === "POST /removeTemps") {
      for (const p of (await json(req)).paths) if (TEMP_NAME.test(p)) fs.rmSync(local(p), { force: true });
      return send(200, { ok: true });
    }
    if (key === "POST /read") {
      const file = local((await json(req)).path);
      return fs.existsSync(file) ? send(200, fs.readFileSync(file), "application/octet-stream") : send(404, { error: "Not found" });
    }
    if (key === "POST /session/begin") {
      state.session = await json(req);
      return send(200, { ok: true });
    }
    if (key === "POST /session/end") {
      await json(req);
      state.session = null;
      return send(200, { ok: true });
    }
    if (key === "GET /status") return send(200, { state: "Standby", percent: -1 });
    if (key === "GET /download") {
      const file = local(url.searchParams.get("path"));
      return fs.existsSync(file) ? send(200, fs.readFileSync(file), "application/octet-stream") : send(404, { error: "Not found" });
    }
    if (key === "GET /size") {
      let size = 0;
      let files = 0;
      const add = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) add(full);
          else {
            size += fs.statSync(full).size;
            files++;
          }
        }
      };
      add(local(url.searchParams.get("path")));
      return send(200, { size, files });
    }
    if (key === "GET /browse") return send(200, browse(url.searchParams.get("path"), url.searchParams.get("foldersOnly") === "1"));
    if (key === "POST /mkdir") {
      const body = await json(req);
      fs.mkdirSync(path.join(local(body.parent), body.name));
      return send(200, { ok: true });
    }
    if (key === "POST /delete") {
      const body = await json(req);
      const file = local(body.path);
      if (body.type === "folder") fs.rmSync(file, { recursive: true });
      else fs.rmSync(file);
      return send(200, { ok: true });
    }
    return send(404, { error: "Unknown request." });
  }

  const server = http.createServer((req, res) =>
    route(req, res).catch((error) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }),
  );
  const udp = dgram.createSocket({ type: "udp4", reuseAddr: true });
  udp.on("message", (data, remote) => {
    try {
      const hello = JSON.parse(data.toString());
      if (hello.t !== "odin-sync-hello" || state.offline) return;
      const reply = { t: "odin-sync-here", version: 2, id, name, httpPort: server.address().port, paired: paired.has(hello.desktopId), state: "Standby" };
      udp.send(Buffer.from(JSON.stringify(reply)), remote.port, remote.address);
    } catch {
      // Not ours.
    }
  });
  return {
    id,
    state,
    paired,
    // What the app does when the person enters the PC's PIN: key exchange,
    // then the PIN sealed with the agreed key. Resolves with the PC's answer.
    async pairWith(host, webPort, pin) {
      const post = async (target, body) => {
        const response = await fetch(`http://${host}:${webPort}${target}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const answer = await response.json();
        if (!response.ok) throw new Error(answer.error || String(response.status));
        return answer;
      };
      const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const started = await post("/device/pair/start", {
        receiverId: id,
        name,
        httpPort: server.address().port,
        gpu: "Fake GPU",
        publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      });
      const key = link.sharedKey(privateKey, started.publicKey);
      const answer = await post("/device/pair/finish", { receiverId: id, ...link.sealPin(key, id, pin) });
      paired.set(started.desktopId, key);
      return answer;
    },
    async start() {
      await new Promise((resolve) => server.listen(httpPort, host, resolve));
      await new Promise((resolve) => udp.bind(discoveryPort, host, resolve));
      this.ports = { httpPort: server.address().port, discoveryPort: udp.address().port };
      return this.ports;
    },
    async stop() {
      udp.close();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { createFakeReceiver };

if (require.main === module) {
  const receiver = createFakeReceiver({
    root: process.argv[2],
    httpPort: Number(process.env.FAKE_RECEIVER_HTTP || 47654),
    discoveryPort: Number(process.env.FAKE_RECEIVER_UDP || 47653),
  });
  receiver.start().then((ports) => console.log("FAKE_RECEIVER", JSON.stringify(ports)));
}
