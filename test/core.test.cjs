const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { destination, hash } = require("../core.cjs");

test("destination validation", () => {
  assert.throws(() => destination("/sdcard/../data"), /Choose a folder/);
  assert.throws(() => destination("/data/private"), /Choose a folder/);
  assert.throws(() => destination("/sdcard/a\nb"), /Choose a folder/);
  assert.equal(destination("/storage/ABCD-1234/ROMs"), "/storage/ABCD-1234/ROMs");
  assert.equal(destination("/sdcard/ROMs//nds/"), "/sdcard/ROMs/nds");
});

test("hash is the SHA-256 of the file contents", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "odin-core-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "a.txt");
  await fs.writeFile(file, "abc");
  assert.equal(
    await hash(file),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
