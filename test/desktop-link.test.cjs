const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const dgram = require("node:dgram");
const path = require("node:path");
const link = require("../desktop-link.cjs");
const { Sessions, RateLimiter, verifyPassword } = require("../web-session.cjs");
const { createWebServer, COOKIE } = require("../web-server.cjs");

const KEY = Buffer.alloc(32, 9);
const RECEIVER = "11111111-2222-3333-4444-555555555555";

function ask(port, message) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const timer = setTimeout(() => {
      socket.close();
      resolve(null);
    }, 500);
    socket.on("message", (data) => {
      clearTimeout(timer);
      socket.close();
      resolve(JSON.parse(data.toString()));
    });
    socket.send(Buffer.from(JSON.stringify(message)), port, "127.0.0.1");
  });
}

test("the PC records a signed app announcement and answers with a signed reply", async (t) => {
  const seen = [];
  const listener = link.createAppListener({
    port: 0,
    host: "127.0.0.1",
    desktopId: () => "pc-1",
    desktopName: () => "Gaming PC",
    webPort: () => 8765,
    app: () => ({ versionCode: 702, versionName: "0.7.1" }),
    keyFor: (id) => (id === RECEIVER ? KEY : null),
    seen: (id, where) => seen.push({ id, ...where }),
  });
  const port = await listener.start();
  t.after(() => listener.stop());
  const time = Date.now();
  const hello = { t: "odin-sync-app", id: RECEIVER, desktopId: "pc-1", httpPort: 47654, appVersion: 701, appVersionName: "0.7.0", filesAccess: false, time };
  const reply = await ask(port, { ...hello, sig: link.appSignature(KEY, RECEIVER, time) });
  assert.equal(reply.name, "Gaming PC");
  assert.equal(reply.webPort, 8765);
  assert.deepEqual(reply.app, { versionCode: 702, versionName: "0.7.1" }, "the newer app this PC carries");
  assert.equal(reply.sig, link.desktopSignature(KEY, "pc-1", reply.time, 8765));
  assert.deepEqual(seen, [{ id: RECEIVER, host: "127.0.0.1", port: 47654, app: { versionCode: 701, versionName: "0.7.0" }, filesAccess: false }]);
  // Wrong key, stale time, or another PC's id: no answer, nothing recorded.
  assert.equal(await ask(port, { ...hello, sig: link.appSignature(Buffer.alloc(32), RECEIVER, time) }), null);
  const old = time - 10 * 60 * 1000;
  assert.equal(await ask(port, { ...hello, time: old, sig: link.appSignature(KEY, RECEIVER, old) }), null);
  assert.equal(await ask(port, { ...hello, desktopId: "pc-2", sig: link.appSignature(KEY, RECEIVER, time) }), null);
  assert.equal(seen.length, 1);
});

test("login tickets are single-use, short-lived and tied to the asking IP", () => {
  let now = 1000;
  const tickets = new link.Tickets(() => now);
  const a = tickets.issue("dev-1", "192.168.2.197");
  assert.equal(tickets.use(a, "192.168.2.50"), null, "another IP");
  const b = tickets.issue("dev-1", "192.168.2.197");
  assert.equal(tickets.use(b, "192.168.2.197"), "dev-1");
  assert.equal(tickets.use(b, "192.168.2.197"), null, "used once");
  const c = tickets.issue("dev-1", "192.168.2.197");
  now += 61000;
  assert.equal(tickets.use(c, "192.168.2.197"), null, "expired");
});

test("the app gets a ticket that signs its browser in, even with web access off", async (t) => {
  const sessions = new Sessions();
  const tickets = new link.Tickets();
  const web = createWebServer({
    root: path.join(__dirname, ".."),
    files: ["index.html"],
    sessions,
    limiter: new RateLimiter(),
    password: () => null,
    verify: verifyPassword,
    channels: [],
    invoke: async () => null,
    host: "127.0.0.1",
    webEnabled: () => false,
    tickets,
    deviceTicket: (header, method, target) =>
      link.verifyAppRequest(header, method, target, (id) => (id === RECEIVER ? KEY : null)) ? "dev-1" : null,
  });
  const port = await web.start(0);
  t.after(() => web.stop());
  const base = `http://127.0.0.1:${port}`;
  const sign = (key, time = Date.now()) =>
    `${RECEIVER}:${time}:${crypto.createHmac("sha256", key).update(`POST\n/device/ticket\n${time}`).digest("hex")}`;
  const refused = await fetch(`${base}/device/ticket`, { method: "POST", headers: { "X-Odin-Receiver": sign(Buffer.alloc(32)) } });
  assert.equal(refused.status, 401);
  const answer = await (await fetch(`${base}/device/ticket`, { method: "POST", headers: { "X-Odin-Receiver": sign(KEY) } })).json();
  assert.match(answer.path, /^\/device\/login\?ticket=[0-9a-f]{64}$/);
  const login = await fetch(base + answer.path);
  assert.equal(login.status, 200);
  assert.match(await login.text(), /#device=dev-1&amp;view=library|#device=dev-1&view=library/);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.ok(cookie.startsWith(COOKIE + "="));
  assert.equal((await fetch(base + "/", { headers: { cookie } })).status, 200, "the UI with the device session");
  assert.equal((await fetch(base + "/", { redirect: "manual" })).status, 303, "without it: the installer");
  assert.equal((await fetch(base + answer.path)).status, 401, "the ticket works once");
});

test("the app pairs with the PC's PIN, sent sealed under the agreed key; a wrong PIN counts against the address", async (t) => {
  const { hashPin } = require("../web-session.cjs");
  const record = hashPin("246810");
  const limiter = new RateLimiter(3);
  const pairings = new link.Pairings();
  const saved = [];
  const web = createWebServer({
    root: path.join(__dirname, ".."),
    files: [],
    sessions: new Sessions(),
    limiter,
    password: () => record,
    verify: verifyPassword,
    channels: [],
    invoke: async () => null,
    host: "127.0.0.1",
    // The same checks main.cjs makes.
    pair: async (step, body, ip) => {
      if (step === "start") return { publicKey: pairings.start(body), desktopId: "pc-1", name: "Gaming PC" };
      const pending = pairings.finish(body);
      if (!verifyPassword(pending.pin, record)) {
        limiter.fail(ip);
        throw Object.assign(new Error("Wrong PIN."), { status: 401 });
      }
      saved.push({ id: body.receiverId, key: pending.key, name: pending.name });
      return { ok: true, desktopId: "pc-1", proof: crypto.createHmac("sha256", pending.key).update("paired\n" + body.receiverId).digest("hex") };
    },
  });
  const port = await web.start(0);
  t.after(() => web.stop());
  const post = async (target, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${target}`, { method: "POST", body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  // The app's side.
  async function pair(pin) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const started = await post("/device/pair/start", {
      receiverId: RECEIVER,
      name: "Odin2 Portal",
      publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    });
    const key = link.sharedKey(privateKey, started.body.publicKey);
    const sealed = link.sealPin(key, RECEIVER, pin);
    assert.ok(!JSON.stringify(sealed).includes(pin), "the PIN is not sent in the clear");
    return { key, finished: await post("/device/pair/finish", { receiverId: RECEIVER, ...sealed }) };
  }
  const wrong = await pair("111111");
  assert.equal(wrong.finished.status, 401);
  assert.equal(saved.length, 0);
  const right = await pair("246810");
  assert.equal(right.finished.status, 200);
  assert.deepEqual(saved.map((s) => [s.id, s.name]), [[RECEIVER, "Odin2 Portal"]]);
  assert.ok(saved[0].key.equals(right.key), "both sides hold the same key");
  assert.equal(right.finished.body.proof, crypto.createHmac("sha256", right.key).update("paired\n" + RECEIVER).digest("hex"));
  // A third wrong PIN (the limit here) and the address has to wait.
  assert.equal((await pair("000000")).finished.status, 401);
  assert.equal((await pair("000000")).finished.status, 401);
  assert.equal((await post("/device/pair/start", { receiverId: RECEIVER })).status, 429);
});
