require("dotenv").config();

const axios = require("axios");

const { version: APP_VERSION } = require("../../package.json");
const { fetchWithRetry } = require("../utils/fetchRetry");

const USER_AGENT = String(
  process.env.WIKIPEDIA_USER_AGENT
    || `my-music-dashboard/${APP_VERSION} (+https://github.com/enorme75/my-music-dashboard)`
);
const REQUEST_TIMEOUT = Math.max(1000, Number(process.env.IMAGE_REQUEST_TIMEOUT_MS || 10000));

function wikiApiUrl(lang) {
  const code = /^[a-z-]+$/i.test(String(lang || "")) ? String(lang).toLowerCase() : "en";
  return `https://${code}.wikipedia.org/w/api.php`;
}

async function wikiApi(lang, params) {
  return fetchWithRetry(async () => {
    const result = await axios.get(wikiApiUrl(lang), {
      timeout: REQUEST_TIMEOUT,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      params: { format: "json", ...params }
    });
    return result.data;
  }, 2, 750);
}

// Short plain-text intro of an article title, null when the page is missing.
async function getExtract(lang, title) {
  const cleanTitle = String(title || "").trim();
  if (!cleanTitle) return null;

  const data = await wikiApi(lang, {
    action: "query",
    prop: "extracts",
    exintro: 1,
    explaintext: 1,
    redirects: 1,
    titles: cleanTitle
  });

  const pages = data?.query?.pages || {};
  const page = Object.values(pages)[0];
  if (!page || page.missing !== undefined) return null;

  const extract = String(page.extract || "").trim();
  return extract || null;
}

// Artist bio in the requested language: try the exact article title first,
// then the first search hit for the artist name.
async function getArtistBio(lang, artistName) {
  const name = String(artistName || "").trim();
  if (!name) return null;

  try {
    const direct = await getExtract(lang, name);
    if (direct) return direct;

    const search = await wikiApi(lang, {
      action: "query",
      list: "search",
      srsearch: name,
      srnamespace: 0,
      srlimit: 3
    });
    const hits = Array.isArray(search?.query?.search) ? search.query.search : [];
    const hit = hits.find(entry => entry?.title);
    if (!hit) return null;

    return await getExtract(lang, hit.title);
  } catch (error) {
    console.warn(`⚠️ [Wikipedia] bio failed for "${name}" (${lang}):`, error.message);
    return null;
  }
}

module.exports = { getArtistBio, getExtract, wikiApi };
