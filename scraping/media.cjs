// Scraped media on the PC: <mediaDir>/<localFolderId>/<item key>/ holds
// meta.json, cover.*, screenshot.* and thumb.jpg. The item key is a hash of the
// item id, so any file name is safe.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const EXTENSIONS = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };

function itemKey(itemId) {
  return crypto.createHash("sha1").update(itemId).digest("hex").slice(0, 20);
}

function itemDir(mediaDir, folderId, itemId) {
  if (!/^[\w-]+$/.test(folderId)) throw new Error("Invalid folder id.");
  return path.join(mediaDir, folderId, itemKey(itemId));
}

async function read(mediaDir, folderId, itemId) {
  try {
    return JSON.parse(
      await fs.readFile(path.join(itemDir(mediaDir, folderId, itemId), "meta.json"), "utf8"),
    );
  } catch {
    return null;
  }
}

// Every scraped item of a local folder: {itemId: meta}.
async function list(mediaDir, folderId) {
  const result = {};
  let keys = [];
  try {
    keys = await fs.readdir(path.join(mediaDir, folderId));
  } catch {
    return result;
  }
  for (const key of keys) {
    try {
      const meta = JSON.parse(
        await fs.readFile(path.join(mediaDir, folderId, key, "meta.json"), "utf8"),
      );
      result[meta.itemId] = meta;
    } catch {
      // Incomplete item folder: ignore.
    }
  }
  return result;
}

// images: {cover: {data, type}, screenshot: {data, type}} (either may be missing).
// makeThumb(buffer) returns a small JPEG buffer, or null.
async function write(mediaDir, folderId, itemId, meta, images = {}, makeThumb = null) {
  const dir = itemDir(mediaDir, folderId, itemId);
  await fs.mkdir(dir, { recursive: true });
  const files = {};
  for (const [kind, image] of Object.entries(images)) {
    if (!image?.data?.length) continue;
    const extension = EXTENSIONS[image.type.split(";")[0]] || ".png";
    const name = kind + extension;
    await fs.writeFile(path.join(dir, name), image.data);
    files[kind] = name;
  }
  if (files.cover && makeThumb) {
    const thumb = await makeThumb(images.cover.data);
    if (thumb) {
      await fs.writeFile(path.join(dir, "thumb.jpg"), thumb);
      files.thumb = "thumb.jpg";
    }
  }
  const saved = { ...meta, itemId, files, scrapedAt: new Date().toISOString() };
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(saved, null, 1));
  return saved;
}

async function dataUrl(mediaDir, folderId, itemId, file) {
  if (!file || !/^[\w.]+$/.test(file)) return "";
  try {
    const data = await fs.readFile(path.join(itemDir(mediaDir, folderId, itemId), file));
    const type = file.endsWith(".jpg")
      ? "image/jpeg"
      : file.endsWith(".webp")
        ? "image/webp"
        : "image/png";
    return `data:${type};base64,${data.toString("base64")}`;
  } catch {
    return "";
  }
}

function filePath(mediaDir, folderId, itemId, file) {
  return path.join(itemDir(mediaDir, folderId, itemId), file);
}

async function removeFolder(mediaDir, folderId) {
  if (!/^[\w-]+$/.test(folderId)) return;
  await fs.rm(path.join(mediaDir, folderId), { recursive: true, force: true });
}

module.exports = { read, list, write, dataUrl, filePath, itemKey, removeFolder };
