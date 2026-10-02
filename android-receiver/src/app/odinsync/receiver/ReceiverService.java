package app.odinsync.receiver;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

/**
 * Runs while the app is open: answers discovery, serves the desktop's
 * requests, and keeps Wi-Fi and the CPU awake so the screen turning off does
 * not drop the connection. Closing the app stops it.
 */
public final class ReceiverService extends Service {
    private static final String CHANNEL = "receiver";
    private static final int NOTIFICATION = 1;
    private static final long SESSION_IDLE_MS = 2 * 60 * 1000;

    static volatile boolean running = false;
    static volatile String startError = "";
    /** Finding the PC; the screen uses it for Refresh and Open Odin Sync. */
    static volatile DesktopLink link;
    private long lastSearch = 0;
    private int memoryTicks = 0;

    private HttpServer http;
    private Discovery discovery;
    private WifiManager.WifiLock wifiLock;
    private WifiManager.WifiLock lowLatencyLock;
    private WifiManager.MulticastLock multicastLock;
    private PowerManager.WakeLock wakeLock;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private String lastText = "";

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            // A sync whose desktop went away is ended after two quiet minutes.
            if (Status.syncing() && System.currentTimeMillis() - Status.lastActivity > SESSION_IDLE_MS) {
                Status.endSession();
            }
            // Tells the PC where this device is now and then (it may have a new IP).
            if (link != null && !Status.syncing() && System.currentTimeMillis() - lastSearch > 60000) {
                lastSearch = System.currentTimeMillis();
                link.findAsync();
            }
            boolean busy = Status.syncing() || System.currentTimeMillis() - Status.lastActivity < 30000;
            if (busy && !wifiLock.isHeld()) {
                wifiLock.acquire();
                lowLatencyLock.acquire();
            } else if (!busy && wifiLock.isHeld()) {
                wifiLock.release();
                if (lowLatencyLock.isHeld()) lowLatencyLock.release();
            }
            if (++memoryTicks % 10 == 0) readMemory();
            String text = notificationText();
            if (!text.equals(lastText)) {
                lastText = text;
                getSystemService(NotificationManager.class).notify(NOTIFICATION, notification(text));
            }
            handler.postDelayed(this, 1000);
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationChannel channel = new NotificationChannel(CHANNEL, "Odin Sync receiver", NotificationManager.IMPORTANCE_LOW);
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
        Notification first = notification("Standby");
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION, first, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        else startForeground(NOTIFICATION, first);

        WifiManager wifi = getApplicationContext().getSystemService(WifiManager.class);
        // Wi-Fi without power saving, held only while files are moving (see tick):
        // low-latency for the app in front, high-perf for the screen off.
        wifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "odin-sync:wifi");
        lowLatencyLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "odin-sync:low-latency");
        multicastLock = wifi.createMulticastLock("odin-sync:discovery");
        multicastLock.acquire();
        // Keeps the CPU running while the app is open, so discovery and
        // transfers keep working with the screen off.
        wakeLock = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "odin-sync:receiver");
        wakeLock.acquire();

        Pairing pairing = new Pairing(this);
        String name = Build.MODEL == null ? "Android device" : Build.MODEL.replace('_', ' ');
        http = new HttpServer(pairing, new FileOps(this), name);
        discovery = new Discovery(http);
        try {
            http.start();
            discovery.start();
            Status.state = "Standby";
            startError = "";
            new Thread(Gpu::detect, "odin-gpu").start();
            Updater.readInstalled(this);
            link = new DesktopLink(pairing);
            link.findAsync();
            lastSearch = System.currentTimeMillis();
        } catch (Exception e) {
            startError = e.getMessage() == null ? e.toString() : e.getMessage();
            Status.state = "Could not start: " + startError;
        }
        running = true;
        handler.post(tick);
    }

    private void readMemory() {
        android.app.ActivityManager manager = getSystemService(android.app.ActivityManager.class);
        android.os.Debug.MemoryInfo[] info = manager.getProcessMemoryInfo(new int[] {android.os.Process.myPid()});
        if (info.length > 0) Status.memoryMb = info[0].getTotalPss() / 1024;
    }

    /** Android is short of memory: note it, free caches, and pause transfers briefly. */
    @Override
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        Status.lastTrim = level + " at " + new java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(new java.util.Date());
        android.util.Log.w("OdinSync", "onTrimMemory " + level + " while " + (Status.syncing() ? "syncing" : "idle"));
        if (level >= TRIM_MEMORY_RUNNING_CRITICAL) {
            if (http != null) http.files.trim();
            if (Status.syncing()) Status.pauseUntil = System.currentTimeMillis() + 3000;
        }
    }

    @Override
    public void onLowMemory() {
        super.onLowMemory();
        onTrimMemory(TRIM_MEMORY_COMPLETE);
    }

    private int appIcon() {
        int id = getResources().getIdentifier("notify", "drawable", getPackageName());
        return id != 0 ? id : android.R.drawable.stat_notify_sync_noanim;
    }

    private String notificationText() {
        if (Status.syncing()) return Status.summary();
        if (Updater.updateAvailable()) return "Update available · open Odin Sync to install it";
        if ("Connected".equals(DesktopLink.state)) return "Connected to " + DesktopLink.name;
        if ("Not paired".equals(DesktopLink.state)) return "Open to pair with Odin Sync on your PC";
        return "Ready · looking for the PC";
    }

    private Notification notification(String text) {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pending = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = new Notification.Builder(this, CHANNEL)
                .setContentTitle("Odin Sync")
                .setContentText(text)
                // The animated download icon only while a sync runs; the app's own icon otherwise.
                .setSmallIcon(Status.syncing() ? android.R.drawable.stat_sys_download : appIcon())
                .setOngoing(true)
                .setContentIntent(pending);
        int percent = Status.percent();
        if (Status.syncing() && percent >= 0) builder.setProgress(100, percent, false);
        return builder.build();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // Swiping the app away closes it: no discovery or syncing until reopened.
        stopSelf();
    }

    @Override
    public void onDestroy() {
        running = false;
        link = null;
        handler.removeCallbacks(tick);
        if (discovery != null) discovery.stop();
        if (http != null) http.stop();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        if (lowLatencyLock != null && lowLatencyLock.isHeld()) lowLatencyLock.release();
        if (multicastLock != null && multicastLock.isHeld()) multicastLock.release();
        Status.state = "Stopped";
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
