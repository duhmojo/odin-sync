package app.odinsync.receiver;

import android.content.Context;
import android.os.StatFs;
import android.os.storage.StorageManager;
import android.os.storage.StorageVolume;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * File operations on shared storage, mirroring what the desktop does over ADB:
 * listing, free space, verified writes (temporary name, SHA-256, rename),
 * size-checked removal, empty-folder removal and storage browsing.
 * Only paths inside /storage (which includes /sdcard) are allowed.
 */
final class FileOps {
    static final String LISTING_END = "__ODIN_SYNC_LISTING_END__";
    private static final Pattern TEMP_NAME =
            Pattern.compile("\\.odin-sync-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.part$");

    private final Context context;

    FileOps(Context context) {
        this.context = context;
    }

    /** A device path as a File, refusing anything outside shared storage. */
    static File safe(String path) throws IOException {
        if (path == null || !path.startsWith("/") || path.contains("\0") || path.contains("\n")) {
            throw new IOException("Invalid path.");
        }
        for (String part : path.split("/")) if (part.equals("..")) throw new IOException("Invalid path.");
        File file = new File(path);
        String canonical = file.getCanonicalPath();
        if (!canonical.equals("/storage") && !canonical.startsWith("/storage/")) {
            throw new IOException("Only shared storage and SD cards are allowed.");
        }
        return file;
    }

    /** "size|path" lines for every file under the roots, then the end marker. */
    String list(JSONArray roots) throws Exception {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < roots.length(); i++) {
            String root = roots.getString(i).replaceAll("/+$", "");
            File dir = safe(root);
            if (dir.isDirectory()) walk(dir, root, out);
        }
        out.append(LISTING_END).append('\n');
        return out.toString();
    }

    private void walk(File dir, String shown, StringBuilder out) {
        File[] children = dir.listFiles();
        if (children == null) return;
        for (File child : children) {
            String path = shown + "/" + child.getName();
            if (child.isDirectory()) walk(child, path, out);
            else if (child.isFile()) out.append(child.length()).append('|').append(path).append('\n');
        }
    }

    /** Free space per root (measured at the nearest existing parent). */
    JSONArray space(JSONArray roots) throws Exception {
        JSONArray result = new JSONArray();
        StorageManager storage = context.getSystemService(StorageManager.class);
        for (int i = 0; i < roots.length(); i++) {
            String root = roots.getString(i);
            File dir = safe(root);
            while (dir != null && !dir.exists()) dir = dir.getParentFile();
            if (dir == null) continue;
            StatFs stat = new StatFs(dir.getPath());
            StorageVolume volume = storage.getStorageVolume(dir);
            File mount = volume != null ? volume.getDirectory() : null;
            JSONObject entry = new JSONObject();
            entry.put("root", root);
            entry.put("total", stat.getTotalBytes());
            entry.put("available", stat.getAvailableBytes());
            entry.put("mount", mount != null ? mount.getPath() : dir.getPath());
            result.put(entry);
        }
        return result;
    }

    void mkdirs(JSONArray dirs) throws Exception {
        for (int i = 0; i < dirs.length(); i++) {
            File dir = safe(dirs.getString(i));
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Could not create " + dir.getPath());
        }
    }

    /** Uploads kept as temporary files until the desktop commits them: path -> SHA-256. */
    private final Map<String, String> uploaded = new ConcurrentHashMap<>();

    /**
     * Receives one file into a temporary name next to the target, hashing it
     * while it is written. Everything that can fail before the data arrives
     * (path, folder, permission) is checked first; then ready() is called so
     * the desktop starts sending (HTTP 100 Continue). Returns the temporary
     * path and its SHA-256; commit() moves it into place once the desktop
     * confirms its own hash of what it sent matches.
     */
    String[] receive(String target, long size, InputStream body, Runnable ready) throws Exception {
        File file = safe(target);
        File parent = file.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IOException("Could not create " + parent.getPath());
        }
        File temporary = new File(file.getPath() + ".odin-sync-" + UUID.randomUUID() + ".part");
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        Status.currentFile = file.getName();
        Status.fileSize = size;
        Status.fileBytes = 0;
        long written = 0;
        try (FileOutputStream out = new FileOutputStream(temporary)) {
            ready.run();
            // Network reads return a few KB at a time; shared storage goes
            // through FUSE, where every write is costly. Fill 256 KB, then write.
            byte[] buffer = new byte[256 * 1024];
            long flushed = 0;
            boolean ended = false;
            while (written < size && !ended) {
                int want = (int) Math.min(buffer.length, size - written);
                int filled = 0;
                while (filled < want) {
                    int read = body.read(buffer, filled, want - filled);
                    if (read < 0) {
                        ended = true;
                        break;
                    }
                    filled += read;
                    Status.fileBytes = written + filled;
                }
                out.write(buffer, 0, filled);
                digest.update(buffer, 0, filled);
                written += filled;
                Status.lastActivity = System.currentTimeMillis();
                // Every 64 MB: write it out so Android can reclaim the cache,
                // so a long transfer does not crowd a running game.
                if (written - flushed >= 64L * 1024 * 1024) {
                    release(out);
                    flushed = written;
                }
                // Android is short of memory: give it a moment.
                while (System.currentTimeMillis() < Status.pauseUntil) {
                    try {
                        Thread.sleep(250);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
            }
            release(out);
        } catch (IOException | RuntimeException e) {
            temporary.delete();
            throw e;
        }
        if (written != size) {
            temporary.delete();
            throw new IOException("The copy was incomplete and was removed.");
        }
        String actual = Pairing.hex(digest.digest());
        uploaded.put(temporary.getPath(), actual);
        return new String[] {temporary.getPath(), actual};
    }

    /** Writes a file's data out to storage: cached copies are then clean, and
     *  Android reclaims those first when an app needs memory. */
    private static void release(FileOutputStream out) {
        try {
            out.getFD().sync();
        } catch (Exception ignored) {
            // Best effort.
        }
    }

    /** Forgets every cached folder size (Android asked for memory back). */
    void trim() {
        sizes.clear();
    }

    /** Moves a received temporary file over its target if the hashes agree. */
    void commit(String temporaryPath, String target, String sha256, long mtime, long size) throws Exception {
        File file = safe(target);
        File temporary = safe(temporaryPath);
        String actual = uploaded.remove(temporary.getPath());
        if (actual == null || !temporary.getPath().startsWith(file.getPath() + ".odin-sync-")
                || !TEMP_NAME.matcher(temporary.getName()).find()) {
            throw new IOException("Unknown upload.");
        }
        if (!actual.equalsIgnoreCase(sha256)) {
            temporary.delete();
            throw new IOException("The copy failed checksum verification and was removed.");
        }
        if (file.exists() && !file.delete()) {
            temporary.delete();
            throw new IOException("Could not replace " + file.getPath());
        }
        if (!temporary.renameTo(file)) {
            temporary.delete();
            throw new IOException("Could not move the copy into place.");
        }
        if (mtime > 0) file.setLastModified(mtime * 1000);
        Status.sessionDone += size;
        Status.sessionFilesDone++;
        Status.fileBytes = 0;
        Status.fileSize = 0;
    }

    /** Removes each file only if it still has the expected size. */
    JSONArray remove(JSONArray files) throws Exception {
        JSONArray removed = new JSONArray();
        for (int i = 0; i < files.length(); i++) {
            JSONObject entry = files.getJSONObject(i);
            File file = safe(entry.getString("path"));
            if (file.isFile() && file.length() == entry.getLong("size") && file.delete()) removed.put(i);
        }
        return removed;
    }

    /** Removes folders that are empty (deepest first, as given). */
    void rmdirs(JSONArray dirs) throws Exception {
        for (int i = 0; i < dirs.length(); i++) {
            File dir = safe(dirs.getString(i));
            String[] children = dir.list();
            if (dir.isDirectory() && children != null && children.length == 0) dir.delete();
        }
    }

    /** Removes this app's own leftover temporary files only. */
    void removeTemps(JSONArray paths) throws Exception {
        for (int i = 0; i < paths.length(); i++) {
            String path = paths.getString(i);
            if (!TEMP_NAME.matcher(path).find()) continue;
            File file = safe(path);
            if (file.isFile()) file.delete();
        }
    }

    byte[] read(String path, long limit) throws Exception {
        File file = safe(path);
        if (!file.isFile()) return null;
        if (file.length() > limit) throw new IOException("File too large.");
        byte[] data = new byte[(int) file.length()];
        try (InputStream in = new FileInputStream(file)) {
            int offset = 0;
            while (offset < data.length) {
                int read = in.read(data, offset, data.length - offset);
                if (read < 0) break;
                offset += read;
            }
        }
        return data;
    }

    JSONArray volumes() throws Exception {
        JSONArray result = new JSONArray();
        StorageManager storage = context.getSystemService(StorageManager.class);
        for (StorageVolume volume : storage.getStorageVolumes()) {
            File dir = volume.getDirectory();
            if (dir == null) continue;
            JSONObject entry = new JSONObject();
            entry.put("id", volume.isPrimary() ? "internal" : volume.getUuid());
            entry.put("path", dir.getPath());
            entry.put("label", volume.isPrimary() ? "Internal storage" : volume.getDescription(context));
            entry.put("kind", volume.isPrimary() ? "internal" : volume.isRemovable() ? "sd" : "removable");
            entry.put("readOnly", !"mounted".equals(volume.getState()));
            try {
                StatFs stat = new StatFs(dir.getPath());
                entry.put("total", stat.getTotalBytes());
                entry.put("available", stat.getAvailableBytes());
            } catch (IllegalArgumentException ignored) {
                // Not mounted.
            }
            result.put(entry);
        }
        return result;
    }

    /** One folder's entries for the storage browser. */
    JSONObject browse(String path, boolean foldersOnly, boolean sizes) throws Exception {
        JSONObject result = new JSONObject();
        JSONArray volumes = volumes();
        result.put("volumes", volumes);
        if (path == null || path.equals("/storage")) {
            JSONArray entries = new JSONArray();
            for (int i = 0; i < volumes.length(); i++) {
                JSONObject v = volumes.getJSONObject(i);
                JSONObject entry = new JSONObject();
                entry.put("name", v.getString("label"));
                entry.put("path", v.getString("path"));
                entry.put("type", "volume");
                entry.put("volumeKind", v.getString("kind"));
                if (v.has("total")) {
                    entry.put("total", v.getLong("total"));
                    entry.put("available", v.getLong("available"));
                }
                entry.put("navigable", true);
                entry.put("readable", true);
                entry.put("writable", !v.getBoolean("readOnly"));
                entries.put(entry);
            }
            result.put("path", "/storage");
            result.put("parent", JSONObject.NULL);
            result.put("writable", false);
            result.put("entries", entries);
            result.put("hiddenFiles", 0);
            return result;
        }
        File dir = safe(path);
        File canonical = dir.getCanonicalFile();
        if (!canonical.isDirectory()) throw new IOException("Permission denied or folder unavailable");
        JSONObject volume = null;
        for (int i = 0; i < volumes.length(); i++) {
            JSONObject v = volumes.getJSONObject(i);
            String root = v.getString("path");
            if (canonical.getPath().equals(root) || canonical.getPath().startsWith(root + "/")) volume = v;
        }
        File[] children = canonical.listFiles();
        List<JSONObject> folders = new ArrayList<>();
        List<JSONObject> files = new ArrayList<>();
        int hidden = 0;
        if (children != null) {
            for (File child : children) {
                if (!child.isDirectory() && foldersOnly) {
                    hidden++;
                    continue;
                }
                JSONObject entry = new JSONObject();
                entry.put("name", child.getName());
                entry.put("path", child.getPath());
                entry.put("type", child.isDirectory() ? "folder" : "file");
                // Folder sizes are asked for separately (size()), so listing stays instant.
                entry.put("size", child.isDirectory() ? -2 : child.length());
                entry.put("modified", child.lastModified());
                entry.put("readable", child.canRead());
                entry.put("writable", child.canWrite());
                entry.put("navigable", child.isDirectory() && child.canRead());
                entry.put("fingerprint", child.length() + " " + child.lastModified());
                (child.isDirectory() ? folders : files).add(entry);
            }
        }
        folders.sort((a, b) -> a.optString("name").compareToIgnoreCase(b.optString("name")));
        files.sort((a, b) -> a.optString("name").compareToIgnoreCase(b.optString("name")));
        JSONArray entries = new JSONArray();
        for (JSONObject e : folders) entries.put(e);
        for (JSONObject e : files) entries.put(e);
        String volumePath = volume != null ? volume.getString("path") : "/storage";
        result.put("path", canonical.getPath());
        result.put("parent", canonical.getPath().equals(volumePath) ? "/storage" : canonical.getParent());
        result.put("writable", canonical.canWrite() && (volume == null || !volume.getBoolean("readOnly")));
        result.put("volume", volume != null ? volume : JSONObject.NULL);
        result.put("entries", entries);
        result.put("hiddenFiles", hidden);
        result.put("warnings", new JSONArray());
        return result;
    }

    /** Sizes already added up: path -> {bytes, files, folder mtime, time}. */
    private final java.util.Map<String, long[]> sizes = new java.util.concurrent.ConcurrentHashMap<>();
    private static final long SIZE_TTL_MS = 60 * 1000;

    /**
     * A folder's total size and file count, added up within a few seconds
     * (-1 when it takes longer). Cached briefly; changes made through this app
     * clear the cache for that tree.
     */
    JSONObject size(String path) throws Exception {
        File dir = safe(path).getCanonicalFile();
        if (!dir.isDirectory()) throw new IOException("Not a folder.");
        String key = dir.getPath();
        long[] cached = sizes.get(key);
        long now = System.currentTimeMillis();
        if (cached != null && cached[2] == dir.lastModified() && now - cached[3] < SIZE_TTL_MS) {
            return new JSONObject().put("size", cached[0]).put("files", cached[1]);
        }
        long[] total = treeSize(dir, now + 3000);
        if (total == null) return new JSONObject().put("size", -1);
        sizes.put(key, new long[] {total[0], total[1], dir.lastModified(), now});
        return new JSONObject().put("size", total[0]).put("files", total[1]);
    }

    /** Forgets cached sizes of a changed path and every folder above it. */
    void changed(String path) {
        try {
            String changed = safe(path).getCanonicalPath();
            for (String key : sizes.keySet()) {
                if (changed.equals(key) || changed.startsWith(key + "/") || key.startsWith(changed + "/")) sizes.remove(key);
            }
        } catch (IOException ignored) {
            // Nothing cached for an invalid path.
        }
    }

    /** {bytes, files} under a folder, or null when the time budget runs out. */
    private static long[] treeSize(File dir, long budget) {
        long[] total = new long[2];
        java.util.ArrayDeque<File> pending = new java.util.ArrayDeque<>();
        pending.push(dir);
        while (!pending.isEmpty()) {
            if (System.currentTimeMillis() > budget) return null;
            File[] children = pending.pop().listFiles();
            if (children == null) continue;
            for (File child : children) {
                if (child.isDirectory()) pending.push(child);
                else {
                    total[0] += child.length();
                    total[1]++;
                }
            }
        }
        return total;
    }

    void mkdir(String parent, String name) throws Exception {
        if (name == null || name.isEmpty() || name.contains("/") || name.equals("..") || name.equals(".")) {
            throw new IOException("Enter a single folder name.");
        }
        File dir = new File(safe(parent), name);
        if (!dir.mkdir()) throw new IOException("Could not create the folder.");
    }

    /** Deletes a folder and everything in it (links are removed, not followed). */
    private static void deleteTree(File dir) throws IOException {
        java.nio.file.Path root = dir.toPath();
        java.nio.file.Files.walkFileTree(root, new java.nio.file.SimpleFileVisitor<java.nio.file.Path>() {
            @Override
            public java.nio.file.FileVisitResult visitFile(java.nio.file.Path path, java.nio.file.attribute.BasicFileAttributes attributes) throws IOException {
                java.nio.file.Files.delete(path);
                return java.nio.file.FileVisitResult.CONTINUE;
            }

            @Override
            public java.nio.file.FileVisitResult postVisitDirectory(java.nio.file.Path path, IOException error) throws IOException {
                if (error != null) throw error;
                java.nio.file.Files.delete(path);
                return java.nio.file.FileVisitResult.CONTINUE;
            }
        });
    }

    /** Deletes a file, or a folder with everything in it. Storage roots and Android folders are protected. */
    void delete(String path, String type, String fingerprint) throws Exception {
        File file = safe(path).getCanonicalFile();
        if (file.getPath().matches("/storage/[^/]+(/0)?(/Android(/.*)?)?")) {
            throw new IOException("Storage roots and Android-managed folders cannot be deleted here.");
        }
        if ("folder".equals(type)) {
            if (!file.isDirectory()) throw new IOException("This item changed since it was listed. Refresh before deleting.");
            deleteTree(file);
            return;
        }
        if (!file.isFile()) throw new IOException("This item changed since it was listed. Refresh before deleting.");
        if (fingerprint != null && !fingerprint.equals(file.length() + " " + file.lastModified())) {
            throw new IOException("This item changed since it was listed. Refresh before deleting.");
        }
        if (!file.delete()) throw new IOException("Could not delete the file.");
    }
}
