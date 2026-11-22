const db = require("../db");
const { mapWithConcurrency } = require("../utils/mapWithConcurrency");
const { getAlbumUrl, getTrackUrl, getArtistUrl } = require("../utils/listenbrainzUrl");
const { ensureArtistImage, getCachedArtistImage } = require("./artistImageCache");
const { ensureAlbumCover, getCachedAlbumCover } = require("./albumCoverCache");
const { ensureArtistInfo, getCachedArtistBio } = require("./artistInfoCache");
const { ensureAlbumYear, getCachedAlbumYear } = require("./albumYearCache");
const { ensureDiscogsArtistLink, getCachedDiscogsLink } = require("./discogsCache");
const { getReleaseCoverUrl } = require("../utils/coverArtArchive");
const { peekDashboardCache, setDashboardCacheEntry } = require("./dashboardCache");

const EXTERNAL_REQUEST_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.EXTERNAL_REQUEST_CONCURRENCY || "4", 10) || 4
);

const getArtistStats = db.prepare(`
  SELECT
    COUNT(*) AS plays,
    MIN(played_at) AS firstPlay,
    MAX(played_at) AS lastPlay,
    COUNT(DISTINCT track) AS uniqueTracks,
    COUNT(DISTINCT NULLIF(TRIM(album), '')) AS uniqueAlbums,
    MAX(artist_mbid) AS artist_mbid
  FROM scrobbles
  WHERE artist = ? COLLATE NOCASE
`);

const getArtistTopTracks = db.prepare(`
  SELECT
    track,
    COUNT(*) AS plays,
    MAX(recording_mbid) AS recording_mbid
  FROM scrobbles
  WHERE artist = ? COLLATE NOCASE
  GROUP BY track
  ORDER BY plays DESC
  LIMIT 10
`);

const getArtistAlbums = db.prepare(`
  SELECT
    album,
    MAX(NULLIF(album_image, '')) AS album_image,
    MAX(release_mbid) AS release_mbid,
    COUNT(*) AS plays,
    MIN(played_at) AS firstPlay
  FROM scrobbles
  WHERE artist = ? COLLATE NOCASE
    AND album IS NOT NULL
    AND TRIM(album) != ''
  GROUP BY album
  ORDER BY plays DESC
  LIMIT 24
`);

async function buildArtistPage(artist, lang) {
  const stats = getArtistStats.get(artist);
  if (!stats || stats.plays === 0) return null;

  const topTracks = getArtistTopTracks.all(artist);
  const albums = getArtistAlbums.all(artist);

  const [image, info, discogs, enrichedAlbums] = await Promise.all([
    ensureArtistImage(artist).catch(() => null),
    ensureArtistInfo(artist, lang).catch(() => null),
    ensureDiscogsArtistLink(artist).catch(() => null),
    mapWithConcurrency(albums, EXTERNAL_REQUEST_CONCURRENCY, async row => {
      const [cover, year] = await Promise.all([
        ensureAlbumCover(artist, row.album).catch(() => null),
        ensureAlbumYear(artist, row.album)
      ]);

      return {
        album: row.album,
        plays: row.plays,
        firstPlay: row.firstPlay,
        image: cover || row.album_image || null,
        year
      };
    })
  ]);

  return {
    artist,
    plays: stats.plays,
    firstPlay: stats.firstPlay,
    lastPlay: stats.lastPlay,
    uniqueTracks: stats.uniqueTracks,
    uniqueAlbums: stats.uniqueAlbums,
    image: image || info?.image || null,
    bio: info?.bio || null,
    listenbrainzUrl: info?.listenbrainzUrl || getArtistUrl(artist, stats.artist_mbid),
    discogsUrl: discogs?.url || null,
    members: discogs?.members || null,
    topTracks: topTracks.map(row => ({
      track: row.track,
      plays: row.plays,
      url: getTrackUrl(artist, row.track, row.recording_mbid)
    })),
    albums: enrichedAlbums.map(row => ({
      ...row,
      url: getAlbumUrl(artist, row.album, row.release_mbid)
    }))
  };
}

// Fast path: build the page from the local DB + already-cached metadata only
// (no network). Album covers fall back to the Cover Art Archive URL built from
// the release MBID stored with the listens, so no MusicBrainz call is needed.
function buildFastArtistPage(artist, lang) {
  const stats = getArtistStats.get(artist);
  if (!stats || stats.plays === 0) return null;

  const topTracks = getArtistTopTracks.all(artist);
  const albums = getArtistAlbums.all(artist);
  const info = getCachedArtistBio(artist);
  const image = getCachedArtistImage(artist);
  const discogs = getCachedDiscogsLink("artist", artist, null);

  let enriching = !image || !info?.bio;
  const enrichedAlbums = albums.map(row => {
    const cachedCover = getCachedAlbumCover(artist, row.album);
    const year = getCachedAlbumYear(artist, row.album);
    if (!cachedCover || !year) enriching = true;

    return {
      album: row.album,
      plays: row.plays,
      firstPlay: row.firstPlay,
      image: cachedCover || getReleaseCoverUrl(row.release_mbid, "500"),
      year,
      url: getAlbumUrl(artist, row.album, row.release_mbid)
    };
  });

  return {
    artist,
    plays: stats.plays,
    firstPlay: stats.firstPlay,
    lastPlay: stats.lastPlay,
    uniqueTracks: stats.uniqueTracks,
    uniqueAlbums: stats.uniqueAlbums,
    image,
    bio: info?.bio || null,
    listenbrainzUrl: info?.listenbrainzUrl || getArtistUrl(artist, stats.artist_mbid),
    discogsUrl: discogs?.url || null,
    members: discogs?.members || null,
    topTracks: topTracks.map(row => ({
      track: row.track,
      plays: row.plays,
      url: getTrackUrl(artist, row.track, row.recording_mbid)
    })),
    albums: enrichedAlbums,
    enriching
  };
}

// Full build with metadata lookups (MusicBrainz queue, Wikipedia, Discogs,
// Cover Art Archive) — run in the background, its result is what gets cached.
const backgroundBuilds = new Map();

async function getArtistPage(name, { lang = "en" } = {}) {
  const artist = String(name || "").trim();
  if (!artist) return null;

  const cacheKey = `artist:${artist.toLocaleLowerCase()}:lang:${lang}`;

  const cached = peekDashboardCache(cacheKey);
  if (cached) {
    return { ...cached.data, enriching: false, cache: cached.cache };
  }

  // No cached page: answer immediately with the DB-only page and kick off
  // the enriched build in the background; it lands in the page cache and the
  // frontend picks it up by polling while `enriching` is true.
  const fast = buildFastArtistPage(artist, lang);
  if (!fast) return null;

  if (!backgroundBuilds.has(cacheKey)) {
    const build = buildArtistPage(artist, lang)
      .then(data => {
        if (data) setDashboardCacheEntry(cacheKey, { ...data, enriching: false });
      })
      .catch(error => {
        console.warn(`[artistPage] background enrichment failed for "${artist}":`, error.message || error);
      })
      .finally(() => backgroundBuilds.delete(cacheKey));
    backgroundBuilds.set(cacheKey, build);
  }

  return { ...fast, cache: { hit: false, enriching: true } };
}

module.exports = { getArtistPage };
