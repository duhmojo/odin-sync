package app.odinsync.receiver;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Pairing with desktops. This app and the PC agree on a key with ECDH
 * (P-256), and the app proves the person knows the PC's PIN by sending it
 * encrypted with that key (see DesktopLink.pair). Requests are then signed
 * with HMAC-SHA256 of the key.
 */
final class Pairing {
    private static final String PREFS = "pairing";
    private static final long CLOCK_SKEW_MS = 5 * 60 * 1000;

    private final SharedPreferences prefs;

    Pairing(Context context) {
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (!prefs.contains("receiverId")) {
            prefs.edit().putString("receiverId", UUID.randomUUID().toString()).apply();
        }
    }

    String receiverId() {
        return prefs.getString("receiverId", "");
    }

    boolean isPaired(String desktopId) {
        return desktopId != null && prefs.contains("key." + desktopId);
    }

    int pairedCount() {
        int count = 0;
        for (String name : prefs.getAll().keySet()) if (name.startsWith("key.")) count++;
        return count;
    }

    void unpairAll() {
        SharedPreferences.Editor editor = prefs.edit();
        for (String name : prefs.getAll().keySet()) {
            if (name.startsWith("key.") || name.startsWith("name.")) editor.remove(name);
        }
        editor.apply();
    }

    /** Saves a pairing made from this app with the PC's PIN (see DesktopLink.pair). */
    void save(String desktopId, String name, byte[] key, String host, int webPort) {
        prefs.edit()
                .putString("key." + desktopId, Base64.encodeToString(key, Base64.NO_WRAP))
                .putString("name." + desktopId, name)
                .putString("host." + desktopId, host)
                .putInt("webPort." + desktopId, webPort)
                .putLong("seen." + desktopId, System.currentTimeMillis())
                .apply();
    }

    /** ECDH (P-256) with the other side's X.509 public key; the shared key both sides derive. */
    static byte[] agree(KeyPair mine, String theirsBase64) throws Exception {
        PublicKey theirs = KeyFactory.getInstance("EC")
                .generatePublic(new X509EncodedKeySpec(Base64.decode(theirsBase64, Base64.DEFAULT)));
        KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
        agreement.init(mine.getPrivate());
        agreement.doPhase(theirs, true);
        return sha256(concat(agreement.generateSecret(), "odin-sync v1".getBytes(StandardCharsets.UTF_8)));
    }

    static KeyPair newKeyPair() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        return generator.generateKeyPair();
    }

    /** Checks "X-Odin-Auth: desktopId:time:hmac"; returns the desktop id, or null. */
    String verify(String method, String target, String header) {
        if (header == null) return null;
        String[] parts = header.split(":");
        if (parts.length != 3) return null;
        String stored = prefs.getString("key." + parts[0], null);
        if (stored == null) return null;
        return signatureValid(Base64.decode(stored, Base64.DEFAULT), method, target, header) ? parts[0] : null;
    }

    String desktopName(String desktopId) {
        return prefs.getString("name." + desktopId, "PC");
    }

    /** The paired desktops, most recently seen first. */
    List<String> desktops() {
        List<String> ids = new ArrayList<>();
        for (String name : prefs.getAll().keySet()) if (name.startsWith("key.")) ids.add(name.substring(4));
        ids.sort((a, b) -> Long.compare(prefs.getLong("seen." + b, 0), prefs.getLong("seen." + a, 0)));
        return ids;
    }

    byte[] key(String desktopId) {
        String stored = prefs.getString("key." + desktopId, null);
        return stored == null ? null : Base64.decode(stored, Base64.DEFAULT);
    }

    /** Where a desktop was last seen; webPort 0 keeps the one already known. */
    void seen(String desktopId, String host, int webPort, String name) {
        if (!isPaired(desktopId)) return;
        // Every signed request reports in; save only when something changed
        // (or once a minute, for "last seen").
        boolean same = host.equals(host(desktopId)) && webPort < 0 && name == null;
        if (same && System.currentTimeMillis() - prefs.getLong("seen." + desktopId, 0) < 60000) return;
        SharedPreferences.Editor editor = prefs.edit()
                .putString("host." + desktopId, host)
                .putLong("seen." + desktopId, System.currentTimeMillis());
        if (webPort >= 0) editor.putInt("webPort." + desktopId, webPort);
        if (name != null && !name.isEmpty()) editor.putString("name." + desktopId, name);
        editor.apply();
    }

    String host(String desktopId) {
        return prefs.getString("host." + desktopId, null);
    }

    int webPort(String desktopId) {
        return prefs.getInt("webPort." + desktopId, 0);
    }

    private static boolean signatureValid(byte[] key, String method, String target, String header) {
        String[] parts = header.split(":");
        if (parts.length != 3) return false;
        long time;
        try {
            time = Long.parseLong(parts[1]);
        } catch (NumberFormatException e) {
            return false;
        }
        if (Math.abs(System.currentTimeMillis() - time) > CLOCK_SKEW_MS) return false;
        String expected = hex(hmac(key, method + "\n" + target + "\n" + parts[1]));
        return MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8), parts[2].getBytes(StandardCharsets.UTF_8));
    }

    static byte[] hmac(byte[] key, String text) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key, "HmacSHA256"));
            return mac.doFinal(text.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    static byte[] sha256(byte[] data) throws Exception {
        return MessageDigest.getInstance("SHA-256").digest(data);
    }

    static byte[] concat(byte[] a, byte[] b) {
        byte[] result = new byte[a.length + b.length];
        System.arraycopy(a, 0, result, 0, a.length);
        System.arraycopy(b, 0, result, a.length, b.length);
        return result;
    }

    static String hex(byte[] data) {
        StringBuilder builder = new StringBuilder();
        for (byte b : data) builder.append(String.format(Locale.US, "%02x", b));
        return builder.toString();
    }
}
