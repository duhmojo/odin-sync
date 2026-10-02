// Runs scraping for many items with progress and stop, a few at a time.
const media = require("./media.cjs");
const { scrapeRom } = require("./roms.cjs");
const { scrapeGame } = require("./steam.cjs");

// items: library items of one local folder. options: {folder, mediaDir,
// cacheDir, missingOnly, onProgress, cancelled, makeThumb, screenscraper,
// concurrency}. Returns {done, failed: [{itemId, message}], notFound, stopped}.
async function scrapeItems(items, options) {
  const settings = { concurrency: 2, onProgress: () => {}, cancelled: () => false, ...options };
  const existing = settings.missingOnly
    ? await media.list(settings.mediaDir, settings.folder.id)
    : {};
  const queue = items.filter((item) => !existing[item.id]);
  const result = { done: 0, failed: [], notFound: [], stopped: false, total: queue.length };
  let next = 0;
  async function worker() {
    while (next < queue.length) {
      if (settings.cancelled()) {
        result.stopped = true;
        return;
      }
      const item = queue[next++];
      settings.onProgress({
        phase: "Scraping",
        current: next,
        total: queue.length,
        item: item.name,
        done: result.done,
      });
      try {
        const scraped =
          settings.folder.type === "games"
            ? await scrapeGame({ item, appId: settings.appIds?.[item.id] })
            : await scrapeRom({
                folder: settings.folder,
                item,
                cacheDir: settings.cacheDir,
                screenscraper: settings.screenscraper,
              });
        await media.write(
          settings.mediaDir,
          settings.folder.id,
          item.id,
          scraped.meta,
          scraped.images,
          settings.makeThumb,
        );
        if (scraped.meta.notFound) result.notFound.push(item.id);
        result.done++;
      } catch (error) {
        result.failed.push({ itemId: item.id, message: error.message });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(settings.concurrency, queue.length) }, worker));
  settings.onProgress({
    phase: "Finished",
    current: queue.length,
    total: queue.length,
    done: result.done,
    finished: true,
  });
  return result;
}

module.exports = { scrapeItems };
