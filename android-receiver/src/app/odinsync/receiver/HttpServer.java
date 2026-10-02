package app.odinsync.receiver;

import org.json.JSONArray;
import org.json.JSONObject;

import android.os.Environment;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * A small HTTP/1.1 server for the desktop app. One request per connection.
 * Everything except /hello and /pair/start must be signed by a paired desktop.
 */
final class HttpServer {
    static final int PORT = 47654;
    private static final int MAX_JSON = 16 * 1024 * 1024;

    private final Pairing pairing;
    final FileOps files;
    private final String deviceName;
    private final ExecutorService workers = Executors.newCachedThreadPool();
    private volatile ServerSocket server;

    HttpServer(Pairing pairing, FileOps files, String deviceName) {
        this.pairing = pairing;
        this.files = files;
        this.deviceName = deviceName;
    }

    void start() throws IOException {
        ServerSocket listener = new ServerSocket();
        // Reopening the app right after closing it must not find the port taken.
        listener.setReuseAddress(true);
        // A large receive window keeps Wi-Fi busy while storage writes catch up.
        listener.setReceiveBufferSize(1024 * 1024);
        listener.bind(new java.net.InetSocketAddress(PORT));
        server = listener;
        Thread accept = new Thread(() -> {
            while (server != null && !server.isClosed()) {
                try {
                    Socket socket = server.accept();
                    workers.execute(() -> handle(socket));
                } catch (IOException ignored) {
                    // Closed while stopping.
                }
            }
        }, "odin-http");
        accept.setDaemon(true);
        accept.start();
    }

    void stop() {
        try {
            if (server != null) server.close();
        } catch (IOException ignored) {
            // Already closed.
        }
        server = null;
        workers.shutdownNow();
    }

    private static final class Request {
        String method;
        String target;
        String path;
        Map<String, String> query = new HashMap<>();
        Map<String, String> headers = new HashMap<>();
        InputStream body;
        long length;
        String remote;
    }

    private void handle(Socket socket) {
        // Requests and transfers yield the CPU to whatever runs in front (a game).
        android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND);
        try (Socket s = socket) {
            s.setSoTimeout(120000);
            InputStream in = new BufferedInputStream(s.getInputStream(), 256 * 1024);
            OutputStream out = s.getOutputStream();
            Request request = parse(in);
            if (request != null) request.remote = s.getInetAddress().getHostAddress();
            if (request == null) return;
            try {
                route(request, out);
            } catch (Exception e) {
                Status.lastError = e.getMessage() == null ? e.toString() : e.getMessage();
                send(out, 400, "application/json", error(Status.lastError));
            }
        } catch (IOException ignored) {
            // Connection dropped.
        }
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) >= 0) {
            if (c == '\n') break;
            if (c != '\r') line.write(c);
            if (line.size() > 16384) throw new IOException("Header too long");
        }
        if (c < 0 && line.size() == 0) return null;
        return line.toString("UTF-8");
    }

    private static Request parse(InputStream in) throws IOException {
        String first = readLine(in);
        if (first == null) return null;
        String[] parts = first.split(" ");
        if (parts.length < 2) return null;
        Request request = new Request();
        request.method = parts[0];
        request.target = parts[1];
        int question = request.target.indexOf('?');
        request.path = question < 0 ? request.target : request.target.substring(0, question);
        if (question >= 0) {
            for (String pair : request.target.substring(question + 1).split("&")) {
                int eq = pair.indexOf('=');
                if (eq <= 0) continue;
                request.query.put(URLDecoder.decode(pair.substring(0, eq), "UTF-8"), URLDecoder.decode(pair.substring(eq + 1), "UTF-8"));
            }
        }
        String line;
        while ((line = readLine(in)) != null && !line.isEmpty()) {
            int colon = line.indexOf(':');
            if (colon > 0) request.headers.put(line.substring(0, colon).trim().toLowerCase(Locale.US), line.substring(colon + 1).trim());
        }
        String length = request.headers.get("content-length");
        request.length = length == null ? 0 : Long.parseLong(length);
        request.body = in;
        return request;
    }

    private static String readBody(Request request) throws IOException {
        if (request.length > MAX_JSON) throw new IOException("Request too large.");
        byte[] data = new byte[(int) request.length];
        int offset = 0;
        while (offset < data.length) {
            int read = request.body.read(data, offset, data.length - offset);
            if (read < 0) break;
            offset += read;
        }
        return new String(data, 0, offset, StandardCharsets.UTF_8);
    }

    private static JSONObject json(Request request) throws Exception {
        String text = readBody(request);
        return text.isEmpty() ? new JSONObject() : new JSONObject(text);
    }

    private static byte[] error(String message) {
        try {
            return new JSONObject().put("error", message).toString().getBytes(StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "{\"error\":\"error\"}".getBytes(StandardCharsets.UTF_8);
        }
    }

    private static void send(OutputStream out, int status, String type, byte[] body) throws IOException {
        String head = "HTTP/1.1 " + status + (status == 200 ? " OK" : " Error") + "\r\n"
                + "Content-Type: " + type + "\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }

    private static void sendJson(OutputStream out, Object value) throws IOException {
        send(out, 200, "application/json", value.toString().getBytes(StandardCharsets.UTF_8));
    }

    JSONObject hello(String desktopId) throws Exception {
        JSONObject info = new JSONObject();
        info.put("app", "odin-sync-receiver");
        info.put("version", 2);
        info.put("id", pairing.receiverId());
        info.put("name", deviceName);
        info.put("httpPort", PORT);
        info.put("paired", pairing.isPaired(desktopId));
        info.put("state", Status.summary());
        info.put("gpu", Gpu.name);
        info.put("filesAccess", Environment.isExternalStorageManager());
        info.put("memoryMb", Status.memoryMb);
        info.put("lastTrim", Status.lastTrim);
        info.put("appVersion", Updater.installed);
        info.put("appVersionName", Updater.installedName);
        return info;
    }

    private void route(Request r, OutputStream out) throws Exception {
        if (r.method.equals("GET") && r.path.equals("/hello")) {
            sendJson(out, hello(r.headers.get("x-odin-desktop")));
            return;
        }
        String desktop = pairing.verify(r.method, r.target, r.headers.get("x-odin-auth"));
        if (desktop == null) {
            send(out, 401, "application/json", error("Not paired with this PC."));
            return;
        }
        Status.lastActivity = System.currentTimeMillis();
        // The PC reached us: remember where it is now (its web port stays as known).
        pairing.seen(desktop, r.remote, -1, null);
        if (desktop.equals(DesktopLink.desktopId)) {
            DesktopLink.host = r.remote;
            DesktopLink.state = "Connected";
            DesktopLink.connectedAt = System.currentTimeMillis();
        }
        // Without "All files access" nothing on shared storage can be read or
        // written: say so at once instead of failing (or hanging) later.
        boolean fileRequest = !r.path.equals("/status") && !r.path.startsWith("/session/");
        if (fileRequest && !Environment.isExternalStorageManager()) {
            send(out, 403, "application/json", error(
                    "Allow file access on the device: open the Odin Sync app there and tap Allow access to files."));
            return;
        }
        if (!r.method.equals("GET") && r.query.get("path") != null) files.changed(r.query.get("path"));
        if (r.path.equals("/remove") || r.path.equals("/rmdirs") || r.path.equals("/mkdirs") || r.path.equals("/commit")
                || r.path.equals("/delete") || r.path.equals("/mkdir")) {
            files.changed("/storage");
        }
        switch (r.method + " " + r.path) {
            case "GET /status":
                sendJson(out, new JSONObject().put("state", Status.summary()).put("percent", Status.percent()));
                return;
            case "POST /session/begin": {
                JSONObject body = json(r);
                Status.beginSession(pairing.desktopName(desktop), body.optInt("files"), body.optLong("bytes"));
                Status.state = "Syncing";
                sendJson(out, new JSONObject().put("ok", true));
                return;
            }
            case "POST /session/end":
                json(r);
                Status.endSession();
                sendJson(out, new JSONObject().put("ok", true));
                return;
            case "POST /list":
                send(out, 200, "text/plain; charset=utf-8", files.list(json(r).getJSONArray("roots")).getBytes(StandardCharsets.UTF_8));
                return;
            case "POST /space":
                sendJson(out, files.space(json(r).getJSONArray("roots")));
                return;
            case "POST /mkdirs":
                files.mkdirs(json(r).getJSONArray("dirs"));
                sendJson(out, new JSONObject().put("ok", true));
                return;
            case "POST /commit": {
                JSONObject body = json(r);
                files.commit(body.getString("temporary"), body.getString("path"), body.getString("sha256"),
                        body.optLong("mtime"), body.optLong("size"));
                sendJson(out, new JSONObject().put("ok", true));
                return;
            }
            case "PUT /file": {
                String[] received = files.receive(r.query.get("path"), r.length, r.body, () -> {
                    if (!"100-continue".equalsIgnoreCase(r.headers.get("expect"))) return;
                    try {
                        out.write("HTTP/1.1 100 Continue\r\n\r\n".getBytes(StandardCharsets.UTF_8));
                        out.flush();
                    } catch (IOException e) {
                        throw new java.io.UncheckedIOException(e);
                    }
                });
                sendJson(out, new JSONObject().put("temporary", received[0]).put("sha256", received[1]));
                return;
            }
            case "POST /remove":
                sendJson(out, new JSONObject().put("removed", files.remove(json(r).getJSONArray("files"))));
                return;
            case "POST /rmdirs":
                files.rmdirs(json(r).getJSONArray("dirs"));
                sendJson(out, new JSONObject().put("ok", true));
                return;
            case "POST /removeTemps":
                files.removeTemps(json(r).getJSONArray("paths"));
                sendJson(out, new JSONObject().put("ok", true));
                return;
            case "POST /read": {
                byte[] data = files.read(json(r).getString("path"), 64L * 1024 * 1024);
                if (data == null) send(out, 404, "application/json", error("Not found"));
                else send(out, 200, "application/octet-stream", data);
                return;
            }
            case "GET /download": {
                // A file, streamed (folders are listed with /list and fetched one by one).
                java.io.File file = FileOps.safe(r.query.get("path")).getCanonicalFile();
                if (!file.isFile()) {
                    send(out, 404, "application/json", error("Not found"));
                    return;
                }
                String head = "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: " + file.length()
                        + "\r\nConnection: close\r\n\r\n";
                out.write(head.getBytes(StandardCharsets.UTF_8));
                try (java.io.InputStream in = new java.io.FileInputStream(file)) {
                    byte[] buffer = new byte[1024 * 1024];
                    for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
                }
                out.flush();
                return;
            }
            case "GET /size":
                sendJson(out, files.size(r.query.get("path")));
                return;
            case "GET /browse":
                sendJson(out, files.browse(r.query.get("path"), "1".equals(r.query.get("foldersOnly")), "1".equals(r.query.get("sizes"))));
                return;
            case "POST /mkdir": {
                JSONObject body = json(r);
                files.mkdir(body.getString("parent"), body.getString("name"));
                sendJson(out, new JSONObject().put("ok", true));
                return;
            }
            case "POST /delete": {
                JSONObject body = json(r);
                files.delete(body.getString("path"), body.optString("type"), body.optString("fingerprint", null));
                sendJson(out, new JSONObject().put("ok", true));
                return;
            }
            default:
                send(out, 404, "application/json", error("Unknown request."));
        }
    }

    private static long parseLong(String value) {
        try {
            return value == null ? 0 : Long.parseLong(value);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    static JSONArray array(Object... values) {
        JSONArray result = new JSONArray();
        for (Object v : values) result.put(v);
        return result;
    }
}
