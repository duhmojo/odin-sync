// Builds the Odin Sync receiver APK without Gradle: aapt2 (manifest), javac,
// d8 (dex), zipalign and apksigner from a JDK and the Android SDK in the
// toolchain folder (default ../odin-sync-toolchain, or ODIN_ANDROID_TOOLCHAIN).
// The signing key is created there on first use and never stored in the repo.
// Output: receiver/odin-sync-receiver.apk (served to the device for install).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const REPO = path.join(__dirname, "..");
const TOOLCHAIN = process.env.ODIN_ANDROID_TOOLCHAIN || path.join(REPO, "..", "odin-sync-toolchain");
const SOURCE = path.join(REPO, "android-receiver");
const BUILD = path.join(SOURCE, "build");
const OUTPUT = path.join(REPO, "receiver", "odin-sync-receiver.apk");
const PLATFORM = "android-35";
const BUILD_TOOLS = "35.0.0";
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version;
// Every build gets a higher versionCode (Android only installs an update with
// a higher one). The last one is kept in receiver/odin-sync-receiver.json,
// which the PC app reads to tell devices that an update is available.
const MANIFEST = path.join(REPO, "receiver", "odin-sync-receiver.json");
const previous = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, "utf8")).versionCode : 700;
const VERSION_CODE = String(previous + 1);

function find(dir, pattern) {
  if (!fs.existsSync(dir)) return null;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (pattern.test(name)) return full;
  }
  return null;
}

const jdkFolder = find(TOOLCHAIN, /^jdk/i);
if (!jdkFolder) throw new Error(`No JDK found in ${TOOLCHAIN}. Run node scripts/setup-android.cjs first.`);
// macOS JDKs keep their files under Contents/Home.
const jdk = fs.existsSync(path.join(jdkFolder, "Contents", "Home")) ? path.join(jdkFolder, "Contents", "Home") : jdkFolder;
const sdk = path.join(TOOLCHAIN, "android-sdk");
const androidJar = path.join(sdk, "platforms", PLATFORM, "android.jar");
const tools = path.join(sdk, "build-tools", BUILD_TOOLS);
const exe = (dir, name) => path.join(dir, process.platform === "win32" ? name + ".exe" : name);
const bat = (dir, name) => path.join(dir, process.platform === "win32" ? name + ".bat" : name);

function run(file, args) {
  // .bat tools (d8, apksigner) need a shell on Windows.
  const shell = /\.bat$/i.test(file);
  execFileSync(shell ? `"${file}"` : file, shell ? args.map((a) => `"${a}"`) : args, {
    stdio: "inherit",
    shell,
    env: { ...process.env, JAVA_HOME: jdk, PATH: path.join(jdk, "bin") + path.delimiter + process.env.PATH },
  });
}

function javaSources(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...javaSources(full));
    else if (entry.name.endsWith(".java")) result.push(full);
  }
  return result;
}

// The signing key: APK_KEYSTORE and APK_KEYSTORE_PASSWORD_FILE, or the one in
// the toolchain folder (created on first use). Never in the repo. Keep it:
// updates only install over the app when signed with the same key.
function keystore() {
  const store = process.env.APK_KEYSTORE || path.join(TOOLCHAIN, "odin-sync-receiver.jks");
  const passwordFile = process.env.APK_KEYSTORE_PASSWORD_FILE || path.join(TOOLCHAIN, "odin-sync-receiver-password.txt");
  if (path.resolve(store).startsWith(path.resolve(REPO) + path.sep)) throw new Error("Keep the signing key outside the repository.");
  if (!fs.existsSync(store)) {
    fs.writeFileSync(passwordFile, crypto.randomBytes(18).toString("base64url"));
    const password = fs.readFileSync(passwordFile, "utf8").trim();
    run(exe(path.join(jdk, "bin"), "keytool"), [
      "-genkeypair", "-keystore", store, "-alias", "odin-sync", "-keyalg", "RSA", "-keysize", "3072",
      "-validity", "10000", "-storepass", password, "-keypass", password, "-dname", "CN=Odin Sync",
    ]);
  }
  return { store, passwordFile };
}

// Nothing changed since the last build: keep it (a new build number would
// offer every device an update). --force builds anyway.
function newestSource(dir) {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "build") continue;
    const full = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestSource(full) : fs.statSync(full).mtimeMs);
  }
  return newest;
}
if (!process.argv.includes("--force") && fs.existsSync(OUTPUT) && fs.existsSync(MANIFEST)) {
  const built = fs.statSync(OUTPUT).mtimeMs;
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  if (newestSource(SOURCE) < built && manifest.versionName === VERSION) {
    console.log(`The Android app is up to date (build ${manifest.versionCode}); use --force to rebuild.`);
    process.exit(0);
  }
}

fs.rmSync(BUILD, { recursive: true, force: true });
fs.mkdirSync(path.join(BUILD, "classes"), { recursive: true });
fs.mkdirSync(path.join(BUILD, "dex"), { recursive: true });
fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });

console.log("Compiling resources…");
run(exe(tools, "aapt2"), ["compile", "--dir", path.join(SOURCE, "res"), "-o", path.join(BUILD, "res.zip")]);
console.log("Linking manifest…");
run(exe(tools, "aapt2"), [
  "link", "-o", path.join(BUILD, "base.apk"), "-I", androidJar, "-R", path.join(BUILD, "res.zip"),
  "--manifest", path.join(SOURCE, "AndroidManifest.xml"),
  "--min-sdk-version", "30", "--target-sdk-version", "34",
  "--version-code", VERSION_CODE, "--version-name", VERSION,
]);
console.log("Compiling Java…");
run(exe(path.join(jdk, "bin"), "javac"), [
  "-encoding", "UTF-8", "-source", "11", "-target", "11", "-nowarn",
  "-classpath", androidJar, "-d", path.join(BUILD, "classes"), ...javaSources(path.join(SOURCE, "src")),
]);
console.log("Converting to dex…");
const classes = [];
(function collect(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full);
    else if (entry.name.endsWith(".class")) classes.push(full);
  }
})(path.join(BUILD, "classes"));
run(bat(tools, "d8"), ["--release", "--min-api", "30", "--lib", androidJar, "--output", path.join(BUILD, "dex"), ...classes]);
console.log("Packaging…");
fs.copyFileSync(path.join(BUILD, "base.apk"), path.join(BUILD, "unsigned.apk"));
run(exe(path.join(jdk, "bin"), "jar"), ["--update", "--no-manifest", "--file", path.join(BUILD, "unsigned.apk"), "-C", path.join(BUILD, "dex"), "classes.dex"]);
run(exe(tools, "zipalign"), ["-f", "-p", "4", path.join(BUILD, "unsigned.apk"), path.join(BUILD, "aligned.apk")]);
const { store, passwordFile } = keystore();
run(bat(tools, "apksigner"), ["sign", "--ks", store, "--ks-pass", `file:${passwordFile}`, "--out", OUTPUT, path.join(BUILD, "aligned.apk")]);
fs.writeFileSync(MANIFEST, JSON.stringify({ versionCode: Number(VERSION_CODE), versionName: VERSION }, null, 2) + "\n");
console.log(`Built ${OUTPUT} (${fs.statSync(OUTPUT).size} bytes), version ${VERSION} (${VERSION_CODE}).`);
