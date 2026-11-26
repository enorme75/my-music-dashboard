const axios = require("axios");
const { fetchWithRetry } = require("../utils/fetchRetry");
const { normalizeImageUrl } = require("../utils/imageUrl");
const { pickTrackCandidate } = require("../utils/matchCandidates");

const DEEZER_SEARCH_URL = "https://api.deezer.com/search/track";
const REQUEST_TIMEOUT = Number(process.env.IMAGE_REQUEST_TIMEOUT_MS || 10000);
const CANDIDATE_LIMIT = 10;

function clean(value) {
  return String(value || "").replace(/"/g, " ").trim();
}

async function searchTracks(params) {
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

// Keep only candidates whose artist AND track title actually match; the
// cover comes from the matched album, never from the first hit.
async function getDeezerTrackImage(artist, track) {
  const artistName = clean(artist);
  const trackName = clean(track);
  if (!artistName || !trackName) return null;

  try {
    let items = await searchTracks({ q: `${artistName} ${trackName}` });
    let match = pickTrackCandidate(items, artistName, trackName);

    if (!match) {
      items = await searchTracks({ q: `artist:"${artistName}" track:"${trackName}"` });
      match = pickTrackCandidate(items, artistName, trackName);
    }

    const album = match?.item?.album;
    if (!album) return null;

    return normalizeImageUrl(
      album.cover_xl || album.cover_big || album.cover_medium || album.cover
    );
  } catch {
    return null;
  }
}

module.exports = { getDeezerTrackImage };
