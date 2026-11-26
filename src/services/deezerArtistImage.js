const axios = require("axios");
const { fetchWithRetry } = require("../utils/fetchRetry");
const { pickArtistCandidate } = require("../utils/matchCandidates");

const REQUEST_TIMEOUT = Number(process.env.IMAGE_REQUEST_TIMEOUT_MS || 10000);
const CANDIDATE_LIMIT = 10;

// The first hit of a fuzzy search is NOT necessarily the right artist
// (q="Nick Drake" can rank "Nicked Drake" first): fetch several candidates
// and keep the one whose name actually matches.
async function fetchDeezerArtistImage(artist) {
  const query = String(artist || "").replace(/"/g, " ").trim();
  if (!query) return null;

  try {
    const response = await fetchWithRetry(() =>
      axios.get("https://api.deezer.com/search/artist", {
        timeout: REQUEST_TIMEOUT,
        params: { q: query, limit: CANDIDATE_LIMIT }
      }),
      2,
      500
    );

    const items = response.data?.data;
    const match = pickArtistCandidate(Array.isArray(items) ? items : [], artist);
    const item = match?.item;
    if (!item) return null;

    return item.picture_xl || item.picture_big || item.picture_medium || null;
  } catch (error) {
    console.warn(`Deezer artist image failed for ${artist}: ${error.message}`);
    return null;
  }
}

module.exports = { fetchArtistImage: fetchDeezerArtistImage };
