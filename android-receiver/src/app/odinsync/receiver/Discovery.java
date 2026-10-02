package app.odinsync.receiver;

import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;

/**
 * Answers the desktop's UDP broadcast ("odin-sync-hello") with this receiver's
 * id, name and HTTP port, so the PC finds it whatever its current IP is.
 */
final class Discovery {
    static final int PORT = 47653;

    private final HttpServer http;
    private volatile DatagramSocket socket;

    Discovery(HttpServer http) {
        this.http = http;
    }

    void start() throws Exception {
        socket = new DatagramSocket(null);
        socket.setReuseAddress(true);
        socket.setBroadcast(true);
        socket.bind(new InetSocketAddress(PORT));
        Thread thread = new Thread(this::loop, "odin-discovery");
        thread.setDaemon(true);
        thread.start();
    }

    private void loop() {
        byte[] buffer = new byte[2048];
        while (socket != null && !socket.isClosed()) {
            try {
                DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                socket.receive(packet);
                JSONObject hello = new JSONObject(new String(packet.getData(), 0, packet.getLength(), StandardCharsets.UTF_8));
                if (!"odin-sync-hello".equals(hello.optString("t"))) continue;
                JSONObject reply = http.hello(hello.optString("desktopId"));
                reply.put("t", "odin-sync-here");
                byte[] data = reply.toString().getBytes(StandardCharsets.UTF_8);
                socket.send(new DatagramPacket(data, data.length, packet.getSocketAddress()));
            } catch (Exception ignored) {
                // Bad packet or socket closed; keep listening while running.
            }
        }
    }

    void stop() {
        DatagramSocket current = socket;
        socket = null;
        if (current != null) current.close();
    }
}
