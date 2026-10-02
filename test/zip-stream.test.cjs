const { test } = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { PassThrough, Readable } = require("node:stream");
const { ZipStream } = require("../zip-stream.cjs");

test("a folder streams as a ZIP64 archive of stored files with correct CRCs", async () => {
  const out = new PassThrough();
  const chunks = [];
  out.on("data", (c) => chunks.push(c));
  const zip = new ZipStream(out);
  const files = { "Album/01.mp3": Buffer.from("song one"), "Album/sub/ä.bin": Buffer.alloc(70000, 3) };
  for (const [name, data] of Object.entries(files)) await zip.add(name, Readable.from([data.subarray(0, 10), data.subarray(10)]));
  await zip.finish();
  const archive = Buffer.concat(chunks);
  // End of central directory, then the ZIP64 record it points to.
  assert.equal(archive.readUInt32LE(archive.length - 22), 0x06054b50);
  const zip64 = Number(archive.readBigUInt64LE(archive.length - 22 - 20 + 8));
  assert.equal(archive.readUInt32LE(zip64), 0x06064b50);
  assert.equal(Number(archive.readBigUInt64LE(zip64 + 32)), 2, "two entries");
  let central = Number(archive.readBigUInt64LE(zip64 + 48));
  for (const [name, data] of Object.entries(files)) {
    assert.equal(archive.readUInt32LE(central), 0x02014b50);
    const nameLength = archive.readUInt16LE(central + 28);
    assert.equal(archive.subarray(central + 46, central + 46 + nameLength).toString("utf8"), name);
    assert.equal(archive.readUInt32LE(central + 16), zlib.crc32(data) >>> 0);
    const extra = central + 46 + nameLength;
    assert.equal(Number(archive.readBigUInt64LE(extra + 4)), data.length);
    const local = Number(archive.readBigUInt64LE(extra + 20));
    assert.equal(archive.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    assert.ok(archive.subarray(start, start + data.length).equals(data), "stored as is");
    central = extra + archive.readUInt16LE(central + 30);
  }
});
