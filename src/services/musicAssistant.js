const crypto = require("crypto");
const axios = require("axios");
const { fetchWithRetry } = require("../utils/fetchRetry");
const { normalize, isReasonableMatch } = require("../utils/normalizeText");

const DEFAULT_REQUEST_TIMEOUT_MS = 8000;
const DEFAULT_SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_PLAYERS_CACHE_TTL_MS = 60 * 1000;
const MAX_SEARCH_LIMIT = 50;
const MAX_AVAILABILITY_TRACKS = 200;
// Default player when the browser has not chosen one. Resolved against the MA
// player list by queue_id first, then by (case-insensitive) name.
const DEFAULT_PLAYER_NAME = "Squeezelite-MacBook";

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
    defaultPlayer: "MA_DEFAULT_PLAYER" in process.env
      ? String(process.env.MA_DEFAULT_PLAYER || "").trim()
      : DEFAULT_PLAYER_NAME,
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
    if (String(item?.provider || "").toLowerCase() === "library") return true;
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

  function isPlayable(item) {
    return item?.is_playable !== false;
  }

  function toTrackMatch(item, fallbackArtist) {
    const rawProvider = String(item.provider || "");
    const provider = rawProvider.toLowerCase();
    const uri = String(item.uri || "") || (provider === "library" && item.item_id ? `library://track/${item.item_id}` : "");
    const id = item.item_id ?? trackIdFromUri(uri) ?? (uri ? uri.split("://")[1] : null);
    if (!id || !uri) return null;
    const source = provider === "library" || uri.startsWith("library://") ? "library" : (rawProvider || uri.split("://")[0]);
    return {
      id,
      uri,
      name: String(item.name || item.title || ""),
      artist: trackArtists(item)[0] || fallbackArtist,
      source
    };
  }

  function matchesQuery(item, expectedArtist, expectedTrack) {
    const itemTitle = normalize(item?.name || item?.title || "");
    const itemArtist = normalize(trackArtists(item).join(" "));
    if (!itemTitle || !isReasonableMatch(itemTitle, expectedTrack)) return false;
    if (expectedArtist && itemArtist && !isReasonableMatch(itemArtist, expectedArtist)) return false;
    return true;
  }

  // External providers (Deezer/Bandcamp) answer fuzzy lookups with unrelated
  // tracks, so require both a real title match and a real artist match there.
  // Local library items keep the more lenient matchesQuery.
  function matchesExternal(item, expectedArtist, expectedTrack) {
    const itemTitle = normalize(item?.name || item?.title || "");
    const itemArtist = normalize(trackArtists(item).join(" "));
    if (!itemTitle || !itemArtist || !expectedArtist) return false;
    const titleOk = itemTitle === expectedTrack
      || (itemTitle.length >= 4 && (itemTitle.includes(expectedTrack) || expectedTrack.includes(itemTitle)));
    return titleOk && isReasonableMatch(itemArtist, expectedArtist);
  }

  function scoreItem(item, expectedArtist, expectedTrack) {
    const itemTitle = normalize(item?.name || item?.title || "");
    const itemArtist = normalize(trackArtists(item).join(" "));
    let score = 0;
    if (itemTitle === expectedTrack) score += 2;
    else score += 1;
    if (itemArtist && itemArtist === expectedArtist) score += 2;
    else if (expectedArtist && itemArtist) score += 1;
    // Prefer the studio edition over live/remaster/deluxe variants.
    if (/\b(live|remaster(?:ed)?|deluxe|edition|version|explicit|clean)\b/i.test(String(item?.name || item?.title || ""))) {
      score -= 1;
    }
    return score;
  }

  async function searchTrack(artist, track) {
    const cacheKey = `${normalize(artist)} ${normalize(track)}`;
    const cached = searchCache.get(cacheKey);
    if (cached && cached.expiresAt > now()) return cached.value;

    const expectedArtist = normalize(artist);
    const expectedTrack = normalize(track);
    let bestLocal = null;
    let bestExternal = null;

    // Local library copies always win; external providers (Deezer, Bandcamp…)
    // are only a fallback when no local copy exists.
    const consider = item => {
      if (!item) return;
      if (isLibraryTrack(item)) {
        if (!matchesQuery(item, expectedArtist, expectedTrack)) return;
        const score = scoreItem(item, expectedArtist, expectedTrack);
        if (!bestLocal || score > bestLocal.score) bestLocal = { item, score };
      } else if (isPlayable(item)) {
        if (!matchesExternal(item, expectedArtist, expectedTrack)) return;
        const score = scoreItem(item, expectedArtist, expectedTrack);
        // External fallback: streaming providers (Deezer) beat purchase/preview
        // ones (Bandcamp) at equal score, because playback is full-length.
        const provider = String(item.provider || "").toLowerCase();
        const externalScore = score - 1 + (provider.startsWith("deezer") ? 0 : -0.5);
        if (!bestExternal || externalScore > bestExternal.score) bestExternal = { item, score: externalScore };
      }
    };

    // 1) Direct lookup by name. MA may answer with an external provider
    //    even when a local copy exists, so keep looking for a local match.
    try {
      consider(await maCommand("music/item_by_name", { name: track, artist }));
    } catch {
      // item_by_name unavailable or no usable match: fall through
    }

    // 1b) Retry with the base title (Last.fm titles often carry suffixes
    //     like " - Reprise" or "(Live at ...)" that MA does not know).
    if (!bestLocal) {
      const baseTitle = String(track).split(/\s+[–—(-]/)[0].trim();
      if (baseTitle && baseTitle !== track) {
        try {
          consider(await maCommand("music/item_by_name", { name: baseTitle, artist }));
        } catch {
          // ignore: fall through to search
        }
      }
    }

    // 2) Fallback: global search across all providers.
    if (!bestLocal) {
      const result = await maCommand("music/search", {
        search_query: `${artist} ${track}`,
        limit: MAX_SEARCH_LIMIT
      });
      const items = Array.isArray(result?.tracks) ? result.tracks : [];
      for (const item of items) consider(item);
    }

    const best = bestLocal || bestExternal;
    const value = best ? toTrackMatch(best.item, artist) : null;
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

  async function resolveQueueId(queueId) {
    const direct = String(queueId || "").trim() || config.defaultQueueId;
    if (direct) return direct;

    if (config.defaultPlayer) {
      try {
        const players = await listPlayers();
        const byId = players.find(player => player.queue_id === config.defaultPlayer);
        if (byId) return byId.queue_id;
        const byName = players.find(player =>
          player.name.toLowerCase() === config.defaultPlayer.toLowerCase()
        );
        if (byName) return byName.queue_id;
      } catch {
        // player list unavailable: pass the configured value through as-is
      }
      return config.defaultPlayer;
    }

    throw new MusicAssistantError(
      "No Music Assistant player selected (queue_id required)",
      "queue_required",
      400
    );
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
      return { configured: false, players: [], defaultQueueId: null, defaultPlayerName: config.defaultPlayer || null };
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
      defaultQueueId: await resolveQueueId(""),
      defaultPlayerName: config.defaultPlayer || null
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
