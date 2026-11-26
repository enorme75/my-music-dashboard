require("dotenv").config();

const axios = require("axios");
const { version: APP_VERSION } = require("../../package.json");

const { fetchWithRetry } = require("../utils/fetchRetry");
const { ARTIST_COLUMN } = require("../utils/artistName");
const {
  getListenCoverUrl,
  getReleaseCoverUrl,
  getReleaseGroupCoverUrl
} = require("../utils/coverArtArchive");

const REQUEST_TIMEOUT = Math.max(1000, Number(process.env.IMAGE_REQUEST_TIMEOUT_MS || 10000));
const failureTtlMs = Math.max(60000, Number(process.env.IMAGE_FAILURE_CACHE_MS) || 10 * 60 * 1000);

const failedUntil = new Map();

// Cover Art Archive answers 307 (to archive.org) when art exists and 404 when
// it does not; probing avoids caching dead URLs in the album_image column.
async function probeCoverUrl(url) {
  if (!url) return false;

  try {
    await fetchWithRetry(async () => {
      const result = await axios.head(url, {
        timeout: REQUEST_TIMEOUT,
        maxRedirects: 5,
        headers: { "User-Agent": `my-music-dashboard/${APP_VERSION} (+https://github.com/enorme75/my-music-dashboard)` },
        validateStatus: status => status >= 200 && status < 400
      });
      if (result.status >= 400) {
        const error = new Error(`Cover art probe failed (HTTP ${result.status})`);
        error.response = { status: result.status, headers: {} };
        throw error;
      }
      return result;
    }, 1, 500);
    return true;
  } catch {
    return false;
  }
}

async function resolveCoverUrl(url) {
  if (!url) return null;
  if ((failedUntil.get(url) || 0) > Date.now()) return null;
  if (await probeCoverUrl(url)) return url;
  failedUntil.set(url, Date.now() + failureTtlMs);
  return null;
}

// Cover for an album, from the release MBIDs stored with the listens.
async function getStoredAlbumCover(db, artist, album, size = "500") {
  const row = db.prepare(`
    SELECT release_mbid
    FROM scrobbles
    WHERE (${ARTIST_COLUMN} = ? COLLATE NOCASE OR artist = ? COLLATE NOCASE)
      AND album = ? COLLATE NOCASE
      AND release_mbid IS NOT NULL AND TRIM(release_mbid) != ''
    GROUP BY release_mbid
    ORDER BY COUNT(*) DESC
    LIMIT 1
  `).get(artist, artist, album);

  if (!row?.release_mbid) return null;
  return resolveCoverUrl(getReleaseCoverUrl(row.release_mbid, size));
}

module.exports = {
  getListenCoverUrl,
  getReleaseCoverUrl,
  getReleaseGroupCoverUrl,
  getStoredAlbumCover,
  probeCoverUrl,
  resolveCoverUrl
};
