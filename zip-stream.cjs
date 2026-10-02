// A zip written as it goes, for downloading a device folder from the web UI:
// files are stored (no compression, so it is as fast as the network) and
// streamed, never held in memory. ZIP64 throughout, so files and archives over
// 4 GB work. Sizes and CRCs follow each file in a data descriptor.
const zlib = require("node:zlib");
const { once } = require("node:events");

function dosTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function u64(buffer, value, offset) {
  buffer.writeBigUInt64LE(BigInt(value), offset);
}

class ZipStream {
  // out: a writable stream (an HTTP response). It is ended by finish().
  constructor(out) {
    this.out = out;
    this.offset = 0;
    this.entries = [];
  }

  async write(data) {
    this.offset += data.length;
    if (!this.out.write(data)) await once(this.out, "drain");
  }

  // Adds a file from a readable stream; name uses "/" between folders.
  async add(name, source, modified = new Date()) {
    const nameBytes = Buffer.from(name, "utf8");
    const { time, date } = dosTime(modified);
    const start = this.offset;
    const header = Buffer.alloc(30 + nameBytes.length + 20);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(45, 4); // version needed: ZIP64
    header.writeUInt16LE(0x0808, 6); // data descriptor follows; UTF-8 names
    header.writeUInt16LE(0, 8); // stored
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(0, 14);
    header.writeUInt32LE(0xffffffff, 18);
    header.writeUInt32LE(0xffffffff, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(20, 28);
    nameBytes.copy(header, 30);
    header.writeUInt16LE(0x0001, 30 + nameBytes.length); // ZIP64 extra (sizes in the descriptor)
    header.writeUInt16LE(16, 32 + nameBytes.length);
    await this.write(header);
    let crc = 0;
    let size = 0;
    for await (const chunk of source) {
      crc = zlib.crc32(chunk, crc);
      size += chunk.length;
      await this.write(chunk);
    }
    const descriptor = Buffer.alloc(24);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc >>> 0, 4);
    u64(descriptor, size, 8);
    u64(descriptor, size, 16);
    await this.write(descriptor);
    this.entries.push({ nameBytes, time, date, crc: crc >>> 0, size, start });
  }

  async finish() {
    const centralStart = this.offset;
    for (const e of this.entries) {
      const entry = Buffer.alloc(46 + e.nameBytes.length + 28);
      entry.writeUInt32LE(0x02014b50, 0);
      entry.writeUInt16LE(45, 4);
      entry.writeUInt16LE(45, 6);
      entry.writeUInt16LE(0x0808, 8);
      entry.writeUInt16LE(0, 10);
      entry.writeUInt16LE(e.time, 12);
      entry.writeUInt16LE(e.date, 14);
      entry.writeUInt32LE(e.crc, 16);
      entry.writeUInt32LE(0xffffffff, 20);
      entry.writeUInt32LE(0xffffffff, 24);
      entry.writeUInt16LE(e.nameBytes.length, 28);
      entry.writeUInt16LE(28, 30);
      entry.writeUInt32LE(0xffffffff, 42);
      e.nameBytes.copy(entry, 46);
      const extra = 46 + e.nameBytes.length;
      entry.writeUInt16LE(0x0001, extra);
      entry.writeUInt16LE(24, extra + 2);
      u64(entry, e.size, extra + 4);
      u64(entry, e.size, extra + 12);
      u64(entry, e.start, extra + 20);
      await this.write(entry);
    }
    const centralSize = this.offset - centralStart;
    const zip64End = this.offset;
    const end = Buffer.alloc(56 + 20 + 22);
    end.writeUInt32LE(0x06064b50, 0);
    u64(end, 44, 4);
    end.writeUInt16LE(45, 12);
    end.writeUInt16LE(45, 14);
    u64(end, this.entries.length, 24);
    u64(end, this.entries.length, 32);
    u64(end, centralSize, 40);
    u64(end, centralStart, 48);
    end.writeUInt32LE(0x07064b50, 56);
    u64(end, zip64End, 64);
    end.writeUInt32LE(1, 72);
    end.writeUInt32LE(0x06054b50, 76);
    end.writeUInt16LE(0xffff, 84);
    end.writeUInt16LE(0xffff, 86);
    end.writeUInt32LE(0xffffffff, 88);
    end.writeUInt32LE(0xffffffff, 92);
    await this.write(end);
    this.out.end();
  }
}

module.exports = { ZipStream };
