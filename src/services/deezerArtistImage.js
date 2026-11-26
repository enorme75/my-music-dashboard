const axios = require("axios");
const { fetchWithRetry } = require("../utils/fetchRetry");
const { deezerImageHash, pickArtistCandidate } = require("../utils/matchCandidates");

const REQUEST_TIMEOUT = Number(process.env.IMAGE_REQUEST_TIMEOUT_MS || 10000);
const CANDIDATE_LIMIT = 10;
// Deezer serves this hash (MD5 of the empty string) when an artist has no picture.
const DEEZER_EMPTY_IMAGE_HASH = "d41d8cd98f00b204e9800998ecf8427e";

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

    return usableDeezerPicture(item) || null;
  } catch (error) {
    console.warn(`Deezer artist image failed for ${artist}: ${error.message}`);
    return null;
  }
}

function usableDeezerPicture(item) {
  const url = item?.picture_xl || item?.picture_big || item?.picture_medium || null;
  if (!url) return null;
  const hash = deezerImageHash(url);
  if (hash && hash.toLowerCase() === DEEZER_EMPTY_IMAGE_HASH) return null;
  return url;
}

// Exact artist by Deezer id — used when the MusicBrainz url-rels give the Deezer
// artist id, so the picture cannot belong to a homonym.
async function fetchDeezerArtistImageById(deezerArtistId) {
  const id = String(deezerArtistId || "").trim();
  if (!/^\d+$/.test(id)) return null;

  try {
    const response = await fetchWithRetry(() =>
      axios.get(`https://api.deezer.com/artist/${id}`, { timeout: REQUEST_TIMEOUT }),
      2,
      500
    );
    return usableDeezerPicture(response.data) || null;
  } catch (error) {
    console.warn(`Deezer artist image failed for id ${id}: ${error.message}`);
    return null;
  }
}

module.exports = { fetchArtistImage: fetchDeezerArtistImage, fetchDeezerArtistImageById };
