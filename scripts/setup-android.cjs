// Sets up what building the Android app needs, in the toolchain folder
// (../odin-sync-toolchain, or ODIN_ANDROID_TOOLCHAIN): a JDK 21 (Eclipse
// Temurin, adoptium.net) and the Android command-line tools (dl.google.com),
// then platforms;android-35 and build-tools;35.0.0 with sdkmanager. About
// 0.5 GB. Asks before downloading; the Android SDK licence is shown by
// sdkmanager and accepted by you in this terminal.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline/promises");
const { execFileSync } = require("node:child_process");

const REPO = path.join(__dirname, "..");
const TOOLCHAIN = process.env.ODIN_ANDROID_TOOLCHAIN || path.join(REPO, "..", "odin-sync-toolchain");
const SDK = path.join(TOOLCHAIN, "android-sdk");
const CMDLINE_TOOLS = "13114758";
const platform = { win32: "windows", linux: "linux", darwin: "mac" }[process.platform];
const arch = process.arch === "arm64" ? "aarch64" : "x64";

function ready() {
  const jdk = fs.existsSync(TOOLCHAIN) && fs.readdirSync(TOOLCHAIN).some((n) => /^jdk/i.test(n));
  return (
    jdk &&
    fs.existsSync(path.join(SDK, "platforms", "android-35", "android.jar")) &&
    fs.existsSync(path.join(SDK, "build-tools", "35.0.0"))
  );
}

async function download(url, file) {
  console.log(`Downloading ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
}

// tar unpacks both .zip (bsdtar, also on Windows 10+) and .tar.gz.
function unpack(file, into) {
  fs.mkdirSync(into, { recursive: true });
  execFileSync("tar", ["-xf", file, "-C", into], { stdio: "inherit" });
}

async function main() {
  if (ready()) {
    console.log(`The Android toolchain is ready in ${TOOLCHAIN}.`);
    return;
  }
  if (!platform) throw new Error(`Unsupported platform: ${process.platform}`);
  if (!process.argv.includes("--yes")) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `Building the Android app needs a JDK 21 (adoptium.net) and the Android SDK (dl.google.com),\n` +
        `about 0.5 GB, in ${TOOLCHAIN}. Download them now? [y/N] `,
    );
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) throw new Error("Cancelled. Nothing was downloaded.");
  }
  fs.mkdirSync(TOOLCHAIN, { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "android-toolchain-"));
  try {
    if (!fs.readdirSync(TOOLCHAIN).some((n) => /^jdk/i.test(n))) {
      const file = path.join(temp, platform === "windows" ? "jdk.zip" : "jdk.tar.gz");
      await download(`https://api.adoptium.net/v3/binary/latest/21/ga/${platform}/${arch}/jdk/hotspot/normal/eclipse`, file);
      unpack(file, TOOLCHAIN);
    }
    const tools = path.join(SDK, "cmdline-tools", "latest");
    if (!fs.existsSync(tools)) {
      const file = path.join(temp, "cmdline-tools.zip");
      await download(`https://dl.google.com/android/repository/commandlinetools-${platform === "windows" ? "win" : platform}-${CMDLINE_TOOLS}_latest.zip`, file);
      unpack(file, path.join(SDK, "cmdline-tools"));
      fs.renameSync(path.join(SDK, "cmdline-tools", "cmdline-tools"), tools);
    }
    const jdkDir = path.join(TOOLCHAIN, fs.readdirSync(TOOLCHAIN).find((n) => /^jdk/i.test(n)));
    const javaHome = fs.existsSync(path.join(jdkDir, "Contents", "Home")) ? path.join(jdkDir, "Contents", "Home") : jdkDir;
    const sdkmanager = path.join(tools, "bin", platform === "windows" ? "sdkmanager.bat" : "sdkmanager");
    const run = (args) =>
      execFileSync(platform === "windows" ? `"${sdkmanager}"` : sdkmanager, args, {
        stdio: "inherit",
        shell: platform === "windows",
        env: { ...process.env, JAVA_HOME: javaHome },
      });
    console.log("\nThe Android SDK licence follows; read it and answer y to accept it.");
    run([`--sdk_root=${SDK}`, "--licenses"]);
    run([`--sdk_root=${SDK}`, "platforms;android-35", "build-tools;35.0.0"]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  if (!ready()) throw new Error("The Android toolchain is still incomplete; see the messages above.");
  console.log(`The Android toolchain is ready in ${TOOLCHAIN}.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
