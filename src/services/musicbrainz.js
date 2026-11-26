require("dotenv").config();

const axios = require("axios");

const { version: APP_VERSION } = require("../../package.json");
const { fetchWithRetry } = require("../utils/fetchRetry");
const {
  artistCreditNameOf,
  pickMbArtist,
  pickMbRecording,
  pickMbReleaseGroup
} = require("../utils/matchCandidates");

// MusicBrainz requires a descriptive User-Agent and at most 1 request/second,
// so every call goes through a serialized queue with a minimum spacing.
const MB_URL = String(process.env.MUSICBRAINZ_API_URL || "https://musicbrainz.org/ws/2").replace(/\/+$/, "");
const USER_AGENT = String(
  process.env.MUSICBRAINZ_USER_AGENT
    || `your_lastfm/${APP_VERSION} (+https://github.com/Gomaink/your_lastfm)`
);
const REQUEST_TIMEOUT = Math.max(1000, Number(process.env.IMAGE_REQUEST_TIMEOUT_MS || 10000));
const MIN_REQUEST_SPACING_MS = Math.max(0, Number(process.env.MUSICBRAINZ_REQUEST_DELAY_MS || 1100));

let queueTail = Promise.resolve();
let lastRequestAt = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function mbGet(path, params = {}) {
  const run = async () => {
    const wait = Math.max(0, lastRequestAt + MIN_REQUEST_SPACING_MS - Date.now());
    if (wait > 0) await sleep(wait);

    return fetchWithRetry(async () => {
      lastRequestAt = Date.now();
      const result = await axios.get(`${MB_URL}${path}`, {
        timeout: REQUEST_TIMEOUT,
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        params: { fmt: "json", ...params }
      });
      return result.data;
    }, 5, 1000);
  };

  const request = queueTail.then(run, run);
  queueTail = request.catch(() => {});
  return request;
}

function escapeLucene(value) {
  return String(value || "").replace(/["\\]/g, " ");
}

function quotedField(field, value) {
  return `${field}:"${escapeLucene(value)}"`;
}

async function findArtist(artist) {
  const name = String(artist || "").trim();
  if (!name) return null;

  const data = await mbGet("/artist/", { query: quotedField("artist", name), limit: 10 });
  const artists = Array.isArray(data?.artists) ? data.artists : [];
  // No blind first-hit fallback: only a name-verified match is accepted.
  const match = pickMbArtist(artists, name);

  if (!match?.item?.id) return null;
  return { mbid: match.item.id, name: match.item.name || name };
}

async function getArtistDetails(mbid) {
  if (!mbid) return null;
  const data = await mbGet(`/artist/${encodeURIComponent(mbid)}`, { inc: "annotation+url-rels+aliases" });
  return {
    mbid: data?.id || mbid,
    name: data?.name || null,
    annotation: data?.annotation || null
  };
}

async function findReleaseGroup(artist, album) {
  const artistName = String(artist || "").trim();
  const albumName = String(album || "").trim();
  if (!artistName || !albumName) return null;

  const query = `${quotedField("artist", artistName)} AND ${quotedField("releasegroup", albumName)}`;
  const data = await mbGet("/release-group/", { query, limit: 10 });
  const groups = Array.isArray(data?.["release-groups"]) ? data["release-groups"] : [];
  // Verified pick: artist-credit must match and the title must match; no
  // blind first-hit fallback (it produced covers of the wrong album).
  const match = pickMbReleaseGroup(groups, artistName, albumName);

  if (!match?.item?.id) return null;
  const group = match.item;
  return {
    mbid: group.id,
    title: group.title || albumName,
    primaryType: group["primary-type"] || null,
    firstReleaseDate: group["first-release-date"] || null
  };
}

// All recordings of every release in a release-group, flattened.
async function getReleaseGroupTracks(releaseGroupMbid) {
  if (!releaseGroupMbid) return [];

  const data = await mbGet("/release/", {
    "release-group": releaseGroupMbid,
    inc: "recordings",
    limit: 100
  });

  const releases = Array.isArray(data?.releases) ? data.releases : [];
  const tracks = [];

  for (const release of releases) {
    const releaseArtist = artistCreditNameOf(release);
    const media = Array.isArray(release?.media) ? release.media : [];

    for (const medium of media) {
      const mediumTracks = Array.isArray(medium?.tracks) ? medium.tracks : [];
      for (const track of mediumTracks) {
        const title = String(track?.title || "").trim();
        if (!title) continue;

        const lengthMs = Number(track?.length || track?.recording?.length || 0);
        tracks.push({
          name: title,
          artist: releaseArtist || null,
          duration: lengthMs > 0 ? Math.round(lengthMs / 1000) : null,
          position: track?.position ?? null,
          recordingMbid: track?.recording?.id || null,
          releaseMbid: release?.id || null,
          releaseTitle: release?.title || null
        });
      }
    }
  }

  return tracks;
}

async function findRecording(artist, track) {
  const artistName = String(artist || "").trim();
  const trackName = String(track || "").trim();
  if (!artistName || !trackName) return null;

  const query = `${quotedField("recording", trackName)} AND ${quotedField("artist", artistName)}`;
  const data = await mbGet("/recording/", { query, inc: "releases", limit: 10 });
  const recordings = Array.isArray(data?.recordings) ? data.recordings : [];
  // Verified pick on artist-credit + title, no blind first-hit fallback.
  const match = pickMbRecording(recordings, artistName, trackName);

  if (!match?.item?.id) return null;
  const recording = match.item;

  const release = Array.isArray(recording?.releases) ? recording.releases[0] : null;
  const lengthMs = Number(recording?.length || 0);

  return {
    mbid: recording.id,
    title: recording.title || trackName,
    duration: lengthMs > 0 ? Math.round(lengthMs / 1000) : null,
    releaseMbid: release?.id || null,
    releaseTitle: release?.title || null
  };
}

module.exports = {
  findArtist,
  findRecording,
  findReleaseGroup,
  getArtistDetails,
  getReleaseGroupTracks,
  mbGet
};
