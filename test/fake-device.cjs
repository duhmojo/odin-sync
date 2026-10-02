// An in-memory device with the same methods as ReceiverClient (the Odin Sync
// app), for sync and inventory tests. Files are a Map of device path -> Buffer.
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const path = require("node:path");
const { LISTING_END } = require("../plan.cjs");

class FakeDevice {
  constructor(files = {}) {
    this.kind = "receiver";
    this.files = new Map(Object.entries(files));
    this.uploads = [];
    this.removedDirs = [];
    // Local sources whose copy arrives damaged.
    this.corrupt = new Set();
    // After this many uploads the connection drops.
    this.dropAfterUploads = Infinity;
    this.calls = [];
  }
  lost() {
    return this.uploads.length >= this.dropAfterUploads;
  }
  check() {
    if (this.lost()) throw new Error("read ECONNRESET: connection reset");
  }
  async listing(roots) {
    this.check();
    this.calls.push("listing");
    const lines = [];
    for (const [file, data] of this.files) {
      if (roots.some((r) => file.startsWith(r.replace(/\/$/, "") + "/"))) lines.push(`${data.length}|${file}`);
    }
    return [...lines, LISTING_END].join("\n") + "\n";
  }
  async space(roots) {
    this.check();
    return roots.map((root) => ({ root, total: 64e9, available: 32e9, mount: "/storage/emulated/0" }));
  }
  async mkdirs(dirs) {
    this.check();
    this.calls.push("mkdirs");
  }
  async upload(source, target, size, mtime, onBytes = () => {}) {
    this.check();
    let data = await fs.readFile(source);
    this.uploads.push(target);
    if (this.lost()) throw new Error("socket hang up");
    onBytes(data.length);
    if (this.corrupt.has(source)) data = Buffer.concat([data, Buffer.from("!")]);
    const sent = crypto.createHash("sha256").update(await fs.readFile(source)).digest("hex");
    const got = crypto.createHash("sha256").update(data).digest("hex");
    if (sent !== got) throw new Error("The copy on the device failed checksum verification and was removed.");
    this.files.set(target, data);
  }
  async remove(files) {
    this.check();
    const removed = [];
    files.forEach((f, i) => {
      const data = this.files.get(f.path);
      if (data && data.length === f.size) {
        this.files.delete(f.path);
        removed.push(i);
      }
    });
    return { removed };
  }
  // Records the folders asked for; the app removes only those that are empty.
  async rmdirs(dirs) {
    this.removedDirs.push(...dirs);
  }
  async removeTemps(paths) {
    for (const p of paths) this.files.delete(p);
  }
  async read(file) {
    return this.files.has(file) ? this.files.get(file).toString("utf8") : null;
  }
  async beginSession() {}
  async endSession() {}
}

module.exports = { FakeDevice, path };
