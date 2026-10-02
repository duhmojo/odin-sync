// Installers: npm run dist builds the one for this OS (Windows: NSIS setup,
// Linux: AppImage and .deb, macOS: .dmg). The product name and ids come from
// product.json. Unsigned for now: Windows SmartScreen and macOS Gatekeeper
// warn until the builds are signed (and, on macOS, notarized).
const product = require("./product.json");

module.exports = {
  appId: product.desktopAppId,
  productName: product.name,
  artifactName: `${product.id}-\${version}-\${os}-\${arch}.\${ext}`,
  directories: { output: "dist", buildResources: "build-resources" },
  files: [
    "**/*",
    "!{test,test-e2e,scripts,android-receiver,build-resources,dist,tools,.local-data,docs,.github}/**",
    "!*.md",
    "!*.cmd",
    "!electron-builder.config.cjs",
    "!preview.png",
    "!**/*.idsig",
    // The tray icon.
    "build-resources/icon.png",
  ],
  win: { target: [{ target: "nsis", arch: ["x64"] }] },
  // The licence is shown by the Windows installer and shipped next to the app.
  extraFiles: ["LICENSE"],
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true, shortcutName: product.name, license: "LICENSE" },
  linux: { target: ["AppImage", "deb"], category: "Utility", maintainer: product.name },
  mac: { target: ["dmg"], category: "public.app-category.utilities" },
};
