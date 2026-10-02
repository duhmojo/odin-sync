# Changelog

## v0.7.1

- **App updates from the PC:** the app reports its version; when the PC carries a newer one, the
  app shows Update available and installs it after Android asks you to confirm (same signing key,
  so the pairing is kept). Devices shows each device's app version. Each `npm run build:apk` gets a
  higher version code.
- **Compare with device** in Library: what was deleted on the device since the last sync, and what
  is not synced yet; the sync review offers to deselect what would be restored.
- **Web:** Local folders are read-only in a browser.
- **App:** one branded screen; the notification uses the app icon and animates only while syncing.

## v0.7.0

- **Odin Sync app:** a small Android app bundled with the PC app replaces Wi-Fi ADB. Install it
  from the link in Devices → Add a device. Transfers are fast and keep going with the screen off
  while the app is open.
- **One PIN:** set at first start; the app pairs with it (it finds the PC by itself) and browsers
  sign in with it. The web server always runs (Settings: port, PIN, Restart server).
- **Finding each other:** the app and the PC remember each other's last address and update it
  when it changes (DHCP); the PC also tries the device's MAC.
- **Open Odin Sync from the app:** opens the PC's web UI on the device, signed in and on that
  device's Library, without typing an address or PIN.
- **Removed:** Wi-Fi ADB (pairing codes, ADB discovery and reconnect, stay-awake, the ADB setting).
  Devices that were also paired with the app are kept; others need to be paired with the app.

## v0.6.0

- **Artwork and metadata:** Scrape missing per folder; covers in Library and a details dialog.
  ROMs from libretro (no account) and optionally ScreenScraper; PC games from Steam, with a search
  to fix wrong matches.
- **GameNative configs:** the best config for a game on the device's GPU, saved to the device for
  Import Config.
- **ES-DE upload (optional per device):** covers, screenshots and merged gamelist.xml entries.
- **Devices:** a paired device is recognised by its Wi-Fi IP whatever ADB calls it, a half-added
  device is completed at the next start, and an offline device is found again by its Wi-Fi MAC.

## v0.5.0

- **Web access:** the same UI in a browser on the local network (for example on the Odin itself),
  behind a password. One controller at a time: the PC app is paused while a browser is in control
  and can take control back. Destructive or long operations are locked so the two sides cannot run
  them at once.
- **Narrow screens:** compact layout for phone- and handheld-sized browsers.
- **Adding a device** that ADB auto-connected by its mDNS name works again, and Add device offers
  devices ADB is already connected to.

## v0.4.1

- **Device disconnects mid-sync:** the sync stops cleanly (nothing is marked as failed), tries to
  reconnect, and offers **Resume sync**, which re-checks and continues with what is left. A copy in
  flight is cleaned up on the next check.
- **Free space:** the check shows free space per device volume and blocks a sync that does not fit
  (100 MB margin).
- **Leftover temporary files** from interrupted copies (this app's `.odin-sync-<id>.part` files
  only) are found during the check and can be removed after confirming.
- **End-to-end test** (`npm run test:e2e`) drives the real app against a fake ADB device.
- Clearer review and results wording (removals not ticked; files already on the device listed
  separately).

## v0.4.0

- **Device profile = inventory.** The app records every file it copies to a device. A sync can now
  remove what you unselected (opt-in, confirmed in a dialog), but never files it did not copy, files
  that changed on the device, or games whose folder holds other files. Files the app copied that
  changed on the PC are updated. Earlier sync logs seed the inventory.
- **Library** shows each item's device status and has **Sync device**, **Reload** (re-read the PC
  folder) and **Open in Explorer**.
- **Sync review** shows one row per game and groups other files by destination folder (per-folder
  option). Results have a **Clear** button.
- **Local folders:** new ROM folders pre-fill frontend/BIOS folder excludes; macOS and Windows
  metadata files are always ignored (macOS ones also inside games).
- **Devices:** confirmations are modal dialogs; the storage browser lists folders by default with a
  per-folder **Show files** toggle; device operations queue instead of failing while a status check
  runs; the start-up notice is a status message instead of a banner.

## v0.3.0

A redesign around one library, one profile per device and a clearer sync.

- **Fresh settings format (version 3).** Older or unreadable settings are backed up to
  `config-backup-<time>.json` and a notice explains the fresh start. Devices need to be added again
  (usually without a new pairing code). **Settings → Reset all settings** backs up and clears
  everything.
- **Local folders** now have a type that decides how Library shows them: Games (each subfolder is one
  complete game, never filtered), ROMs (CUE/M3U sets grouped), Music, Videos, General files. Each
  folder has Include subfolders, extensions and exclude regexes for folders and files. Type-wide
  exclude filters apply to every folder of a type except Games. The System/category label and the
  per-folder include/exclude tree were removed.
- **One device profile per device** with a destination per local folder. Library can move a
  subfolder or game to its own location. Folders without a destination are flagged on the device,
  the profile and in Library, and cannot be selected until set. Flatten was removed.
- **Library** has a device picker and lists folders by type. Checking a folder includes files added
  later; items inside can be unchecked. A missing or renamed selected file is skipped with a warning
  instead of blocking the sync.
- **Sync** lists each destination on the device once and compares by size (New / Different /
  Already on device) instead of hashing every file each time. The review shows exactly which files
  will be copied. Progress shows bytes, the current file, speed and time left. Uploads are still
  verified with SHA-256 on the device before being renamed into place. Results are saved to
  `sync-log-<time>.json`. The rest of the UI stays usable during a sync.
- **Faster device access**: already-connected ADB transports are checked before mDNS discovery, and
  a verified connection is reused for a minute.
- The main process owns the settings and the renderer changes them through named operations only.
- Code formatted with Prettier; the old scanner, folder-destination devices and their tests were
  removed.
