package app.odinsync.receiver;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.util.List;
import java.util.Locale;

/**
 * The app's one screen: the Odin Sync brand, a status card for the PC this
 * device syncs with (status, sync progress), the main actions (Open Odin
 * Sync, Refresh, or Find Odin Sync before pairing), then storage access and
 * the less frequent actions. While this app is open the PC can find it and
 * sync; closing it stops the receiver.
 */
public final class MainActivity extends Activity {
    private static final int ACCENT = Color.rgb(166, 240, 120);
    private static final int ACCENT_INK = Color.rgb(23, 35, 17);
    private static final int BG = Color.rgb(16, 21, 30);
    private static final int CARD = Color.rgb(26, 34, 47);
    private static final int LINE = Color.rgb(41, 50, 65);
    private static final int TEXT = Color.rgb(233, 238, 247);
    private static final int MUTED = Color.rgb(137, 149, 168);
    private static final int WARN = Color.rgb(244, 205, 127);

    private final Handler handler = new Handler(Looper.getMainLooper());
    private TextView pcName;
    private TextView pcAddress;
    private TextView pill;
    private TextView activity;
    private TextView file;
    private ProgressBar progress;
    private Button primary;
    private Button refresh;
    private LinearLayout updateBox;
    private TextView updateText;
    private Button updateButton;
    private TextView accessNote;
    private Button access;
    private Button pairAnother;
    private TextView footer;
    private boolean searchingPcs = false;

    private final Runnable refreshScreen = new Runnable() {
        @Override
        public void run() {
            render();
            handler.postDelayed(this, 500);
        }
    };

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        if (Build.VERSION.SDK_INT >= 33) requestPermissions(new String[] {"android.permission.POST_NOTIFICATIONS"}, 1);
        startForegroundService(new Intent(this, ReceiverService.class));

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(24), dp(28), dp(24), dp(24));

        // Brand.
        LinearLayout brand = new LinearLayout(this);
        brand.setGravity(Gravity.CENTER_VERTICAL);
        TextView logo = text("O", 30, ACCENT_INK, true);
        logo.setGravity(Gravity.CENTER);
        logo.setBackground(rounded(ACCENT, 14, 0));
        brand.addView(logo, new LinearLayout.LayoutParams(dp(52), dp(52)));
        TextView name = text("", 24, TEXT, true);
        name.setText(android.text.Html.fromHtml("ODIN <font color='#A6F078'>SYNC</font>", android.text.Html.FROM_HTML_MODE_LEGACY));
        name.setLetterSpacing(0.08f);
        name.setPadding(dp(14), 0, 0, 0);
        brand.addView(name);
        root.addView(brand);

        // Status card: the PC, the connection and what is happening.
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(20), dp(18), dp(20), dp(20));
        card.setBackground(rounded(CARD, 18, LINE));
        TextView label = text("ODIN SYNC ON THE PC", 11, MUTED, true);
        label.setLetterSpacing(0.12f);
        LinearLayout titleRow = new LinearLayout(this);
        titleRow.setGravity(Gravity.CENTER_VERTICAL);
        pcName = text("", 22, TEXT, true);
        titleRow.addView(pcName, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        pill = text("", 12, ACCENT_INK, true);
        pill.setPadding(dp(10), dp(4), dp(10), dp(4));
        titleRow.addView(pill);
        pcAddress = text("", 14, MUTED, false);
        activity = text("", 16, TEXT, false);
        activity.setPadding(0, dp(14), 0, dp(4));
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        progress.setProgressTintList(android.content.res.ColorStateList.valueOf(ACCENT));
        file = text("", 13, MUTED, false);
        file.setSingleLine(true);
        file.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
        card.addView(label);
        card.addView(titleRow);
        card.addView(pcAddress);
        card.addView(activity);
        card.addView(progress, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(10)));
        card.addView(file);

        LinearLayout buttons = new LinearLayout(this);
        buttons.setPadding(0, dp(16), 0, 0);
        primary = button("", true);
        primary.setOnClickListener(v -> {
            if (paired()) openOdinSync();
            else findPcs();
        });
        refresh = button("Refresh", false);
        refresh.setOnClickListener(v -> {
            DesktopLink link = ReceiverService.link;
            if (link != null) link.findAsync();
        });
        LinearLayout.LayoutParams wide = new LinearLayout.LayoutParams(0, dp(52), 1);
        LinearLayout.LayoutParams narrow = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(52));
        narrow.setMargins(dp(10), 0, 0, 0);
        buttons.addView(primary, wide);
        buttons.addView(refresh, narrow);
        card.addView(buttons);
        // Storage access, only while it is missing.
        accessNote = text("Step 1: allow Odin Sync to access files. It is needed to save games, ROMs and media; nothing syncs without it.", 15, WARN, true);
        accessNote.setPadding(0, dp(18), 0, dp(6));
        access = button("Allow access to files", true);
        access.setOnClickListener(v -> openAccessSettings());
        root.addView(accessNote, margins(0, dp(20), 0, 0));
        root.addView(access, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(52)));
        root.addView(card, margins(0, dp(24), 0, 0));

        // A newer version of this app on the PC.
        updateBox = new LinearLayout(this);
        updateBox.setOrientation(LinearLayout.VERTICAL);
        updateBox.setPadding(dp(18), dp(14), dp(18), dp(16));
        updateBox.setBackground(rounded(Color.rgb(45, 39, 23), 14, Color.rgb(90, 74, 36)));
        updateText = text("", 15, WARN, true);
        updateButton = button("Update", true);
        updateButton.setOnClickListener(v -> startUpdate());
        LinearLayout.LayoutParams updateParams = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(48));
        updateParams.setMargins(0, dp(10), 0, 0);
        updateBox.addView(updateText);
        updateBox.addView(updateButton, updateParams);
        root.addView(updateBox, margins(0, dp(16), 0, 0));


        // Less frequent actions.
        LinearLayout more = new LinearLayout(this);
        more.setGravity(Gravity.CENTER);
        more.setPadding(0, dp(28), 0, 0);
        pairAnother = link("Pair with another PC");
        pairAnother.setOnClickListener(v -> findPcs());
        Button close = link("Close Odin Sync");
        close.setOnClickListener(v -> {
            stopService(new Intent(this, ReceiverService.class));
            finishAndRemoveTask();
        });
        more.addView(pairAnother);
        more.addView(close);
        root.addView(more);
        footer = text("", 12, MUTED, false);
        footer.setGravity(Gravity.CENTER);
        footer.setPadding(0, dp(8), 0, 0);
        root.addView(footer);

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(BG);
        scroll.addView(root);
        setContentView(scroll);
    }

    // ---- Small view helpers ----

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private GradientDrawable rounded(int color, int radius, int stroke) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(radius));
        if (stroke != 0) drawable.setStroke(dp(1), stroke);
        return drawable;
    }

    private LinearLayout.LayoutParams margins(int left, int top, int right, int bottom) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        params.setMargins(left, top, right, bottom);
        return params;
    }

    private TextView text(String value, int size, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        if (bold) view.setTypeface(Typeface.DEFAULT_BOLD);
        return view;
    }

    private Button button(String value, boolean filled) {
        Button view = new Button(this);
        view.setText(value);
        view.setAllCaps(false);
        view.setTextSize(16);
        view.setTypeface(Typeface.DEFAULT_BOLD);
        view.setTextColor(filled ? ACCENT_INK : TEXT);
        view.setBackground(rounded(filled ? ACCENT : CARD, 12, filled ? 0 : LINE));
        view.setPadding(dp(18), 0, dp(18), 0);
        return view;
    }

    private Button link(String value) {
        Button view = new Button(this);
        view.setText(value);
        view.setAllCaps(false);
        view.setTextColor(MUTED);
        view.setBackgroundColor(Color.TRANSPARENT);
        return view;
    }

    private void openAccessSettings() {
        startActivity(new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + getPackageName())));
    }

    // ---- Pairing ----

    /** Looks for Odin Sync PCs on the network and offers them for pairing. */
    private void findPcs() {
        if (searchingPcs) return;
        // File access comes first: without it the PC could not sync anything.
        if (!Environment.isExternalStorageManager()) {
            Toast.makeText(this, "First allow Odin Sync to access files.", Toast.LENGTH_LONG).show();
            openAccessSettings();
            return;
        }
        searchingPcs = true;
        new Thread(() -> {
            List<DesktopLink.Pc> pcs;
            String problem = null;
            try {
                pcs = DesktopLink.findPcs();
            } catch (Exception e) {
                pcs = new java.util.ArrayList<>();
                problem = e.getMessage();
            }
            List<DesktopLink.Pc> found = pcs;
            String error = problem;
            handler.post(() -> {
                searchingPcs = false;
                if (found.isEmpty()) {
                    Toast.makeText(this, error != null ? error
                            : "No Odin Sync found. Is it running on the PC, on this Wi-Fi?", Toast.LENGTH_LONG).show();
                    return;
                }
                String[] names = new String[found.size()];
                for (int i = 0; i < names.length; i++) names[i] = found.get(i).name + "  ·  " + found.get(i).host;
                new AlertDialog.Builder(this)
                        .setTitle("Pair with")
                        .setItems(names, (dialog, which) -> askPin(found.get(which)))
                        .setNegativeButton("Cancel", null)
                        .show();
            });
        }).start();
    }

    /** Asks for the PC's Odin Sync PIN and pairs. */
    private void askPin(DesktopLink.Pc pc) {
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD);
        input.setHint("PIN");
        new AlertDialog.Builder(this)
                .setTitle("Odin Sync PIN for " + pc.name)
                .setMessage("The PIN you set in Odin Sync on the PC.")
                .setView(input)
                .setPositiveButton("Pair", (dialog, which) -> pairWith(pc, input.getText().toString().trim()))
                .setNegativeButton("Cancel", null)
                .show();
    }

    private void pairWith(DesktopLink.Pc pc, String pin) {
        DesktopLink link = ReceiverService.link;
        if (link == null || pin.isEmpty()) return;
        new Thread(() -> {
            try {
                link.pair(pc, pin);
                handler.post(() -> Toast.makeText(this, "Paired with " + pc.name + ".", Toast.LENGTH_LONG).show());
            } catch (Exception e) {
                String message = e.getMessage() == null ? e.toString() : e.getMessage();
                handler.post(() -> Toast.makeText(this, "Could not pair: " + message, Toast.LENGTH_LONG).show());
            }
        }).start();
    }

    private boolean paired() {
        return !"Not paired".equals(DesktopLink.state);
    }

    /** Opens the PC's Odin Sync in the browser, signed in, on this device's library. */
    private void openOdinSync() {
        DesktopLink link = ReceiverService.link;
        if (link == null) return;
        primary.setEnabled(false);
        new Thread(() -> {
            try {
                String url = link.signInUrl();
                handler.post(() -> startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))));
            } catch (Exception e) {
                String message = e.getMessage() == null ? e.toString() : e.getMessage();
                handler.post(() -> Toast.makeText(this, "Could not open Odin Sync: " + message, Toast.LENGTH_LONG).show());
                link.findAsync();
            }
        }).start();
    }

    // ---- Updates ----

    /** Downloads the new version from the PC; Android asks to confirm the install. */
    private void startUpdate() {
        if (!getPackageManager().canRequestPackageInstalls()) {
            Toast.makeText(this, "Allow Odin Sync to install apps, then come back and tap Update.", Toast.LENGTH_LONG).show();
            startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName())));
            return;
        }
        String host = DesktopLink.host;
        int port = DesktopLink.webPort;
        new Thread(() -> {
            try {
                Updater.install(getApplicationContext(), host, port);
            } catch (Exception e) {
                String message = e.getMessage() == null ? e.toString() : e.getMessage();
                handler.post(() -> Toast.makeText(this, "Could not update: " + message, Toast.LENGTH_LONG).show());
            }
        }).start();
    }

    // ---- Rendering ----

    private String ipAddress() {
        WifiInfo wifi = getApplicationContext().getSystemService(WifiManager.class).getConnectionInfo();
        int ip = wifi == null ? 0 : wifi.getIpAddress();
        if (ip == 0) return "no Wi-Fi";
        return String.format(Locale.US, "%d.%d.%d.%d", ip & 0xff, (ip >> 8) & 0xff, (ip >> 16) & 0xff, (ip >> 24) & 0xff);
    }

    private void setPill(String value, int color) {
        pill.setText(value);
        pill.setBackground(rounded(color, 20, 0));
    }

    private void render() {
        String linkState = DesktopLink.state;
        boolean paired = paired();
        boolean connected = "Connected".equals(linkState);
        boolean syncing = Status.syncing();

        pcName.setText(paired ? DesktopLink.name : "Not paired yet");
        pcAddress.setText(paired
                ? (DesktopLink.host.isEmpty() ? "" : DesktopLink.host + (DesktopLink.webPort > 0 ? " · port " + DesktopLink.webPort : ""))
                : "Find Odin Sync on your PC and enter its PIN.");
        if (!paired) setPill("NEW", MUTED);
        else if (syncing) setPill("SYNCING", ACCENT);
        else if (connected) setPill("CONNECTED", ACCENT);
        else if ("Searching".equals(linkState)) setPill("LOOKING…", MUTED);
        else setPill("NOT FOUND", WARN);

        int percent = Status.percent();
        progress.setVisibility(syncing ? View.VISIBLE : View.GONE);
        progress.setProgress(Math.max(0, percent));
        file.setVisibility(syncing && !Status.currentFile.isEmpty() ? View.VISIBLE : View.GONE);
        file.setText(Status.currentFile);
        if (syncing) activity.setText(Status.summary());
        else if (!paired) activity.setText("Pair once, then this device syncs whenever the app is open.");
        else if (connected) activity.setText("Ready. Keep the app open to sync, even with the screen off.");
        else if ("Searching".equals(linkState)) activity.setText("Looking for the PC…");
        else activity.setText("Is Odin Sync running on the PC, on this Wi-Fi? Tap Refresh to try again.");

        primary.setText(paired ? "Open Odin Sync" : searchingPcs ? "Looking…" : "Find Odin Sync on the PC");
        primary.setEnabled(paired ? connected && DesktopLink.webPort > 0 : !searchingPcs);
        primary.setAlpha(primary.isEnabled() ? 1f : 0.5f);
        refresh.setVisibility(paired ? View.VISIBLE : View.GONE);
        refresh.setEnabled(!"Searching".equals(linkState));
        pairAnother.setVisibility(paired ? View.VISIBLE : View.GONE);

        boolean update = Updater.updateAvailable() && connected && DesktopLink.webPort > 0;
        updateBox.setVisibility(update ? View.VISIBLE : View.GONE);
        updateText.setText("Update available: " + Updater.installedName + " (" + Updater.installed + ") → "
                + Updater.availableName + " (" + Updater.available + ")");
        updateButton.setText(Updater.state.isEmpty() ? "Update" : Updater.state);
        updateButton.setEnabled(Updater.state.isEmpty() && !syncing);

        boolean granted = Environment.isExternalStorageManager();
        if (!granted && !paired) primary.setText("Allow access to files first");
        accessNote.setVisibility(granted ? View.GONE : View.VISIBLE);
        access.setVisibility(granted ? View.GONE : View.VISIBLE);
        String error = Status.lastError.isEmpty() ? "" : "\nLast error: " + Status.lastError;
        footer.setText("This device: " + ipAddress() + error);
    }

    @Override
    protected void onResume() {
        super.onResume();
        handler.post(refreshScreen);
        // Coming back to the app: tell the PC where this device is.
        DesktopLink link = ReceiverService.link;
        if (link != null) link.findAsync();
    }

    @Override
    protected void onPause() {
        super.onPause();
        handler.removeCallbacks(refreshScreen);
    }
}
