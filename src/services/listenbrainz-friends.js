require("dotenv").config();

const {
  getFollowing,
  getListenCount,
  getUserStats,
  getUsername
} = require("../utils/listenbrainz");
const { getUserUrl } = require("../utils/listenbrainzUrl");
const { ARTIST_COLUMN, mainArtist } = require("../utils/artistName");
const { getReleaseCoverUrl } = require("../utils/coverArtArchive");
const {
  ensureAlbumCover,
  getCachedAlbumCover,
  rememberAlbumCover
} = require("./albumCoverCache");
const {
  ensureArtistImage,
  getCachedArtistImage,
  rememberArtistImage
} = require("./artistImageCache");
const {
  ensureTrackCover,
  getCachedTrackCover,
  rememberTrackCover
} = require("./trackCoverCache");
const { toImageProxyUrl } = require("./remoteImageCache");
const { isUsableImageUrl, normalizeImageUrl } = require("../utils/imageUrl");
const { mapWithConcurrency } = require("../utils/mapWithConcurrency");
const { sanitizeError } = require("../utils/sanitizeAxios");

const MAIN_USER = getUsername();
const AVATAR_PLACEHOLDER = "/images/artist-placeholder.png";
const COVER_PLACEHOLDER = "/images/cover-placeholder.svg";
const IMAGE_CONCURRENCY = Math.max(1, Number(process.env.EXTERNAL_REQUEST_CONCURRENCY || 4));
const FRIENDS_CACHE_TTL_MS = Math.max(30000, Number(process.env.FRIENDS_CACHE_TTL_MS) || 5 * 60 * 1000);
const STATS_COUNT = 50;

const normalizeKey = value => String(value || "").trim().toLocaleLowerCase();
const compoundKey = (name, artist) => `${normalizeKey(name)}\u0000${normalizeKey(artist)}`;

let friendsCache = null;
let friendsCacheExpiresAt = 0;
let friendsInFlight = null;

// ListenBrainz has no mutual "friends": the closest concept is the list of
// users you follow. Each entry gets its listen count for display.
async function fetchFriendsList(limit) {
  const following = await getFollowing(MAIN_USER, { count: 100 });
  const names = following.slice(0, Math.max(1, Number(limit) || 50));

  const friends = await mapWithConcurrency(names, IMAGE_CONCURRENCY, async name => {
    let playcount = 0;
    try {
      playcount = await getListenCount(name);
    } catch (error) {
      console.warn(`Could not fetch listen count for ${name}:`, error.message);
    }

    return {
      name,
      realname: null,
      avatar: AVATAR_PLACEHOLDER,
      playcount,
      url: getUserUrl(name)
    };
  });

  return friends.filter(friend => friend.name);
}

async function getFriendsList(limit = 50) {
  if (friendsCache && friendsCacheExpiresAt > Date.now()) return friendsCache;
  if (friendsInFlight) return friendsInFlight;

  friendsInFlight = fetchFriendsList(limit)
    .then(friends => {
      friendsCache = friends;
      friendsCacheExpiresAt = Date.now() + FRIENDS_CACHE_TTL_MS;
      return friends;
    })
    .finally(() => {
      friendsInFlight = null;
    });

  return friendsInFlight;
}

async function findBestImage(type, name, artistName, apiImage) {
  try {
    const directImage = isUsableImageUrl(normalizeImageUrl(apiImage)) ? normalizeImageUrl(apiImage) : null;

    if (type === "artist") {
      const cached = getCachedArtistImage(name);
      if (cached) return cached;
      if (directImage) return rememberArtistImage(name, directImage) || directImage;
      return await ensureArtistImage(name) || COVER_PLACEHOLDER;
    }

    if (type === "album") {
      const cached = getCachedAlbumCover(artistName, name);
      if (cached) return cached;
      if (directImage) return rememberAlbumCover(artistName, name, directImage) || directImage;
      return await ensureAlbumCover(artistName, name) || COVER_PLACEHOLDER;
    }

    const cached = getCachedTrackCover(artistName, name);
    if (cached.image) return cached.image;
    if (directImage) {
      return rememberTrackCover(artistName, name, cached.album, directImage) || directImage;
    }

    return await ensureTrackCover(artistName, name) || COVER_PLACEHOLDER;
  } catch (error) {
    console.warn(`Image lookup failed (${type}: ${name}):`, error.message);
    return COVER_PLACEHOLDER;
  }
}

function calculateCompatibilityScore(commonArtists, commonAlbums, commonTracks) {
  const artistScore = Math.min(50, (commonArtists.length / 10) * 50);
  const albumScore = Math.min(30, (commonAlbums.length / 5) * 30);
  const trackScore = Math.min(20, (commonTracks.length / 5) * 20);
  const bonus = commonArtists.length > 20 ? 5 : 0;

  return Math.round(Math.min(100, artistScore + albumScore + trackScore + bonus));
}

function getLocalListeningMaps(db) {
  const artists = db.prepare(`
    SELECT ${ARTIST_COLUMN} AS artist, COUNT(*) AS plays
    FROM scrobbles
    GROUP BY ${ARTIST_COLUMN}
  `).all();

  const albums = db.prepare(`
    SELECT album, ${ARTIST_COLUMN} AS artist, COUNT(*) AS plays
    FROM scrobbles
    WHERE album IS NOT NULL AND TRIM(album) != ''
    GROUP BY album, ${ARTIST_COLUMN}
  `).all();

  const tracks = db.prepare(`
    SELECT track, ${ARTIST_COLUMN} AS artist, COUNT(*) AS plays
    FROM scrobbles
    GROUP BY track, ${ARTIST_COLUMN}
  `).all();

  const accumulate = (rows, getKey) => {
    const result = new Map();

    for (const item of rows) {
      const key = getKey(item);
      result.set(key, (result.get(key) || 0) + Number(item.plays || 0));
    }

    return result;
  };

  return {
    artists: accumulate(artists, item => normalizeKey(item.artist)),
    albums: accumulate(albums, item => compoundKey(item.album, item.artist)),
    tracks: accumulate(tracks, item => compoundKey(item.track, item.artist))
  };
}

// Maps ListenBrainz stats payloads onto the shapes used by the comparison UI.
function mapStatsArtists(payload) {
  return (payload?.items || []).map(item => ({
    name: mainArtist(String(item.artist_name || "").trim()),
    playcount: String(item.listen_count ?? 0),
    mbid: item.artist_mbid || null,
    image: null
  })).filter(item => item.name);
}

function mapStatsReleases(payload) {
  return (payload?.items || []).map(item => ({
    name: String(item.release_name || "").trim(),
    artist: mainArtist(String(item.artist_name || "").trim()),
    playcount: String(item.listen_count ?? 0),
    mbid: item.release_mbid || null,
    image: getReleaseCoverUrl(item.caa_release_mbid || item.release_mbid, "500")
  })).filter(item => item.name && item.artist);
}

function mapStatsRecordings(payload) {
  return (payload?.items || []).map(item => ({
    name: String(item.track_name || "").trim(),
    artist: mainArtist(String(item.artist_name || "").trim()),
    playcount: String(item.listen_count ?? 0),
    mbid: item.recording_mbid || null,
    image: getReleaseCoverUrl(item.caa_release_mbid || item.release_mbid, "500")
  })).filter(item => item.name && item.artist);
}

async function resolveCommonImages(rawCommonArtists, rawCommonAlbums, rawCommonTracks) {
  const tasks = [
    ...rawCommonArtists.slice(0, 5).map(item => ({ type: "artist", item })),
    ...rawCommonAlbums.slice(0, 5).map(item => ({ type: "album", item })),
    ...rawCommonTracks.slice(0, 5).map(item => ({ type: "track", item }))
  ];

  const resolved = await mapWithConcurrency(tasks, IMAGE_CONCURRENCY, async task => {
    const { type, item } = task;
    const artist = type === "artist" ? null : item.source.artist;

    return {
      type,
      value: {
        name: item.source.name,
        ...(artist ? { artist } : {}),
        myPlays: item.myPlays,
        friendPlays: Number.parseInt(item.source.playcount || "0", 10),
        image: toImageProxyUrl(await findBestImage(type, item.source.name, artist, item.source.image))
      }
    };
  });

  return {
    commonArtists: resolved.filter(item => item.type === "artist").map(item => item.value),
    commonAlbums: resolved.filter(item => item.type === "album").map(item => item.value),
    commonTracks: resolved.filter(item => item.type === "track").map(item => item.value)
  };
}

async function compareWithFriend(db, friendUsername) {
  try {
    const user = String(friendUsername || "").trim();
    if (!user) return { error: true, message: "Invalid ListenBrainz username." };

    const [listenCount, artistsStats, releasesStats, recordingsStats] = await Promise.all([
      getListenCount(user).catch(() => null),
      getUserStats(user, "artists", { range: "all_time", count: STATS_COUNT }).catch(() => null),
      getUserStats(user, "releases", { range: "all_time", count: STATS_COUNT }).catch(() => null),
      getUserStats(user, "recordings", { range: "all_time", count: STATS_COUNT }).catch(() => null)
    ]);

    if (listenCount === null && !artistsStats && !releasesStats && !recordingsStats) {
      return { error: true, message: "ListenBrainz user not found." };
    }

    const friendArtists = mapStatsArtists(artistsStats);
    const friendAlbums = mapStatsReleases(releasesStats);
    const friendTracks = mapStatsRecordings(recordingsStats);
    const localMaps = getLocalListeningMaps(db);

    const rawCommonArtists = friendArtists
      .map(item => ({
        source: item,
        myPlays: localMaps.artists.get(normalizeKey(item.name)) || 0
      }))
      .filter(item => item.myPlays > 0)
      .sort((a, b) => b.myPlays - a.myPlays);

    const rawCommonAlbums = friendAlbums
      .map(item => ({
        source: item,
        myPlays: localMaps.albums.get(compoundKey(item.name, item.artist)) || 0
      }))
      .filter(item => item.myPlays > 0)
      .sort((a, b) => b.myPlays - a.myPlays);

    const rawCommonTracks = friendTracks
      .map(item => ({
        source: item,
        myPlays: localMaps.tracks.get(compoundKey(item.name, item.artist)) || 0
      }))
      .filter(item => item.myPlays > 0)
      .sort((a, b) => b.myPlays - a.myPlays);

    const { commonArtists, commonAlbums, commonTracks } = await resolveCommonImages(
      rawCommonArtists,
      rawCommonAlbums,
      rawCommonTracks
    );

    const myStats = db.prepare(`
      SELECT
        COUNT(*) AS scrobbles,
        (
          SELECT COUNT(*)
          FROM (
            SELECT ${ARTIST_COLUMN}, album
            FROM scrobbles
            WHERE album IS NOT NULL AND TRIM(album) != ''
            GROUP BY ${ARTIST_COLUMN}, album
          )
        ) AS albumsCount,
        (
          SELECT COUNT(DISTINCT ${ARTIST_COLUMN})
          FROM scrobbles
        ) AS artistsCount
      FROM scrobbles
    `).get();

    return {
      user: {
        username: "You",
        scrobbles: myStats.scrobbles,
        albumsCount: myStats.albumsCount,
        artistsCount: myStats.artistsCount
      },
      friend: {
        username: user,
        avatar: AVATAR_PLACEHOLDER,
        scrobbles: listenCount ?? 0,
        albumsCount: releasesStats?.total ?? friendAlbums.length,
        artistsCount: artistsStats?.total ?? friendArtists.length,
        url: getUserUrl(user)
      },
      compatibilityScore: calculateCompatibilityScore(
        rawCommonArtists,
        rawCommonAlbums,
        rawCommonTracks
      ),
      commonArtists,
      commonAlbums,
      commonTracks
    };
  } catch (error) {
    console.error("compareWithFriend error:", sanitizeError(error));
    return { error: true, message: "Error comparing profiles. Please try again." };
  }
}

module.exports = { getFriendsList, compareWithFriend };
