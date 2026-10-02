const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

function destination(value) {
  if (
    typeof value !== "string" ||
    !/^\/(sdcard|storage\/emulated\/0|storage\/[A-Za-z0-9-]+)\//.test(value) ||
    /[\r\n\0]/.test(value) ||
    value.split("/").includes("..")
  )
    throw new Error(
      "Choose a folder inside /sdcard/ or /storage/<volume>/, such as /sdcard/ROMs/PS2.",
    );
  return path.posix.normalize(value).replace(/\/+$/, "");
}
async function hash(file) {
  const handle = await fs.open(file, "r");
  const digest = crypto.createHash("sha256");
  try {
    for await (const chunk of handle.createReadStream()) digest.update(chunk);
  } finally {
    await handle.close();
  }
  return digest.digest("hex");
}

module.exports = { destination, hash };
