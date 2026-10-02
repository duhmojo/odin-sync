# Odin Sync

**Your whole game and media library, on your Android handheld, over Wi-Fi. Pick it on the PC, hit
Sync, done.**

Odin Sync turns your PC into the home base for your handhelds. Point it at your ROMs, PC games,
music and videos, choose what belongs on each device, and it sends exactly that, fast, verified
and organised the way your emulators and frontends expect. No cables, no ADB, no developer
options, no dragging folders around one at a time.

Built for the AYN Odin, it works with any Android handheld or phone: Retroid, AYANEO, Anbernic,
your tablet.

<!-- Screenshot: the Library with covers and sync badges -->
<!-- Screenshot: the Sync review and progress -->
<!-- Screenshot: the Odin Sync app on the handheld -->

## Why it's great

- **Fast, verified transfers.** Files stream straight over your Wi-Fi to the companion app, at the
  speed of your network. Every file is checked with SHA-256 on both ends before it replaces
  anything, so a dropped connection never leaves a broken game behind. The transfer keeps going
  with the screen off.
- **A profile per device.** Each handheld has its own profile: where every folder goes
  (`ROMs → /sdcard/ROMs`, games on the SD card, music anywhere) and exactly which games, systems,
  albums and files belong on it. Check a folder once and anything you add to it later comes along.
- **It knows what it put there.** Odin Sync keeps an inventory of every file it copied, so
  removing something from a profile removes it from the device, and only what Odin Sync copied.
  Your saves and files you put there yourself are never touched.
- **Compare with device.** One click reads the handheld and shows what was deleted there since the
  last sync and what is not there yet, right in your Library, so you decide what to put back.
- **Smart about games.** CUE and M3U playlists travel with their discs, PC games sync as complete
  folders, and frontend clutter (`media`, `bios`, `.DS_Store`, `Thumbs.db`) stays home.
- **Artwork and metadata.** Covers, screenshots and details from libretro, ScreenScraper and Steam,
  shown in your Library and uploaded straight into **ES-DE** with merged `gamelist.xml` entries.
- **GameNative configs.** The best community config for each PC game on your device's GPU, saved
  to the handheld ready for Import Config.
- **Control it from the handheld.** Open Odin Sync from the app and the handheld's browser lands
  in your Library, signed in. Browse, pick and sync from the couch.
- **Manage device storage.** Browse the handheld's storage with real folder sizes and free space,
  create and delete folders, and upload files from the PC or from the browser.
- **Finds your devices by itself.** The PC and the app remember each other and reconnect on their
  own, even when your router hands out new addresses.
- **Stays out of the way.** It lives in the tray, starts with your PC if you like, and shows sync
  progress right on the tray icon.
- **Updates itself.** When the PC has a newer version of the Android app, the app offers it and
  installs it in one tap.

## How it works

```
 Your PC                                     Your handheld
┌──────────────────────────┐   Wi-Fi    ┌──────────────────────────┐
│ Odin Sync                │ ─────────▶ │ Odin Sync app            │
│  library, profiles,      │  verified  │  receives files, keeps   │
│  inventory, web UI       │ ◀───────── │  Wi-Fi awake while open  │
└──────────────────────────┘  status    └──────────────────────────┘
```

The desktop app holds your library and the profile of every device. The small Odin Sync app on
the handheld receives the files and reports back. They pair once with your PIN, and from then on
every request between them is signed with a key only the two of them know. Everything stays on
your local network.

## Get started

1. **Install Odin Sync on your PC** and set your PIN when it asks (6 to 12 digits).
2. **Add your folders** in Local folders: ROMs, PC games, music, videos, anything.
3. **Install the app on your handheld.** In Devices → Add a device, open the link it shows in the
   handheld's browser and install the app. Allow it to access files.
4. **Pair.** In the app, tap Find Odin Sync on the PC and enter your PIN. Your handheld appears in
   Devices.
5. **Choose and sync.** Set where each folder goes in Device profiles, tick what you want in
   Library, and press Sync device.

Keep the app open while syncing; it carries on with the screen off. Close it and the handheld is
off the network until you open it again.

## Platforms

| Desktop | Package                                |
| ------- | -------------------------------------- |
| Windows | Installer (`.exe`)                     |
| Linux   | AppImage and `.deb` (build on Linux)   |
| macOS   | `.dmg` (build on a Mac)                |

The Android app needs Android 11 or later.

Settings live in your user profile (`%APPDATA%\Odin Sync` on Windows, `~/.config/Odin Sync` on
Linux, `~/Library/Application Support/Odin Sync` on macOS).

## Building from source

You need Node.js 20 or later.

```bash
npm ci
npm start
```

`npm start` uses the same settings as the installed app (`%APPDATA%\Odin Sync`), and only one of
them runs at a time. To try things on separate settings, set `ODIN_SYNC_DATA_DIR` to another
folder first.

`npm run dist` builds an installer for the current OS into `dist/`:

1. It sets up the Android toolchain if missing (`npm run setup:android`): a JDK 21 and the Android
   SDK (about 0.5 GB) in `../odin-sync-toolchain`, after asking; you accept the Android SDK licence
   yourself.
2. It builds the Android app (`npm run build:apk`, skipped when nothing changed), signed with the
   key in the toolchain folder or `APK_KEYSTORE` / `APK_KEYSTORE_PASSWORD_FILE`. Keep that key
   safe: updates only install over the app when they are signed with the same key.
3. It packages the desktop app with the Android app inside.

Unsigned builds make Windows SmartScreen and macOS Gatekeeper warn until they are code-signed (and
notarized on macOS). Linux builds run on Linux (or WSL); macOS builds need a Mac.

Tests: `npm test` (unit tests) and `npm run test:e2e` (the real app against a simulated device).

## License

Free to download and use, including commercially. The source is published for viewing only:
copying, modifying and redistributing it need written permission. See [LICENSE](LICENSE).
