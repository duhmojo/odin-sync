const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  hashPassword,
  verifyPassword,
  isLanAddress,
  RateLimiter,
  Sessions,
  OperationLock,
} = require("../web-session.cjs");
const { createWebServer } = require("../web-server.cjs");

test("passwords are stored as salted scrypt hashes and verified", () => {
  const record = hashPassword("correct horse");
  assert.ok(!JSON.stringify(record).includes("correct horse"));
  assert.notEqual(hashPassword("correct horse").salt, record.salt, "a new salt every time");
  assert.equal(verifyPassword("correct horse", record), true);
  assert.equal(verifyPassword("wrong horse", record), false);
  assert.throws(() => hashPassword("short"), /at least 8/);
});

test("only loopback, private and link-local addresses are accepted", () => {
  for (const ip of [
    "127.0.0.1",
    "::1",
    "::ffff:192.168.2.197",
    "10.1.2.3",
    "172.20.0.5",
    "169.254.1.1",
    "fe80::1",
  ]) {
    assert.equal(isLanAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "172.32.0.1", "192.169.1.1", "::ffff:1.1.1.1", "2001:db8::1", ""]) {
    assert.equal(isLanAddress(ip), false, ip);
  }
});

test("login attempts are limited per address", () => {
  let now = 0;
  const limiter = new RateLimiter(5, 60000, () => now);
  for (let i = 0; i < 5; i++) limiter.fail("10.0.0.2");
  assert.equal(limiter.blocked("10.0.0.2"), true);
  assert.equal(limiter.blocked("10.0.0.3"), false);
  now = 61000;
  assert.equal(limiter.blocked("10.0.0.2"), false, "the window moves on");
});

test("one controller: a web login takes over, a newer login replaces it, the PC can take back", () => {
  const sessions = new Sessions();
  const ended = [];
  sessions.on("ended", (e) => ended.push(e.reason));
  assert.equal(sessions.allowed("app"), true);
  const first = sessions.login("192.168.2.197");
  assert.equal(sessions.controller(), "web");
  assert.equal(sessions.allowed("app"), false, "the desktop is paused");
  assert.equal(sessions.allowed("web", first), true);
  const second = sessions.login("192.168.2.50");
  assert.equal(sessions.allowed("web", first), false, "the older web session is replaced");
  assert.equal(sessions.allowed("web", second), true);
  assert.deepEqual(ended, ["replaced"]);
  sessions.end("taken back");
  assert.equal(sessions.allowed("web", second), false);
  assert.equal(sessions.allowed("app"), true);
  assert.deepEqual(ended, ["replaced", "taken back"]);
});

test("the operation lock refuses a second destructive call and names the first", async () => {
  const lock = new OperationLock();
  let release;
  const first = lock.run("a sync", "web", () => new Promise((resolve) => (release = resolve)));
  await assert.rejects(
    lock.run("deleting on the device", "app", async () => {}),
    /Busy: a sync started from the web/,
  );
  release();
  await first;
  assert.equal(await lock.run("deleting on the device", "app", async () => "done"), "done");
});

async function server(t, invoke = async (channel) => ({ channel })) {
  const sessions = new Sessions();
  const record = hashPassword("password123");
  const web = createWebServer({
    root: path.join(__dirname, ".."),
    files: ["index.html", "style.css", "web-bridge.js"],
    sessions,
    limiter: new RateLimiter(),
    password: () => record,
    verify: verifyPassword,
    channels: ["config:get", "sync:start"],
    invoke,
    host: "127.0.0.1",
  });
  const port = await web.start(0);
  t.after(() => web.stop());
  return { base: `http://127.0.0.1:${port}`, sessions, web };
}

async function login(base, password = "password123") {
  const response = await fetch(base + "/login", {
    method: "POST",
    body: new URLSearchParams({ password }),
    redirect: "manual",
  });
  const cookie = (response.headers.get("set-cookie") || "").split(";")[0];
  return { response, cookie };
}

test("HTTP: the UI needs a login; the session cookie is HttpOnly and SameSite=Strict", async (t) => {
  const { base } = await server(t);
  const page = await fetch(base + "/", { redirect: "manual" });
  assert.equal(page.status, 303);
  assert.equal(page.headers.get("location"), "/login");
  const loginPage = await fetch(base + "/login");
  assert.match(await loginPage.text(), /type="password"/);
  assert.match(loginPage.headers.get("content-security-policy"), /default-src 'self'/);
  const wrong = await login(base, "nope");
  assert.equal(wrong.response.status, 401);
  const { response, cookie } = await login(base);
  assert.equal(response.status, 303);
  assert.match(response.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  const index = await fetch(base + "/", { headers: { cookie } });
  const html = await index.text();
  assert.match(html, /<script src="web-bridge.js"><\/script>/, "the web page gets the HTTP bridge");
  const hidden = await fetch(base + "/main.cjs", { headers: { cookie } });
  assert.equal(hidden.status, 404, "only whitelisted files are served");
});

test("HTTP: /api/invoke needs the session, the custom header and a known channel", async (t) => {
  const { base } = await server(t);
  const { cookie } = await login(base);
  const call = (headers, body) =>
    fetch(base + "/api/invoke", {
      method: "POST",
      headers: { cookie, ...headers },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await call({}, { channel: "config:get", args: [] })).status,
    403,
    "no custom header",
  );
  const ok = await call({ "X-Odin-Request": "1" }, { channel: "config:get", args: [] });
  assert.deepEqual(await ok.json(), { value: { channel: "config:get" } });
  const unknown = await call({ "X-Odin-Request": "1" }, { channel: "evil", args: [] });
  assert.equal(unknown.status, 400);
  const anonymous = await fetch(base + "/api/invoke", {
    method: "POST",
    headers: { "X-Odin-Request": "1" },
    body: JSON.stringify({ channel: "config:get", args: [] }),
  });
  assert.equal(anonymous.status, 401);
});

test("HTTP: five wrong passwords block the address for a minute", async (t) => {
  const { base } = await server(t);
  for (let i = 0; i < 5; i++) assert.equal((await login(base, "wrong")).response.status, 401);
  assert.equal((await login(base)).response.status, 429, "even the right password waits");
});

test("HTTP: when the PC takes back control, the web page is told and its calls stop", async (t) => {
  const { base, sessions } = await server(t);
  const { cookie } = await login(base);
  const events = await fetch(base + "/api/events", { headers: { cookie } });
  const reader = events.body.getReader();
  await reader.read(); // ": connected"
  sessions.end("taken back");
  let text = "";
  while (!text.includes("event: ended"))
    text += new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /"reason":"taken back"/);
  const after = await fetch(base + "/api/invoke", {
    method: "POST",
    headers: { cookie, "X-Odin-Request": "1" },
    body: JSON.stringify({ channel: "config:get", args: [] }),
  });
  assert.equal(after.status, 401);
});

test("the receiver install page and APK are served without sign-in; the rest needs web access", async (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const apk = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "odin-apk-")), "odin-sync-receiver.apk");
  fs.writeFileSync(apk, Buffer.alloc(4096, 1));
  t.after(() => fs.rmSync(path.dirname(apk), { recursive: true, force: true }));
  let enabled = false;
  const web = createWebServer({
    root: path.join(__dirname, ".."),
    files: ["index.html"],
    sessions: new Sessions(),
    limiter: new RateLimiter(),
    password: () => null,
    verify: verifyPassword,
    channels: [],
    invoke: async () => null,
    host: "127.0.0.1",
    webEnabled: () => enabled,
    apk,
  });
  const port = await web.start(0);
  t.after(() => web.stop());
  const base = `http://127.0.0.1:${port}`;
  const page = await fetch(`${base}/receiver`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Download the Odin Sync app \(4 KB\)/);
  const file = await fetch(`${base}/receiver/odin-sync-receiver.apk`);
  assert.equal(file.headers.get("content-type"), "application/vnd.android.package-archive");
  assert.equal((await file.arrayBuffer()).byteLength, 4096);
  assert.equal((await fetch(`${base}/login`)).status, 404, "web access is off");
  assert.equal((await fetch(`${base}/style.css`)).status, 200);
  enabled = true;
  assert.equal((await fetch(`${base}/login`)).status, 200);
  fs.rmSync(apk);
  assert.match(await (await fetch(`${base}/receiver`)).text(), /has not been built/);
});

test("a PIN is 6 to 12 digits and is stored hashed", () => {
  const { hashPin } = require("../web-session.cjs");
  assert.throws(() => hashPin("12345"), /6 to 12 digits/);
  assert.throws(() => hashPin("12345a"), /6 to 12 digits/);
  const record = hashPin("123456");
  assert.ok(!JSON.stringify(record).includes("123456"));
  assert.equal(verifyPassword("123456", record), true);
  assert.equal(verifyPassword("123457", record), false);
});
