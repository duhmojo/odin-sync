// The Odin Sync app finding this PC: it announces itself over UDP (to the PC's
// last address, then by broadcast), signed with the key from pairing. The PC
// records where the app is now and answers with its own name and web port,
// also signed, so the app can update where the PC is. The app can then ask for
// a single-use login ticket that opens the web UI on that device.
const crypto = require("node:crypto");
const dgram = require("node:dgram");

const APP_PORT = 47655;
const SKEW_MS = 5 * 60 * 1000;
const TICKET_MS = 60 * 1000;

function hmac(key, text) {
  return crypto.createHmac("sha256", key).update(text).digest("hex");
}

function equal(a, b) {
  return typeof a === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function fresh(time, now = Date.now()) {
  return Number.isFinite(Number(time)) && Math.abs(now - Number(time)) <= SKEW_MS;
}

// What the app sends, and what the PC answers. Both sides sign the same way.
function appSignature(key, receiverId, time) {
  return hmac(key, `app\n${receiverId}\n${time}`);
}

function desktopSignature(key, desktopId, time, webPort) {
  return hmac(key, `desktop\n${desktopId}\n${time}\n${webPort}`);
}

// "receiverId:time:hmac" over METHOD\nTARGET\nTIME, for HTTP calls from the app.
function verifyAppRequest(header, method, target, keyFor, now = Date.now()) {
  const [receiverId, time, mac] = String(header || "").split(":");
  const key = receiverId && keyFor(receiverId);
  if (!key || !fresh(time, now)) return null;
  return equal(mac, hmac(key, `${method}\n${target}\n${time}`)) ? receiverId : null;
}

// options: { port, host, desktopId(), desktopName(), webPort(), keyFor(receiverId) -> Buffer|null,
//            seen(receiverId, {host, port}) }
function createAppListener(options) {
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  socket.on("message", (data, remote) => {
    let hello;
    try {
      hello = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }
    // An unpaired app looking for PCs: who we are and where to pair.
    if (hello?.t === "odin-sync-find") {
      const reply = { t: "odin-sync-pc", desktopId: options.desktopId(), name: options.desktopName(), webPort: options.webPort() };
      socket.send(Buffer.from(JSON.stringify(reply)), remote.port, remote.address);
      return;
    }
    if (hello?.t !== "odin-sync-app" || typeof hello.id !== "string") return;
    if (hello.desktopId && hello.desktopId !== options.desktopId()) return;
    const key = options.keyFor(hello.id);
    if (!key || !fresh(hello.time) || !equal(hello.sig, appSignature(key, hello.id, hello.time))) return;
    options.seen(hello.id, {
      host: remote.address,
      port: Number(hello.httpPort) || 47654,
      app: Number.isInteger(hello.appVersion) ? { versionCode: hello.appVersion, versionName: String(hello.appVersionName || "") } : null,
      filesAccess: typeof hello.filesAccess === "boolean" ? hello.filesAccess : null,
    });
    const time = Date.now();
    const webPort = options.webPort();
    const reply = {
      t: "odin-sync-desktop",
      // The app version this PC carries: a newer one is offered as an update.
      app: options.app?.() || null,
      desktopId: options.desktopId(),
      name: options.desktopName(),
      webPort,
      time,
      sig: desktopSignature(key, options.desktopId(), time, webPort),
    };
    socket.send(Buffer.from(JSON.stringify(reply)), remote.port, remote.address);
  });
  socket.on("error", () => {});
  return {
    start: () =>
      new Promise((resolve, reject) => {
        socket.once("error", reject);
        socket.bind(options.port ?? APP_PORT, options.host || "0.0.0.0", () => resolve(socket.address().port));
      }),
    stop: () => new Promise((resolve) => socket.close(() => resolve())),
  };
}

// Single-use login tickets: valid for a minute, only from the IP that asked.
class Tickets {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.tickets = new Map();
  }
  issue(deviceId, ip) {
    for (const [token, t] of this.tickets) if (t.expires < this.now()) this.tickets.delete(token);
    const token = crypto.randomBytes(32).toString("hex");
    this.tickets.set(token, { deviceId, ip, expires: this.now() + TICKET_MS });
    return token;
  }
  use(token, ip) {
    const ticket = this.tickets.get(token);
    this.tickets.delete(token);
    if (!ticket || ticket.expires < this.now() || ticket.ip !== ip) return null;
    return ticket.deviceId;
  }
}

// Pairing started from the app: an ECDH key exchange (P-256), then the app
// sends the PC's PIN encrypted with the agreed key (AES-256-GCM), so the PIN
// never crosses the network in the clear. The agreed key signs everything
// afterwards, as in earlier pairings.
const PAIRING_MS = 2 * 60 * 1000;

function sharedKey(privateKey, theirSpkiBase64) {
  const theirs = crypto.createPublicKey({ key: Buffer.from(theirSpkiBase64, "base64"), format: "der", type: "spki" });
  const secret = crypto.diffieHellman({ privateKey, publicKey: theirs });
  return crypto.createHash("sha256").update(Buffer.concat([secret, Buffer.from("odin-sync v1")])).digest();
}

function pinKey(key) {
  return crypto.createHmac("sha256", key).update("odin-sync pin key").digest();
}

// What the app does (and the tests): the PIN encrypted for the PC.
function sealPin(key, receiverId, pin) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", pinKey(key), iv);
  cipher.setAAD(Buffer.from(receiverId));
  const data = Buffer.concat([cipher.update(pin, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { iv: iv.toString("base64"), pin: data.toString("base64") };
}

function openPin(key, receiverId, sealed) {
  const data = Buffer.from(String(sealed.pin || ""), "base64");
  if (data.length < 17) throw new Error("Invalid pairing request.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", pinKey(key), Buffer.from(String(sealed.iv || ""), "base64"));
  decipher.setAAD(Buffer.from(receiverId));
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString("utf8");
}

class Pairings {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.pending = new Map();
  }
  // body: {receiverId, name, httpPort, publicKey}. Returns the PC's public key.
  start(body) {
    if (typeof body?.receiverId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.receiverId)) {
      throw new Error("Invalid pairing request.");
    }
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const key = sharedKey(privateKey, String(body.publicKey || ""));
    this.pending.set(body.receiverId, {
      key,
      name: String(body.name || "Android device").slice(0, 80),
      httpPort: Number(body.httpPort) || 47654,
      gpu: String(body.gpu || "").slice(0, 120),
      expires: this.now() + PAIRING_MS,
    });
    return publicKey.export({ type: "spki", format: "der" }).toString("base64");
  }
  // Returns {key, name, httpPort, gpu, pin} for the app's sealed PIN (checked by the caller).
  finish(body) {
    const pending = this.pending.get(body?.receiverId);
    if (!pending || pending.expires < this.now()) {
      this.pending.delete(body?.receiverId);
      throw new Error("Pairing timed out. Try again from the app.");
    }
    let pin;
    try {
      pin = openPin(pending.key, body.receiverId, body);
    } catch {
      throw new Error("Invalid pairing request.");
    }
    return { ...pending, pin };
  }
  done(receiverId) {
    this.pending.delete(receiverId);
  }
}

// The PC's ARP table as {mac: ip} (MACs lower-case with colons).
function parseArp(output) {
  const table = {};
  for (const line of output.split(/\r?\n/)) {
    const ip = (line.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/) || [])[1];
    const mac = (line.match(/\b([0-9a-f]{2}(?:[-:][0-9a-f]{2}){5})\b/i) || [])[1];
    if (ip && mac) table[mac.toLowerCase().replace(/-/g, ":")] = ip;
  }
  return table;
}

function readArp() {
  return new Promise((resolve) => {
    require("node:child_process").execFile("arp", ["-a"], { timeout: 5000, windowsHide: true }, (error, stdout) =>
      resolve(error ? {} : parseArp(String(stdout))),
    );
  });
}

module.exports = {
  Pairings,
  sharedKey,
  sealPin,
  openPin,
  parseArp,
  readArp,
  APP_PORT,
  appSignature,
  desktopSignature,
  verifyAppRequest,
  createAppListener,
  Tickets,
};
