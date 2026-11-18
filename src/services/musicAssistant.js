const crypto = require("crypto");
const axios = require("axios");
const { fetchWithRetry } = require("../utils/fetchRetry");
const { normalize, isReasonableMatch } = require("../utils/normalizeText");

const DEFAULT_REQUEST_TIMEOUT_MS = 8000;
const DEFAULT_SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_PLAYERS_CACHE_TTL_MS = 60 * 1000;
const MAX_SEARCH_LIMIT = 25;
const MAX_AVAILABILITY_TRACKS = 200;

class MusicAssistantError extends Error {
  constructor(message, code = "ma_error", statusCode = 502) {
    super(message);
    this.name = "MusicAssistantError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function readConfig() {
  return {
    apiUrl: String(process.env.MA_API_URL || "").trim(),
    token: String(process.env.MA_TOKEN || "").trim(),
    defaultQueueId: String(process.env.MA_PLAYER_ID || "").trim(),
    timeoutMs: Number(process.env.MA_REQUEST_TIMEOUT_MS || DEFAULT_REQUEST_TIMEOUT_MS),
    searchCacheTtlMs: Number(process.env.MA_SEARCH_CACHE_TTL_MS || DEFAULT_SEARCH_CACHE_TTL_MS),
    playersCacheTtlMs: Number(process.env.MA_PLAYERS_CACHE_TTL_MS || DEFAULT_PLAYERS_CACHE_TTL_MS)
  };
}

/**
 * Factory so tests can inject a fake httpPost(url, payload, headers).
 * The default instance (bottom of file) uses axios against MA_API_URL.
 */
function createMusicAssistantClient({ httpPost, now = () => Date.now() } = {}) {
  const config = readConfig();
  const searchCache = new Map();
  const playersCache = { value: null, expiresAt: 0 };

  const post = httpPost || (async (url, payload, headers) => {
    const { data } = await fetchWithRetry(
      () => axios.post(url, payload, { timeout: config.timeoutMs, headers }),
      1,
      500
    );
    return data;
  });

  function isConfigured() {
    return Boolean(config.apiUrl && config.token);
  }

  async function maCommand(command, args = {}) {
    if (!isConfigured()) {
      throw new MusicAssistantError(
        "Music Assistant is not configured (set MA_API_URL and MA_TOKEN)",
        "not_configured",
        503
      );
    }

    const messageId = crypto.randomUUID();
    let data;
    try {
      data = await post(config.apiUrl, { message_id: messageId, command, args }, {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json"
      });
    } catch (error) {
      const httpStatus = error.response?.status;
      if (httpStatus) {
        throw new MusicAssistantError(
          `Music Assistant returned HTTP ${httpStatus}`,
          `ma_http_${httpStatus}`,
          502
        );
      }
      throw new MusicAssistantError(
        `Music Assistant request failed: ${error.message}`,
        "ma_unreachable",
        502
      );
    }

    if (data?.error) {
      const maCode = data.error.code ? String(data.error.code) : "ma_error";
      throw new MusicAssistantError(
        String(data.error.message || "Music Assistant error"),
        maCode,
        502
      );
    }

    return data?.result !== undefined ? data.result : data;
  }

  function trackArtists(item) {
    const artists = Array.isArray(item?.artists) ? item.artists : [];
    return artists.map(artist => artist?.name).filter(Boolean);
  }

  function isLibraryTrack(item) {
    const uri = String(item?.uri || "");
    if (uri.startsWith("library://track/")) return true;
    const mappings = Array.isArray(item?.provider_mappings) ? item.provider_mappings : [];
    return mappings.some(mapping =>
      ["library", "builtin"].includes(String(mapping?.provider_instance || mapping?.provider || "").toLowerCase())
    );
  }

  function trackIdFromUri(uri) {
    const match = /^library:\/\/track\/(.+)$/.exec(String(uri || ""));
    return match ? match[1] : null;
  }

  function toTrackMatch(item, fallbackArtist) {
    const uri = String(item.uri || "") || (item.item_id ? `library://track/${item.item_id}` : "");
    const id = item.item_id ?? trackIdFromUri(uri);
    if (!id) return null;
    return {
      id,
      uri: uri || `library://track/${id}`,
      name: String(item.name || item.title || ""),
      artist: trackArtists(item)[0] || fallbackArtist
    };
  }

  async function searchTrack(artist, track) {
    const cacheKey = `${normalize(artist)} ${normalize(track)}`;
    const cached = searchCache.get(cacheKey);
    if (cached && cached.expiresAt > now()) return cached.value;

    const result = await maCommand("music/search", {
      search_query: `${artist} ${track}`,
      limit: MAX_SEARCH_LIMIT
    });
    const items = Array.isArray(result?.tracks) ? result.tracks : [];

    const expectedArtist = normalize(artist);
    const expectedTrack = normalize(track);
    let best = null;
    let bestScore = 0;

    for (const item of items) {
      if (!isLibraryTrack(item)) continue;
      const itemTitle = normalize(item?.name || item?.title || "");
      const itemArtist = normalize(trackArtists(item).join(" "));
      if (!itemTitle || !isReasonableMatch(itemTitle, expectedTrack)) continue;
      if (expectedArtist && itemArtist && !isReasonableMatch(itemArtist, expectedArtist)) continue;

      let score = 0;
      if (itemTitle === expectedTrack) score += 2;
      else score += 1;
      if (itemArtist && itemArtist === expectedArtist) score += 2;
      else if (expectedArtist && itemArtist) score += 1;
      // Prefer the studio edition over live/remaster/deluxe variants.
      if (/\b(live|remaster(?:ed)?|deluxe|edition|version|explicit|clean)\b/i.test(String(item?.name || item?.title || ""))) {
        score -= 1;
      }

      if (score > bestScore) {
        best = item;
        bestScore = score;
      }
    }

    const value = best ? toTrackMatch(best, artist) : null;
    searchCache.set(cacheKey, { value, expiresAt: now() + config.searchCacheTtlMs });
    return value;
  }

  async function listPlayers() {
    if (playersCache.value && playersCache.expiresAt > now()) return playersCache.value;

    const result = await maCommand("player_queues/all", {});
    const queues = Array.isArray(result) ? result : (Array.isArray(result?.queues) ? result.queues : []);
    const players = queues
      .map(queue => ({
        queue_id: String(queue?.queue_id || queue?.player_id || ""),
        name: String(queue?.display_name || queue?.name || queue?.queue_id || queue?.player_id || ""),
        active: Boolean(queue?.active)
      }))
      .filter(player => player.queue_id);

    playersCache.value = players;
    playersCache.expiresAt = now() + config.playersCacheTtlMs;
    return players;
  }

  async function playTrack(queueId, trackUri) {
    await maCommand("player_queues/play_media", {
      queue_id: queueId,
      media: trackUri
    });
    return true;
  }

  function resolveQueueId(queueId) {
    const resolved = String(queueId || "").trim() || config.defaultQueueId;
    if (!resolved) {
      throw new MusicAssistantError(
        "No Music Assistant player selected (queue_id required)",
        "queue_required",
        400
      );
    }
    return resolved;
  }

  async function checkAvailability(tracks) {
    const limited = tracks.slice(0, MAX_AVAILABILITY_TRACKS);
    const results = {};
    await Promise.all(limited.map(async ({ artist, track }) => {
      const key = `${artist} ${track}`;
      try {
        results[key] = Boolean(await searchTrack(artist, track));
      } catch {
        results[key] = false;
      }
    }));
    return results;
  }

  async function getStatus() {
    if (!isConfigured()) {
      return { configured: false, players: [], defaultQueueId: null };
    }
    let players = [];
    try {
      players = await listPlayers();
    } catch {
      players = [];
    }
    return {
      configured: true,
      players,
      defaultQueueId: config.defaultQueueId || null
    };
  }

  return {
    isConfigured,
    maCommand,
    searchTrack,
    listPlayers,
    playTrack,
    resolveQueueId,
    checkAvailability,
    getStatus
  };
}

const defaultClient = createMusicAssistantClient();

module.exports = {
  createMusicAssistantClient,
  MusicAssistantError,
  isConfigured: () => defaultClient.isConfigured(),
  getStatus: () => defaultClient.getStatus(),
  searchTrack: (artist, track) => defaultClient.searchTrack(artist, track),
  listPlayers: () => defaultClient.listPlayers(),
  playTrack: (queueId, uri) => defaultClient.playTrack(queueId, uri),
  resolveQueueId: queueId => defaultClient.resolveQueueId(queueId),
  checkAvailability: tracks => defaultClient.checkAvailability(tracks)
};
