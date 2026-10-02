package app.odinsync.receiver;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * Finds the paired Odin Sync PC: a signed "odin-sync-app" announcement to the
 * PC's last address, then by broadcast. The PC records where this device is
 * and answers (also signed) with its name and web port, which are saved so
 * the next search starts there. Also gets the single-use sign-in link for
 * "Open Odin Sync".
 */
final class DesktopLink {
    static final int PORT = 47655;
    private static final int WAIT_MS = 2000;

    /** What the app shows: Searching, Connected, Not found, Not paired. */
    static volatile String state = "Not paired";
    static volatile String desktopId = null;
    static volatile String name = "";
    static volatile String host = "";
    static volatile int webPort = 0;
    static volatile long connectedAt = 0;

    private final Pairing pairing;
    private volatile boolean searching = false;

    DesktopLink(Pairing pairing) {
        this.pairing = pairing;
        showSaved();
    }

    /** Shows the last known PC before a search answers. */
    void showSaved() {
        List<String> ids = pairing.desktops();
        if (ids.isEmpty()) {
            state = "Not paired";
            return;
        }
        String id = ids.get(0);
        desktopId = id;
        name = pairing.desktopName(id);
        host = pairing.host(id) == null ? "" : pairing.host(id);
        webPort = pairing.webPort(id);
    }

    /** Searches in the background; the screen polls the static fields. */
    void findAsync() {
        if (searching) return;
        searching = true;
        new Thread(() -> {
            try {
                find();
            } finally {
                searching = false;
            }
        }, "odin-desktop-link").start();
    }

    private void find() {
        List<String> ids = pairing.desktops();
        if (ids.isEmpty()) {
            state = "Not paired";
            return;
        }
        state = "Searching";
        try (DatagramSocket socket = new DatagramSocket()) {
            socket.setBroadcast(true);
            socket.setSoTimeout(WAIT_MS);
            for (String id : ids) {
                byte[] data = announcement(id).toString().getBytes(StandardCharsets.UTF_8);
                String last = pairing.host(id);
                if (last != null) socket.send(new DatagramPacket(data, data.length, InetAddress.getByName(last), PORT));
                socket.send(new DatagramPacket(data, data.length, InetAddress.getByName("255.255.255.255"), PORT));
            }
            long until = System.currentTimeMillis() + WAIT_MS;
            byte[] buffer = new byte[2048];
            while (System.currentTimeMillis() < until) {
                DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                try {
                    socket.receive(packet);
                } catch (SocketTimeoutException e) {
                    break;
                }
                if (accept(packet)) return;
            }
            showSaved();
            state = "Not found";
        } catch (Exception e) {
            showSaved();
            state = "Not found";
            Status.lastError = e.getMessage() == null ? e.toString() : e.getMessage();
        }
    }

    private JSONObject announcement(String id) throws Exception {
        long time = System.currentTimeMillis();
        String receiverId = pairing.receiverId();
        return new JSONObject()
                .put("t", "odin-sync-app")
                .put("id", receiverId)
                .put("desktopId", id)
                .put("httpPort", HttpServer.PORT)
                .put("appVersion", Updater.installed)
                .put("filesAccess", android.os.Environment.isExternalStorageManager())
                .put("appVersionName", Updater.installedName)
                .put("time", time)
                .put("sig", Pairing.hex(Pairing.hmac(pairing.key(id), "app\n" + receiverId + "\n" + time)));
    }

    /** A signed answer from a paired PC: saved and shown. */
    private boolean accept(DatagramPacket packet) {
        try {
            JSONObject reply = new JSONObject(new String(packet.getData(), 0, packet.getLength(), StandardCharsets.UTF_8));
            if (!"odin-sync-desktop".equals(reply.optString("t"))) return false;
            String id = reply.getString("desktopId");
            byte[] key = pairing.key(id);
            if (key == null) return false;
            long time = reply.getLong("time");
            int port = reply.optInt("webPort", 0);
            if (Math.abs(System.currentTimeMillis() - time) > 5 * 60 * 1000) return false;
            String expected = Pairing.hex(Pairing.hmac(key, "desktop\n" + id + "\n" + time + "\n" + port));
            if (!java.security.MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8),
                    reply.optString("sig").getBytes(StandardCharsets.UTF_8))) return false;
            String address = packet.getAddress().getHostAddress();
            pairing.seen(id, address, port, reply.optString("name", null));
            JSONObject app = reply.optJSONObject("app");
            if (app != null) {
                Updater.available = app.optLong("versionCode", 0);
                Updater.availableName = app.optString("versionName", "");
            }
            desktopId = id;
            name = pairing.desktopName(id);
            host = address;
            webPort = port;
            connectedAt = System.currentTimeMillis();
            state = "Connected";
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** A PC answering "odin-sync-find": shown for pairing. */
    static final class Pc {
        final String desktopId;
        final String name;
        final String host;
        final int webPort;

        Pc(String desktopId, String name, String host, int webPort) {
            this.desktopId = desktopId;
            this.name = name;
            this.host = host;
            this.webPort = webPort;
        }
    }

    /** Odin Sync PCs on the network (broadcast). Network: call off the main thread. */
    static List<Pc> findPcs() throws Exception {
        List<Pc> found = new java.util.ArrayList<>();
        try (DatagramSocket socket = new DatagramSocket()) {
            socket.setBroadcast(true);
            socket.setSoTimeout(WAIT_MS);
            byte[] data = new JSONObject().put("t", "odin-sync-find").toString().getBytes(StandardCharsets.UTF_8);
            socket.send(new DatagramPacket(data, data.length, InetAddress.getByName("255.255.255.255"), PORT));
            long until = System.currentTimeMillis() + WAIT_MS;
            byte[] buffer = new byte[2048];
            while (System.currentTimeMillis() < until) {
                DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                try {
                    socket.receive(packet);
                } catch (SocketTimeoutException e) {
                    break;
                }
                try {
                    JSONObject reply = new JSONObject(new String(packet.getData(), 0, packet.getLength(), StandardCharsets.UTF_8));
                    if (!"odin-sync-pc".equals(reply.optString("t"))) continue;
                    String id = reply.getString("desktopId");
                    boolean known = false;
                    for (Pc pc : found) known |= pc.desktopId.equals(id);
                    if (!known) {
                        found.add(new Pc(id, reply.optString("name", "PC"), packet.getAddress().getHostAddress(), reply.optInt("webPort", 8765)));
                    }
                } catch (Exception ignored) {
                    // Not ours.
                }
            }
        }
        return found;
    }

    /**
     * Pairs with a PC: ECDH key exchange, then the PIN encrypted with the agreed
     * key (AES-256-GCM, so it never crosses the network in the clear). The PC
     * checks the PIN and proves it holds the same key. Network: off the main thread.
     */
    void pair(Pc pc, String pin) throws Exception {
        java.security.KeyPair mine = Pairing.newKeyPair();
        String receiverId = pairing.receiverId();
        String base = "http://" + pc.host + ":" + pc.webPort;
        JSONObject started = post(base + "/device/pair/start", new JSONObject()
                .put("receiverId", receiverId)
                .put("name", android.os.Build.MODEL == null ? "Android device" : android.os.Build.MODEL.replace('_', ' '))
                .put("httpPort", HttpServer.PORT)
                .put("gpu", Gpu.name)
                .put("publicKey", android.util.Base64.encodeToString(mine.getPublic().getEncoded(), android.util.Base64.NO_WRAP)));
        byte[] key = Pairing.agree(mine, started.getString("publicKey"));
        byte[] iv = new byte[12];
        new java.security.SecureRandom().nextBytes(iv);
        javax.crypto.Cipher cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(javax.crypto.Cipher.ENCRYPT_MODE,
                new javax.crypto.spec.SecretKeySpec(Pairing.hmac(key, "odin-sync pin key"), "AES"),
                new javax.crypto.spec.GCMParameterSpec(128, iv));
        cipher.updateAAD(receiverId.getBytes(StandardCharsets.UTF_8));
        byte[] sealed = cipher.doFinal(pin.getBytes(StandardCharsets.UTF_8));
        JSONObject answer = post(base + "/device/pair/finish", new JSONObject()
                .put("receiverId", receiverId)
                .put("iv", android.util.Base64.encodeToString(iv, android.util.Base64.NO_WRAP))
                .put("pin", android.util.Base64.encodeToString(sealed, android.util.Base64.NO_WRAP)));
        String expected = Pairing.hex(Pairing.hmac(key, "paired\n" + receiverId));
        if (!java.security.MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8),
                answer.optString("proof").getBytes(StandardCharsets.UTF_8))) {
            throw new IllegalStateException("The PC could not be verified. Try again.");
        }
        String id = answer.getString("desktopId");
        pairing.save(id, answer.optString("name", pc.name), key, pc.host, answer.optInt("webPort", pc.webPort));
        desktopId = id;
        name = pairing.desktopName(id);
        host = pc.host;
        webPort = answer.optInt("webPort", pc.webPort);
        connectedAt = System.currentTimeMillis();
        state = "Connected";
    }

    private static JSONObject post(String url, JSONObject body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(15000);
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json");
        try (OutputStream out = connection.getOutputStream()) {
            out.write(body.toString().getBytes(StandardCharsets.UTF_8));
        }
        return answer(connection);
    }

    private static JSONObject answer(HttpURLConnection connection) throws Exception {
        int status = connection.getResponseCode();
        InputStream in = status == 200 ? connection.getInputStream() : connection.getErrorStream();
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        if (in != null) {
            byte[] buffer = new byte[4096];
            for (int n; (n = in.read(buffer)) > 0; ) body.write(buffer, 0, n);
        }
        JSONObject parsed;
        try {
            parsed = new JSONObject(body.toString("UTF-8"));
        } catch (Exception e) {
            parsed = new JSONObject();
        }
        if (status != 200) throw new IllegalStateException(parsed.optString("error", "The PC answered " + status + "."));
        return parsed;
    }

    /** The PC's web UI, signed in as this device (a single-use link). Network: call off the main thread. */
    String signInUrl() throws Exception {
        String id = desktopId;
        if (id == null || host.isEmpty() || webPort <= 0) throw new IllegalStateException("The PC is not connected.");
        String target = "/device/ticket";
        long time = System.currentTimeMillis();
        String signature = pairing.receiverId() + ":" + time + ":"
                + Pairing.hex(Pairing.hmac(pairing.key(id), "POST\n" + target + "\n" + time));
        HttpURLConnection connection = (HttpURLConnection) new URL("http://" + host + ":" + webPort + target).openConnection();
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(4000);
        connection.setReadTimeout(4000);
        connection.setDoOutput(true);
        connection.setRequestProperty("X-Odin-Receiver", signature);
        try (OutputStream out = connection.getOutputStream()) {
            out.write(new byte[0]);
        }
        return "http://" + host + ":" + webPort + answer(connection).getString("path");
    }
}
