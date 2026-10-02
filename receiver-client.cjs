// Talks to the Odin Sync app on the device: UDP broadcast discovery and
// HMAC-signed HTTP requests (with the key from pairing) for the file
// operations a sync needs. Pairing is started by the app (desktop-link.cjs).
const crypto = require("node:crypto");
const dgram = require("node:dgram");
const http = require("node:http");
const os = require("node:os");
const fs = require("node:fs");
const { Transform } = require("node:stream");

const DISCOVERY_PORT = 47653;
const HTTP_PORT = 47654;

// Broadcast addresses of the PC's IPv4 networks, plus the limited broadcast.
function broadcastAddresses(networks = os.networkInterfaces()) {
  const result = new Set(["255.255.255.255"]);
  for (const addresses of Object.values(networks)) {
    for (const a of addresses || []) {
      if (a.family !== "IPv4" && a.family !== 4) continue;
      if (a.internal || !a.netmask) continue;
      const ip = a.address.split(".").map(Number);
      const mask = a.netmask.split(".").map(Number);
      result.add(ip.map((part, i) => (part & mask[i]) | (~mask[i] & 255)).join("."));
    }
  }
  return [...result];
}

// Sends "odin-sync-hello" and collects the receivers that answer.
function discover({ desktopId, timeout = 1500, targets, port = DISCOVERY_PORT } = {}) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const found = new Map();
    const finish = () => {
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      resolve([...found.values()]);
    };
    socket.on("message", (data, remote) => {
      try {
        const reply = JSON.parse(data.toString("utf8"));
        if (reply.t !== "odin-sync-here" || !reply.id) return;
        found.set(reply.id, { ...reply, host: remote.address, port: reply.httpPort || HTTP_PORT });
      } catch {
        // Not ours.
      }
    });
    socket.on("error", finish);
    socket.bind(0, () => {
      socket.setBroadcast(true);
      const hello = Buffer.from(JSON.stringify({ t: "odin-sync-hello", v: 1, desktopId }));
      for (const address of targets || broadcastAddresses()) {
        socket.send(hello, port, address, () => {});
      }
      setTimeout(finish, timeout);
    });
  });
}

function hmac(key, text) {
  return crypto.createHmac("sha256", key).update(text).digest();
}

function signature(desktopId, key, method, target, time = Date.now()) {
  return `${desktopId}:${time}:${hmac(key, `${method}\n${target}\n${time}`).toString("hex")}`;
}

function request(host, port, method, target, { headers = {}, body = null, stream = null, length = 0, timeout = 30000, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const req = http.request(
      {
        host,
        port,
        method,
        path: target,
        timeout,
        headers: {
          ...headers,
          ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
          // The receiver checks the target before asking for the data, so an
          // early refusal arrives as an answer instead of a broken upload.
          ...(stream ? { "Content-Type": "application/octet-stream", "Content-Length": length, Expect: "100-continue" } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const data = Buffer.concat(chunks);
          if (raw && res.statusCode === 200) return resolve(data);
          let parsed = null;
          try {
            parsed = JSON.parse(data.toString("utf8"));
          } catch {
            parsed = data.toString("utf8");
          }
          if (res.statusCode === 200) resolve(parsed);
          else reject(new Error(parsed?.error || `The device answered ${res.statusCode}.`));
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("The device did not answer in time.")));
    req.on("error", (error) => reject(new Error(error.code === "ECONNREFUSED" ? "The Odin Sync app is not open on the device." : error.message)));
    if (stream) {
      req.on("continue", () => stream.pipe(req));
      req.on("response", () => stream.destroy());
      req.on("close", () => stream.destroy());
    } else req.end(payload);
  });
}

// A paired receiver: the operations a sync needs, signed with the pairing key.
class ReceiverClient {
  constructor({ host, port = HTTP_PORT, desktopId, key }) {
    this.host = host;
    this.port = port;
    this.desktopId = desktopId;
    this.key = Buffer.isBuffer(key) ? key : Buffer.from(key, "base64");
    this.kind = "receiver";
    // Low impact transfers: uploads are paced to this many bytes per second (0: no cap).
    this.maxBytesPerSecond = 0;
  }
  call(method, path, options = {}) {
    const query = options.query ? "?" + new URLSearchParams(options.query).toString() : "";
    const target = path + query;
    return request(this.host, this.port, method, target, {
      ...options,
      headers: { "X-Odin-Auth": signature(this.desktopId, this.key, method, target) },
    });
  }
  hello() {
    return request(this.host, this.port, "GET", "/hello", { headers: { "X-Odin-Desktop": this.desktopId }, timeout: 4000 });
  }
  status() {
    return this.call("GET", "/status", { timeout: 4000 });
  }
  listing(roots) {
    return this.call("POST", "/list", { body: { roots }, timeout: 120000 });
  }
  space(roots) {
    return this.call("POST", "/space", { body: { roots } });
  }
  mkdirs(dirs) {
    return this.call("POST", "/mkdirs", { body: { dirs } });
  }
  remove(files) {
    return this.call("POST", "/remove", { body: { files } });
  }
  rmdirs(dirs) {
    return this.call("POST", "/rmdirs", { body: { dirs } });
  }
  removeTemps(paths) {
    return this.call("POST", "/removeTemps", { body: { paths } });
  }
  async read(path) {
    try {
      return (await this.call("POST", "/read", { body: { path }, raw: true })).toString("utf8");
    } catch (error) {
      if (/Not found/.test(error.message)) return null;
      throw error;
    }
  }
  beginSession(files, bytes) {
    return this.call("POST", "/session/begin", { body: { files, bytes } });
  }
  endSession() {
    return this.call("POST", "/session/end", { body: {} });
  }
  // Uploads one file; the receiver verifies size and SHA-256 before renaming.
  // The file is read once: hashed and counted while it is sent. The receiver
  // keeps it under a temporary name and answers with its own hash; only when
  // the two agree is it committed over the target (otherwise it is removed).
  async upload(source, target, size, mtime, onBytes = () => {}) {
    // A pass-through, not a "data" listener, which would start the file
    // flowing before the receiver asks for it with 100 Continue.
    let sent = 0;
    const hash = crypto.createHash("sha256");
    const rate = this.maxBytesPerSecond;
    const started = Date.now();
    const stream = new Transform({
      highWaterMark: 1024 * 1024,
      transform(chunk, _encoding, done) {
        sent += chunk.length;
        hash.update(chunk);
        onBytes(sent);
        // Paced: wait until this much data is due at the capped rate.
        const wait = rate ? started + (sent / rate) * 1000 - Date.now() : 0;
        if (wait > 0) setTimeout(() => done(null, chunk), wait);
        else done(null, chunk);
      },
    });
    const file = fs.createReadStream(source, { highWaterMark: 1024 * 1024 });
    file.on("error", (error) => stream.destroy(error));
    stream.on("close", () => file.destroy());
    file.pipe(stream);
    const answer = await this.call("PUT", "/file", {
      query: { path: target },
      stream,
      length: size,
      timeout: 600000,
    });
    const sha256 = hash.digest("hex");
    if (sent !== size || answer.sha256 !== sha256) {
      await this.removeTemps([answer.temporary]).catch(() => {});
      throw new Error("The copy on the device failed checksum verification and was removed.");
    }
    await this.call("POST", "/commit", {
      body: { temporary: answer.temporary, path: target, sha256, mtime: mtime || 0, size },
    });
  }
  // sizes: add up each folder's size on the device (takes a moment for big trees).
  browse(path, foldersOnly, sizes) {
    const query = { path: path || "/storage" };
    if (foldersOnly) query.foldersOnly = "1";
    if (sizes) query.sizes = "1";
    return this.call("GET", "/browse", { query });
  }
  // A device file as a readable stream (the HTTP response), for downloads.
  download(path) {
    const target = "/download?" + new URLSearchParams({ path }).toString();
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: this.host,
          port: this.port,
          method: "GET",
          path: target,
          timeout: 60000,
          headers: { "X-Odin-Auth": signature(this.desktopId, this.key, "GET", target) },
        },
        (res) => {
          if (res.statusCode === 200) return resolve(res);
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            let message = `The device answered ${res.statusCode}.`;
            try {
              message = JSON.parse(Buffer.concat(chunks).toString("utf8")).error || message;
            } catch {
              // Not JSON.
            }
            reject(new Error(message));
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("The device did not answer in time.")));
      req.on("error", (error) => reject(new Error(error.message)));
      req.end();
    });
  }
  // A folder's total size and file count ({size, files}; size -1 if too big to add up quickly).
  folderSize(path) {
    return this.call("GET", "/size", { query: { path }, timeout: 15000 });
  }
  mkdir(parent, name) {
    return this.call("POST", "/mkdir", { body: { parent, name } });
  }
  delete(path, type, fingerprint) {
    return this.call("POST", "/delete", { body: { path, type, fingerprint } });
  }
}

module.exports = {
  discover,
  ReceiverClient,
  signature,
  broadcastAddresses,
  DISCOVERY_PORT,
  HTTP_PORT,
};
