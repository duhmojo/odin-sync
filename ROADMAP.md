# Roadmap

Ideas for what comes next, roughly in order of impact.

## Private cloud saves

Sync game saves between devices through your own PC, no third-party cloud.

- A **Game saves** local folder type.
- Finding saves: where each emulator and PC game keeps them (RetroArch, Dolphin, PCSX2,
  AetherSX2/NetherSX2, Yuzu/Eden, DuckStation, GameNative and Steam games, ...), on the PC and on
  the handheld.
- Choosing which games' saves to sync, and rules for conflicts: newest wins, keep both, or ask.
- Two-way: copy back from the handheld after playing, then out to the other devices.

## More clients

- **SteamOS** (Steam Deck and other Linux handhelds): a small service that speaks the same
  protocol as the Android app.
- **Windows** handhelds (ROG Ally, Legion Go): the same, as a tray app.

## Continuous sync (one-way backup)

- Per local folder and device: keep it in sync automatically whenever files change on the PC
  (for example Documents, or a screenshots folder).
- Library shows such folders as "always pushed to the device" instead of item checkboxes.

## Better logging

- A log view in the app: syncs, connections, errors, with filters and export.
- The Android app's log, readable from the PC.

## Maybe

- Integration with download sites: pick something there and have it land in the right local
  folder, ready to sync.
