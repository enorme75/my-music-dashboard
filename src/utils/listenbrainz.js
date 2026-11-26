require("dotenv").config();

const axios = require("axios");

const { version: APP_VERSION } = require("../../package.json");
const { fetchWithRetry } = require("./fetchRetry");
const { assertListenBrainzResponse } = require("./listenbrainzResponse");

const API_URL = String(process.env.LISTENBRAINZ_API_URL || "https://api.listenbrainz.org/1")
  .replace(/\/+$/, "");
const REQUEST_TIMEOUT = Math.max(1000, Number(process.env.LISTENBRAINZ_REQUEST_TIMEOUT_MS) || 15000);
const MAX_LISTENS_PER_REQUEST = Math.min(
  1000,
  Math.max(1, Number(process.env.LISTENBRAINZ_MAX_LISTENS_PER_REQUEST) || 1000)
);
const USER_AGENT = String(
  process.env.LISTENBRAINZ_USER_AGENT
    || `my-music-dashboard/${APP_VERSION} (+https://github.com/enorme75/my-music-dashboard)`
);

const STAT_ENTITIES = new Set(["artists", "releases", "recordings"]);
const STAT_KEYS = {
  artists: "artists",
  releases: "releases",
  recordings: "recordings"
};

function getUsername() {
  return String(process.env.LISTENBRAINZ_USERNAME || "").trim();
}

function getUserToken() {
  return String(process.env.LISTENBRAINZ_USER_TOKEN || "").trim();
}

function validateConfiguration() {
  const username = getUsername();
  if (!username) {
    throw new Error("LISTENBRAINZ_USERNAME must be configured");
  }
  return username;
}

function authHeaders(extraToken) {
  const token = extraToken || getUserToken();
  return token ? { Authorization: `Token ${token}` } : {};
}

async function lbGet(path, params = {}, options = {}) {
  const response = await fetchWithRetry(async () => {
    const result = await axios.get(`${API_URL}${path}`, {
      timeout: REQUEST_TIMEOUT,
      headers: {
        "User-Agent": USER_AGENT,
        ...authHeaders(options.token)
      },
      params,
      // Errors are normalized by assertListenBrainzResponse so that LB's
      // {code, error} payloads map onto retryable axios-style errors.
      validateStatus: () => true
    });
    assertListenBrainzResponse(result.status, result.data);
    return result;
  });

  return response.data;
}

function clampCount(count) {
  const parsed = Number(count);
  if (!Number.isInteger(parsed) || parsed <= 0) return MAX_LISTENS_PER_REQUEST;
  return Math.min(parsed, MAX_LISTENS_PER_REQUEST);
}

function userPath(user) {
  return `/user/${encodeURIComponent(String(user).trim())}`;
}

// GET /1/user/{user}/listens?count=&min_ts=&max_ts=
// Returns the raw payload { count, latest_listen_ts, listens: [...] }, newest first.
async function getListens({ user, minTs = 0, maxTs = 0, count = MAX_LISTENS_PER_REQUEST } = {}) {
  const username = String(user || getUsername()).trim();
  if (!username) throw new Error("A ListenBrainz username is required to fetch listens");

  const params = { count: clampCount(count) };
  const min = Number(minTs) || 0;
  const max = Number(maxTs) || 0;
  if (min > 0) params.min_ts = min;
  if (max > 0) params.max_ts = max;

  const data = await lbGet(`${userPath(username)}/listens`, params);
  return data?.payload || { count: 0, listens: [] };
}

// Walks every listen inside [minTs, maxTs], page by page, newest first.
// Used by the sync and by the leaderboards (arbitrary date ranges).
async function getAllListens({ user, minTs = 0, maxTs = 0, delayMs = 0, onPage } = {}) {
  const listens = [];
  let cursorMax = Number(maxTs) || 0;
  let page = 0;
  const spacing = Math.max(0, Number(delayMs) || 0);

  for (;;) {
    page += 1;
    const payload = await getListens({
      user,
      minTs,
      maxTs: cursorMax,
      count: MAX_LISTENS_PER_REQUEST
    });

    const batch = Array.isArray(payload.listens) ? payload.listens : [];
    if (!batch.length) break;

    listens.push(...batch);
    if (onPage) await onPage({ page, batch, total: listens.length });

    if (batch.length < MAX_LISTENS_PER_REQUEST) break;

    const oldest = Math.min(...batch.map(listen => Number(listen?.listened_at) || 0));
    cursorMax = oldest - 1;
    if (cursorMax < (Number(minTs) || 0)) break;

    if (spacing > 0) {
      await new Promise(resolve => setTimeout(resolve, spacing));
    }
  }

  return listens;
}

// GET /1/user/{user}/playing-now
async function getPlayingNow(user) {
  const username = String(user || getUsername()).trim();
  const data = await lbGet(`${userPath(username)}/playing-now`, { count: 1 });
  const listens = Array.isArray(data?.payload?.listens) ? data.payload.listens : [];
  return listens[0] || null;
}

// GET /1/user/{user}/listen-count -> { payload: { count } }
async function getListenCount(user) {
  const username = String(user || getUsername()).trim();
  const data = await lbGet(`${userPath(username)}/listen-count`);
  const count = Number(data?.payload?.count);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error("ListenBrainz returned an invalid listen count");
  }
  return count;
}

// GET /1/validate-token (Authorization: Token <token>) -> { valid, user_name }
async function validateToken(token) {
  const data = await lbGet("/validate-token", {}, { token: String(token || "").trim() });
  return {
    valid: data?.valid === true,
    username: data?.user_name || null
  };
}

// GET /1/user/{user}/following?count=&offset= -> { following: [names], user }
async function getFollowing(user, { count = 100, offset = 0 } = {}) {
  const username = String(user || getUsername()).trim();
  const data = await lbGet(`${userPath(username)}/following`, {
    count: Math.min(100, Math.max(1, Number(count) || 100)),
    offset: Math.max(0, Number(offset) || 0)
  });
  const following = Array.isArray(data?.following) ? data.following : [];
  return following.map(entry => String(typeof entry === "string" ? entry : entry?.user_name || "")).filter(Boolean);
}

// GET /1/stats/user/{user}/{entity}?range=&count= -> payload[entity]
// entity: artists | releases | recordings. Returns null when LB answers 204
// (no statistics for the requested range).
async function getUserStats(user, entity, { range = "all_time", count = 100 } = {}) {
  const username = String(user || getUsername()).trim();
  const statEntity = STAT_KEYS[entity];
  if (!STAT_ENTITIES.has(statEntity)) throw new Error(`Unknown ListenBrainz stats entity: ${entity}`);

  const data = await lbGet(`/stats/user/${encodeURIComponent(username)}/${statEntity}`, {
    range,
    count: Math.min(1000, Math.max(1, Number(count) || 100))
  });

  if (!data?.payload) return { items: [], total: 0, range };
  const items = Array.isArray(data.payload[statEntity]) ? data.payload[statEntity] : [];
  const totalKey = `total_${statEntity.replace(/s$/, "")}_count`;

  return {
    items,
    total: Number(data.payload[totalKey]) || items.length,
    range: data.payload.range || range,
    fromTs: Number(data.payload.from_ts) || null,
    toTs: Number(data.payload.to_ts) || null
  };
}

// Maps a raw LB listen onto the local scrobble shape.
function normalizeListen(listen) {
  const meta = listen?.track_metadata || {};
  const additional = meta.additional_info || {};
  const mapping = meta.mbid_mapping || {};

  const artist = String(meta.artist_name || additional.artist_names?.[0] || "").trim();
  const track = String(meta.track_name || mapping.recording_name || "").trim();
  const album = String(meta.release_name || "").trim() || null;
  const playedAt = Number(listen?.listened_at);

  const durationMs = Number(additional.duration_ms || 0)
    || (Number(additional.duration) > 0 ? Number(additional.duration) * 1000 : 0);

  return {
    artist,
    track,
    album,
    playedAt: Number.isInteger(playedAt) && playedAt > 0 ? playedAt : null,
    duration: durationMs > 0 ? Math.round(durationMs / 1000) : null,
    artistMbid: additional.artist_mbids?.[0] || mapping.artist_mbids?.[0] || null,
    releaseMbid: mapping.caa_release_mbid || additional.release_mbid || mapping.release_mbid || null,
    releaseGroupMbid: additional.release_group_mbid || mapping.release_group_mbid || null,
    recordingMbid: additional.recording_mbid || mapping.recording_mbid || null,
    caaReleaseMbid: mapping.caa_release_mbid || null
  };
}

module.exports = {
  API_URL,
  MAX_LISTENS_PER_REQUEST,
  REQUEST_TIMEOUT,
  USER_AGENT,
  getAllListens,
  getFollowing,
  getListenCount,
  getListens,
  getPlayingNow,
  getUserStats,
  getUserToken,
  getUsername,
  lbGet,
  normalizeListen,
  validateConfiguration,
  validateToken
};
