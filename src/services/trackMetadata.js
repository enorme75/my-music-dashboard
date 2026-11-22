require("dotenv").config();

const { findRecording } = require("./musicbrainz");
const { getReleaseCoverUrl } = require("../utils/coverArtArchive");
const { resolveCoverUrl } = require("./coverArtLookup");
const { sanitizeError } = require("../utils/sanitizeAxios");

const RESPONSE_CACHE_TTL_MS = 60 * 1000;

const responseCache = new Map();
const inFlight = new Map();

const requestKey = (artist, track) => (
  `${String(artist || "").trim().toLocaleLowerCase()}\u0000${String(track || "").trim().toLocaleLowerCase()}`
);

// Track info from MusicBrainz: duration, release (album) and cover via the
// Cover Art Archive. Deezer remains the fallback in trackCoverCache.
async function fetchTrackInfo(artist, track) {
  const recording = await findRecording(artist, track);
  if (!recording) return null;

  let image = null;
  if (recording.releaseMbid) {
    image = await resolveCoverUrl(getReleaseCoverUrl(recording.releaseMbid, "500"));
  }

  return {
    mbid: recording.mbid,
    duration: recording.duration,
    album: recording.releaseTitle,
    releaseMbid: recording.releaseMbid,
    image
  };
}

async function getTrackInfo(artist, track) {
  if (!artist || !track) return null;

  const key = requestKey(artist, track);
  const cached = responseCache.get(key);
  if (cached?.expiresAt > Date.now()) return cached.value;
  if (inFlight.has(key)) return inFlight.get(key);

  const request = fetchTrackInfo(artist, track)
    .then(value => {
      responseCache.set(key, {
        value,
        expiresAt: Date.now() + RESPONSE_CACHE_TTL_MS
      });
      return value;
    })
    .catch(error => {
      console.warn(`⚠️ [MusicBrainz] Track info failed: ${artist} - ${track}`, sanitizeError(error));
      return null;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, request);
  return request;
}

async function getTrackDuration(artist, track) {
  const info = await getTrackInfo(artist, track);
  const duration = Number(info?.duration);
  if (!Number.isInteger(duration) || duration <= 0) return null;
  return duration;
}

async function getTrackCoverInfo(artist, track) {
  const info = await getTrackInfo(artist, track);
  if (!info) return { album: null, image: null };

  return {
    album: String(info.album || "").trim() || null,
    image: info.image || null
  };
}

module.exports = { getTrackCoverInfo, getTrackDuration, getTrackInfo };
