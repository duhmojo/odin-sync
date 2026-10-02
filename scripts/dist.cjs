// npm run dist: everything for an installer on this OS.
// 1. The Android toolchain (asks before downloading, see setup-android.cjs).
// 2. The Android app (build-apk.cjs; signed with the key from the toolchain
//    folder or APK_KEYSTORE / APK_KEYSTORE_PASSWORD_FILE).
// 3. The desktop app with the APK inside, as an installer in dist/.
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REPO = path.join(__dirname, "..");
const node = (script, args = []) =>
  execFileSync(process.execPath, [path.join(__dirname, script), ...args], { stdio: "inherit", cwd: REPO });

node("setup-android.cjs", process.argv.includes("--yes") ? ["--yes"] : []);
node("build-apk.cjs");
node("make-icon.cjs");
execFileSync(
  process.execPath,
  [require.resolve("electron-builder/cli.js"), "--config", "electron-builder.config.cjs", "--publish", "never"],
  { stdio: "inherit", cwd: REPO },
);
