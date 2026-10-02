package app.odinsync.receiver;

/** What the receiver is doing, shown in the app and in its notification. */
final class Status {
    static volatile String state = "Starting";
    static volatile String currentFile = "";
    static volatile long fileBytes = 0;
    static volatile long fileSize = 0;
    static volatile long sessionDone = 0;
    static volatile long sessionTotal = 0;
    static volatile int sessionFiles = 0;
    static volatile int sessionFilesDone = 0;
    static volatile String desktop = "";
    static volatile String lastError = "";
    static volatile long lastActivity = 0;
    /** This app's memory (PSS, MB) and the last low-memory warning from Android. */
    static volatile long memoryMb = 0;
    static volatile String lastTrim = "";
    /** Transfers wait until then when Android is short of memory. */
    static volatile long pauseUntil = 0;

    private Status() {}

    static boolean syncing() {
        return sessionTotal > 0 || fileSize > 0;
    }

    /** Overall progress of the current sync in percent, or -1 when idle. */
    static int percent() {
        if (sessionTotal > 0) return (int) Math.min(100, (sessionDone + fileBytes) * 100 / sessionTotal);
        if (fileSize > 0) return (int) Math.min(100, fileBytes * 100 / fileSize);
        return -1;
    }

    static String summary() {
        if (syncing()) {
            int p = percent();
            String files = sessionFiles > 0 ? " · file " + Math.min(sessionFilesDone + 1, sessionFiles) + " of " + sessionFiles : "";
            return "Syncing " + (p >= 0 ? p + "%" : "") + files;
        }
        return state;
    }

    static void beginSession(String from, int files, long bytes) {
        desktop = from;
        sessionFiles = files;
        sessionTotal = bytes;
        sessionDone = 0;
        sessionFilesDone = 0;
        lastActivity = System.currentTimeMillis();
    }

    static void endSession() {
        sessionFiles = 0;
        sessionTotal = 0;
        sessionDone = 0;
        sessionFilesDone = 0;
        currentFile = "";
        fileBytes = 0;
        fileSize = 0;
        state = "Standby";
    }
}
