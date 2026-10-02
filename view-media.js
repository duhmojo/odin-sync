// Scraped artwork and metadata in Library: cover thumbnails, the details
// dialog, and the Scrape missing / Stop controls.
const mediaState = { thumbs: new Map(), scraping: null };

function scrapable(folder) {
  return folder.type === "roms" || folder.type === "games";
}

function thumbKey(folderId, itemId) {
  return folderId + "\n" + itemId;
}

async function loadThumbs(folderId, items) {
  const folder = folderById(folderId);
  if (!folder || !scrapable(folder) || !items.length) return;
  const ids = items.map((item) => item.id);
  const thumbs = await api("media:thumbs", folderId, ids).catch(() => ({}));
  for (const id of ids) mediaState.thumbs.delete(thumbKey(folderId, id));
  for (const [id, value] of Object.entries(thumbs))
    mediaState.thumbs.set(thumbKey(folderId, id), value);
  if (library.folderId === folderId) renderLibraryRows();
}

// The name cell's content: thumbnail, the name (opens details), scraped title.
function mediaName(folder, item) {
  if (!scrapable(folder)) return [el("strong", item.name)];
  const info = mediaState.thumbs.get(thumbKey(folder.id, item.id));
  const parts = [];
  if (info?.thumb) {
    const img = el("img", undefined, "item-thumb");
    img.src = info.thumb;
    img.alt = "";
    parts.push(img);
  }
  const name = button(item.name, () => openDetails(folder, item), "link-button");
  name.title = "Show artwork and details";
  parts.push(name);
  if (info?.title && info.title !== item.name.replace(/\.[^.]+$/, ""))
    parts.push(el("small", info.title));
  if (info?.notFound) parts.push(el("small", "No match found — open to search", "warning-text"));
  return parts;
}

function renderScrapeTools(folder) {
  const tools = $("library-browser").querySelector(".browser-tools");
  tools.querySelectorAll(".scrape-tool").forEach((node) => node.remove());
  if (!scrapable(folder)) return;
  const running = mediaState.scraping;
  if (running) {
    const label = running.total
      ? `Stop scraping (${running.current} of ${running.total})`
      : "Stop scraping";
    tools.prepend(button(label, () => task(() => api("scrape:cancel")), "scrape-tool"));
    return;
  }
  const scrape = button(
    "Scrape missing",
    () => startScrape(folder, { relative: library.relative, missingOnly: true }),
    "scrape-tool",
  );
  scrape.title = "Download covers, screenshots and details for items that have none yet";
  tools.prepend(scrape);
}

function startScrape(folder, options) {
  return task(async () => {
    mediaState.scraping = { folderId: folder.id, current: 0, total: 0 };
    renderLibrary();
    try {
      const result = await api("scrape:start", folder.id, options);
      const parts = [`${result.done} scraped`];
      if (result.notFound.length) parts.push(`${result.notFound.length} not found`);
      if (result.failed.length)
        parts.push(`${result.failed.length} failed (${result.failed[0].message})`);
      if (!result.total) parts.splice(0, parts.length, "Everything here is already scraped");
      status(
        `${result.stopped ? "Scraping stopped" : "Scraping finished"}: ${parts.join(", ")}.`,
        result.failed.length > 0,
      );
    } finally {
      mediaState.scraping = null;
      await loadThumbs(folder.id, library.listing?.items || []);
      renderLibrary();
    }
  });
}

window.odin.onScrape?.((progress) => {
  if (progress.finished || !mediaState.scraping) return;
  mediaState.scraping = { ...mediaState.scraping, ...progress };
  if (progress.item) status(`Scraping ${progress.current} of ${progress.total}: ${progress.item}`);
  if (library.folderId === progress.folderId) renderScrapeTools(folderById(progress.folderId));
});

function detailRow(label, value) {
  if (!value) return null;
  const row = el("div", undefined, "detail-row");
  row.append(el("span", label, "muted"), el("span", String(value)));
  return row;
}

async function openDetails(folder, item) {
  const dialog = $("details-dialog");
  $("details-title").textContent = item.name;
  $("details-body").replaceChildren(el("p", "Loading…", "muted"));
  if (!dialog.open) dialog.showModal();
  const meta = await api("media:details", folder.id, item.id).catch((error) => ({
    error: cleanError(error),
  }));
  renderDetails(folder, item, meta);
}

function renderDetails(folder, item, meta) {
  const body = [];
  if (!meta || meta.error) {
    body.push(el("p", meta?.error || "Not scraped yet.", "muted"));
  } else {
    if (meta.title) $("details-title").textContent = meta.title;
    const top = el("div", undefined, "details-top");
    if (meta.cover) {
      const cover = el("img", undefined, "details-cover");
      cover.src = meta.cover;
      cover.alt = "Cover";
      top.append(cover);
    }
    const fields = el("div", undefined, "details-fields");
    fields.append(
      ...[
        detailRow("Developer", meta.developer),
        detailRow("Publisher", meta.publisher),
        detailRow("Released", meta.releaseDate),
        detailRow("Genre", meta.genre),
        detailRow("System", meta.system && (state.systemNames?.[meta.system] || meta.system)),
        detailRow("Steam app", meta.steamAppId),
        detailRow(
          "Source",
          meta.source === "libretro"
            ? "libretro (matched by " + (meta.matchedBy || "name") + ")"
            : meta.source,
        ),
      ].filter(Boolean),
    );
    if (meta.notFound) fields.append(el("p", "No match was found for this item.", "warning-text"));
    if (meta.description) fields.append(el("p", meta.description, "details-description"));
    top.append(fields);
    body.push(top);
    if (meta.screenshot) {
      const shot = el("img", undefined, "details-screenshot");
      shot.src = meta.screenshot;
      shot.alt = "Screenshot";
      body.push(shot);
    }
  }
  const actions = el("div", undefined, "card-actions");
  const again = button(meta && !meta.error ? "Scrape again" : "Scrape now", () =>
    task(async () => {
      await api("scrape:start", folder.id, { itemIds: [item.id] });
      await loadThumbs(folder.id, [item]);
      renderDetails(folder, item, await api("media:details", folder.id, item.id));
    }, again),
  );
  actions.append(again);
  body.push(actions);
  if (folder.type === "games") body.push(steamPicker(folder, item, meta));
  if (folder.type === "games" && typeof gameNativeSection === "function")
    body.push(gameNativeSection(folder, item, meta));
  $("details-body").replaceChildren(...body);
}

// Wrong game? Search Steam and pick the right one.
function steamPicker(folder, item, meta) {
  const box = el("details", undefined, "steam-picker");
  box.append(el("summary", "Wrong game? Search Steam"));
  const row = el("div", undefined, "input-action");
  const input = el("input");
  input.value = meta?.searched || item.name;
  const results = el("div", undefined, "steam-results");
  const search = button("Search", () =>
    task(async () => {
      const found = await api("steam:search", input.value);
      results.replaceChildren(
        ...(found.length ? found : [{ name: "Nothing found on Steam." }]).map((candidate) => {
          if (!candidate.appId) return el("p", candidate.name, "muted");
          const choice = el("div", undefined, "steam-result");
          const use = button("Use this", () =>
            task(async () => {
              await api("scrape:start", folder.id, {
                itemIds: [item.id],
                appIds: { [item.id]: candidate.appId },
              });
              await loadThumbs(folder.id, [item]);
              renderDetails(folder, item, await api("media:details", folder.id, item.id));
            }, use),
          );
          choice.append(el("span", `${candidate.name} (${candidate.appId})`), use);
          return choice;
        }),
      );
    }, search),
  );
  input.onkeydown = (event) => {
    if (event.key === "Enter") search.click();
  };
  row.append(input, search);
  // Or paste the exact game's Steam link.
  const pasteRow = el("div", undefined, "input-action");
  const paste = el("input");
  paste.placeholder = "Paste a Steam store link or app id";
  paste.setAttribute("aria-label", "Steam store link or app id");
  const usePaste = button("Use link", () =>
    task(async () => {
      const app = await api("steam:resolve", paste.value);
      await api("scrape:start", folder.id, {
        itemIds: [item.id],
        appIds: { [item.id]: app.appId },
      });
      await loadThumbs(folder.id, [item]);
      renderDetails(folder, item, await api("media:details", folder.id, item.id));
      status(`Matched ${item.name} to ${app.title} (Steam app ${app.appId}).`);
    }, usePaste),
  );
  paste.onkeydown = (event) => {
    if (event.key === "Enter") usePaste.click();
  };
  pasteRow.append(paste, usePaste);
  const store = el("a", "Search on the Steam store", "site-link");
  store.href = `https://store.steampowered.com/search/?term=${encodeURIComponent(input.value)}`;
  store.target = "_blank";
  store.rel = "noopener noreferrer";
  input.addEventListener("input", () => {
    store.href = `https://store.steampowered.com/search/?term=${encodeURIComponent(input.value)}`;
  });
  const help = el("p", undefined, "muted");
  help.append(store, document.createTextNode(", open the game's page, then paste its link above."));
  box.append(row, results, pasteRow, help);
  return box;
}

$("details-close").onclick = () => $("details-dialog").close();

// GameNative: the best reported configs for this game on the chosen device's
// GPU, and saving one to the device for Import Config. The game is found by
// name (ignoring case; same-name entries are combined), or from a pasted
// Steam store link, GameNative link with gameId=, or game id.
function gameNativeSection(folder, item, meta) {
  const box = el("details", undefined, "gamenative");
  box.append(el("summary", "GameNative config"));
  const device = deviceById(state.deviceId);
  if (!device) {
    box.append(el("p", "Choose a device in Library to find configs for its GPU.", "muted"));
    return box;
  }
  const title = meta?.title || item.name;
  const row = el("div", undefined, "input-action");
  const input = el("input");
  input.value = title;
  input.placeholder = "Game name, Steam store link, or GameNative link / game id";
  input.setAttribute("aria-label", "GameNative game");
  const results = el("div");
  const find = button("Find configs", () => lookup(input.value), "primary");
  input.onkeydown = (event) => {
    if (event.key === "Enter") find.click();
  };
  row.append(input, find);
  const site = el("a", "Search on gamenative.app", "site-link");
  site.href = "https://gamenative.app/compatibility/";
  site.target = "_blank";
  site.rel = "noopener noreferrer";
  const help = el("p", undefined, "muted");
  help.append(
    document.createTextNode(
      `Configs for ${device.gpu || "this device's GPU"}. Not the right game? `,
    ),
    site,
    document.createTextNode(
      ` (choose “${title}” and ${device.gpu || "your GPU"} there), then paste a Steam store link or a link with gameId= here.`,
    ),
  );
  box.append(row, help, results);

  function lookup(text) {
    return task(async () => {
      const pasted = text.trim() === title ? "" : text.trim();
      const found = await api("gamenative:configs", folder.id, item.id, device.id, pasted);
      results.replaceChildren(...renderFound(found));
    }, find);
  }

  function renderFound(found) {
    const parts = [];
    if (found.games.length) {
      const list = found.games.map((g) => `${g.name} (${plural(g.reports, "report")})`).join(", ");
      parts.push(
        el(
          "p",
          found.games.length > 1
            ? `Found ${found.games.length} entries for this game, combined: ${list}.`
            : `Found ${list}.`,
          "muted",
        ),
      );
    } else {
      parts.push(el("p", `GameNative has no game called “${found.title}”.`, "muted"));
    }
    if (found.others?.length) {
      const others = el("div", undefined, "gamenative-others");
      others.append(el("span", "Other games: ", "muted"));
      for (const game of found.others) {
        others.append(button(game.name, () => lookup(String(game.id)), "link-button"));
      }
      parts.push(others);
    }
    if (found.games.length && !found.runs.length) {
      parts.push(el("p", `No reports with a config on ${found.gpu} yet.`, "muted"));
    }
    parts.push(
      ...found.runs.map((run, index) => {
        const line = el("div", undefined, "gamenative-run");
        const stars = "★".repeat(run.rating || 0) + "☆".repeat(Math.max(0, 5 - (run.rating || 0)));
        const date = run.createdAt ? new Date(run.createdAt).toLocaleDateString() : "";
        const text = el("div");
        const details = [
          date,
          run.appVersion && `GameNative ${run.appVersion}`,
          run.avgFps && `${Math.round(run.avgFps)} FPS avg`,
          found.games.length > 1 && run.gameName,
        ];
        text.append(
          el("strong", `${stars}  ${run.device}`),
          el("small", details.filter(Boolean).join(" · ")),
        );
        if (run.notes) text.append(el("small", run.notes));
        const save = button(index === 0 ? "Save best to device" : "Save to device", () =>
          task(async () => {
            const result = await api(
              "gamenative:save",
              device.id,
              run.gameId,
              found.gpu,
              run.id,
              run.gameName || found.title,
            );
            status(
              `Saved ${result.target}. In GameNative, open the game's settings and use Import Config with this file.`,
            );
          }, save),
        );
        if (index === 0) save.classList.add("primary");
        line.append(text, save);
        return line;
      }),
    );
    if (found.runs.length)
      parts.push(
        el(
          "p",
          `Saved to ${found.folder} on ${device.name} (change it in Device profiles).`,
          "muted",
        ),
      );
    return parts;
  }

  return box;
}
