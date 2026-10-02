// Renames the product everywhere it is shown: npm run rename -- "New Name"
// Rewrites the display name and its wordmark (for example "ODIN SYNC") in the
// app, the Android app, the web pages, tests and docs, and updates
// product.json. Protocol names (odin-sync-hello, X-Odin-*, temporary file
// names, the cookie) are left alone so old and new versions keep working
// together. The Android package id is changed separately on purpose: Android
// treats a new id as a different app (no update over the installed one).
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.join(__dirname, "..");
const PRODUCT = path.join(REPO, "product.json");
// Skipped at the top level only (android-receiver/.../receiver is source).
const SKIP = new Set(["node_modules", ".git", ".local-data", "dist", "tools", "receiver"]);
const SELF = __filename;
const TYPES = /\.(cjs|js|html|css|java|xml|md)$/;

const name = process.argv.slice(2).join(" ").trim();
if (!name || /[<>"'`\\]/.test(name)) {
  console.error('Usage: npm run rename -- "New Name"');
  process.exit(1);
}
const product = JSON.parse(fs.readFileSync(PRODUCT, "utf8"));
const words = name.split(/\s+/);
const wordmark = words.length > 1 ? [words.slice(0, -1).join(" ").toUpperCase(), words.at(-1).toUpperCase()] : [name.toUpperCase(), ""];
const [oldFirst, oldSecond] = product.wordmark;
const [first, second] = wordmark;
const pairs = [
  [`${oldFirst} <b>${oldSecond}</b>`, `${first} <b>${second}</b>`],
  [`${oldFirst} <font color='#A6F078'>${oldSecond}</font>`, `${first} <font color='#A6F078'>${second}</font>`],
  [`${oldFirst} ${oldSecond}`, `${first} ${second}`.trim()],
  [product.name, name],
];

function files(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (dir === REPO && SKIP.has(entry.name)) continue;
    if (entry.name === "node_modules" || entry.name === "build") continue;
    const full = path.join(dir, entry.name);
    if (full === SELF) continue;
    if (entry.isDirectory()) result.push(...files(full));
    else if (TYPES.test(entry.name)) result.push(full);
  }
  return result;
}

let changed = 0;
for (const file of files(REPO)) {
  const before = fs.readFileSync(file, "utf8");
  let after = before;
  for (const [from, to] of pairs) after = after.split(from).join(to);
  if (after !== before) {
    fs.writeFileSync(file, after);
    changed++;
    console.log("  " + path.relative(REPO, file));
  }
}
product.name = name;
product.wordmark = wordmark;
fs.writeFileSync(PRODUCT, JSON.stringify(product, null, 2) + "\n");
console.log(`Renamed to "${name}" in ${changed} files. Rebuild the APK (npm run build:apk) and check git diff.`);
