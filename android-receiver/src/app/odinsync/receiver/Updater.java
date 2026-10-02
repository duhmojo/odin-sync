package app.odinsync.receiver;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Updates this app from the PC it is paired with: downloads the APK the PC
 * carries and hands it to Android's package installer, which asks the person
 * to confirm. Android installs it only if it is signed with the same key, so
 * the pairing and settings are kept.
 */
final class Updater {
    /** This app's version, and the newest one the PC carries (0 when unknown). */
    static volatile long installed = 0;
    static volatile String installedName = "";
    static volatile long available = 0;
    static volatile String availableName = "";
    /** Shown while an update downloads or waits for the person. */
    static volatile String state = "";

    private Updater() {}

    static void readInstalled(Context context) {
        try {
            android.content.pm.PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            installed = info.getLongVersionCode();
            installedName = info.versionName == null ? "" : info.versionName;
        } catch (PackageManager.NameNotFoundException ignored) {
            // Cannot happen for our own package.
        }
    }

    static boolean updateAvailable() {
        return installed > 0 && available > installed;
    }

    /** Downloads the APK from the PC and starts the install (network: off the main thread). */
    static void install(Context context, String host, int webPort) throws Exception {
        state = "Downloading the update…";
        PackageInstaller installer = context.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(context.getPackageName());
        int sessionId = installer.createSession(params);
        try (PackageInstaller.Session session = installer.openSession(sessionId)) {
            HttpURLConnection connection = (HttpURLConnection) new URL("http://" + host + ":" + webPort + "/receiver/odin-sync-receiver.apk").openConnection();
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(30000);
            if (connection.getResponseCode() != 200) throw new IllegalStateException("The PC did not send the update.");
            long length = connection.getContentLengthLong();
            try (InputStream in = connection.getInputStream(); OutputStream out = session.openWrite("odin-sync.apk", 0, length)) {
                byte[] buffer = new byte[256 * 1024];
                for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
                session.fsync(out);
            }
            Intent result = new Intent(context, InstallResult.class);
            PendingIntent pending = PendingIntent.getBroadcast(context, sessionId, result,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
            state = "Confirm the update…";
            session.commit(pending.getIntentSender());
        } catch (Exception e) {
            installer.abandonSession(sessionId);
            state = "";
            throw e;
        }
    }
}
