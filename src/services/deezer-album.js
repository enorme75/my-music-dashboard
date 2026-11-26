const axios = require("axios");
const { fetchWithRetry } = require("../utils/fetchRetry");
const { pickAlbumCandidate } = require("../utils/matchCandidates");

const DEEZER_SEARCH_URL = "https://api.deezer.com/search/album";
const REQUEST_TIMEOUT = Number(process.env.IMAGE_REQUEST_TIMEOUT_MS || 10000);
const CANDIDATE_LIMIT = 10;

function clean(value) {
  return String(value || "").replace(/"/g, " ").trim();
}

async function searchAlbums(params) {
  const { data } = await fetchWithRetry(() =>
    axios.get(DEEZER_SEARCH_URL, {
      timeout: REQUEST_TIMEOUT,
      params: { limit: CANDIDATE_LIMIT, ...params }
    }),
    2,
    500
  );
  return Array.isArray(data?.data) ? data.data : [];
}

// The first hit of a fuzzy album search can be another album (a compilation,
// another artist): keep only candidates whose artist AND title match.
async function getDeezerAlbumImage(artist, album) {
  const artistName = clean(artist);
  const albumName = clean(album);
  if (!artistName || !albumName) return null;

  try {
    let items = await searchAlbums({ q: `${artistName} ${albumName}` });
    let match = pickAlbumCandidate(items, artistName, albumName);

    if (!match) {
      items = await searchAlbums({ q: `artist:"${artistName}" album:"${albumName}"` });
      match = pickAlbumCandidate(items, artistName, albumName);
    }

    const item = match?.item;
    if (!item) return null;

    return item.cover_xl || item.cover_big || item.cover_medium || item.cover || null;
  } catch {
    return null;
  }
}

module.exports = { getDeezerAlbumImage };
