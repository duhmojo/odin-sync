// HTTP for the scrapers: one place for timeouts, the user agent and test fakes.
const USER_AGENT = "OdinSync/0.6 (+https://github.com/)";
const TIMEOUT_MS = 20000;

let fetcher = (...args) => fetch(...args);

// Tests replace the network with recorded responses.
function setFetch(fn) {
  fetcher = fn;
}

async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || TIMEOUT_MS);
  try {
    const response = await fetcher(url, {
      headers: { "User-Agent": USER_AGENT, ...(options.headers || {}) },
      signal: controller.signal,
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}.`);
    return response;
  } catch (error) {
    if (error.name === "AbortError")
      throw new Error(`${new URL(url).host} did not answer in time.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function getText(url, options) {
  const response = await request(url, options);
  return response ? response.text() : null;
}

async function getJson(url, options) {
  const response = await request(url, options);
  return response ? response.json() : null;
}

async function getBuffer(url, options) {
  const response = await request(url, options);
  if (!response) return null;
  return {
    data: Buffer.from(await response.arrayBuffer()),
    type: response.headers.get("content-type") || "",
  };
}

module.exports = { setFetch, getText, getJson, getBuffer, USER_AGENT };
