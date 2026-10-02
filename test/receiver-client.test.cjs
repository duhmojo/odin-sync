const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { discover, ReceiverClient, signature, broadcastAddresses } = require("../receiver-client.cjs");
const { createFakeReceiver } = require("../test-e2e/fake-receiver.cjs");

async function withReceiver(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "odin-receiver-"));
  const receiver = createFakeReceiver({ root });
  const ports = await receiver.start();
  try {
    await run({ root, receiver, ports });
  } finally {
    await receiver.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// A pairing as the app makes it (desktop-link.test covers the exchange itself).
async function paired(ports, receiver) {
  const desktopId = crypto.randomUUID();
  const key = crypto.randomBytes(32);
  receiver.paired.set(desktopId, key);
  return new ReceiverClient({ host: "127.0.0.1", port: ports.httpPort, desktopId, key });
}

test("signatures are stable for a key", () => {
  const key = Buffer.alloc(32, 7);
  assert.equal(signature("d", key, "GET", "/status", 1000), signature("d", key, "GET", "/status", 1000));
  assert.match(signature("d", key, "GET", "/status", 1000), /^d:1000:[0-9a-f]{64}$/);
});

test("broadcast addresses come from the PC's networks", () => {
  const list = broadcastAddresses({
    eth: [{ family: "IPv4", address: "192.168.2.10", netmask: "255.255.255.0", internal: false }],
    lo: [{ family: "IPv4", address: "127.0.0.1", netmask: "255.0.0.0", internal: true }],
  });
  assert.deepEqual(list.sort(), ["192.168.2.255", "255.255.255.255"]);
});

test("discovery finds a running receiver and says whether it is paired", async () => {
  await withReceiver(async ({ receiver, ports }) => {
    const found = await discover({ desktopId: "x", targets: ["127.0.0.1"], port: ports.discoveryPort, timeout: 500 });
    assert.equal(found.length, 1);
    assert.equal(found[0].id, receiver.id);
    assert.equal(found[0].port, ports.httpPort);
    assert.equal(found[0].paired, false);
  });
});

test("a paired PC's signed requests get through; others are refused", async () => {
  await withReceiver(async ({ receiver, ports }) => {
    const client = await paired(ports, receiver);
    assert.equal((await client.hello()).paired, true);
    assert.equal((await client.status()).state, "Standby");
    const stranger = new ReceiverClient({ host: "127.0.0.1", port: ports.httpPort, desktopId: "nobody", key: Buffer.alloc(32) });
    await assert.rejects(stranger.status(), /Not paired/);
  });
});

test("upload, list, read and remove files on the receiver", async () => {
  await withReceiver(async ({ root, receiver, ports }) => {
    const client = await paired(ports, receiver);
    const source = path.join(root, "..", `odin-src-${process.pid}.bin`);
    const data = crypto.randomBytes(300000);
    fs.writeFileSync(source, data);
    try {
      let progress = 0;
      await client.upload(source, "/sdcard/OdinSyncTest/a/b.bin", data.length, 0, (n) => (progress = n));
      assert.equal(progress, data.length);
      // A copy that differs from what was sent is removed, not committed.
      receiver.state.corrupt = true;
      await assert.rejects(client.upload(source, "/sdcard/OdinSyncTest/bad.bin", data.length, 0), /checksum/);
      receiver.state.corrupt = false;
      const listing = await client.listing(["/sdcard/OdinSyncTest"]);
      assert.match(listing, /^300000\|\/sdcard\/OdinSyncTest\/a\/b\.bin$/m);
      assert.doesNotMatch(listing, /bad\.bin/, "no file or temporary copy left behind");
      assert.match(listing, /__ODIN_SYNC_LISTING_END__/);
      assert.equal(await client.read("/sdcard/OdinSyncTest/missing.txt"), null);
      const removed = await client.remove([{ path: "/sdcard/OdinSyncTest/a/b.bin", size: 1 }, { path: "/sdcard/OdinSyncTest/a/b.bin", size: data.length }]);
      assert.deepEqual(removed.removed, [1]);
      await assert.rejects(client.mkdirs(["/data/local/tmp/x"]), /shared storage/);
    } finally {
      fs.rmSync(source, { force: true });
    }
  });
});

test("low impact transfers are paced to the capped speed", async () => {
  await withReceiver(async ({ root, receiver, ports }) => {
    const client = await paired(ports, receiver);
    const source = path.join(root, "..", `odin-paced-${process.pid}.bin`);
    fs.writeFileSync(source, crypto.randomBytes(3 * 1024 * 1024));
    try {
      client.maxBytesPerSecond = 6 * 1024 * 1024;
      const started = Date.now();
      await client.upload(source, "/sdcard/OdinSyncTest/paced.bin", 3 * 1024 * 1024, 0);
      assert.ok(Date.now() - started >= 400, "3 MB at 6 MB/s takes about half a second");
    } finally {
      fs.rmSync(source, { force: true });
    }
  });
});
