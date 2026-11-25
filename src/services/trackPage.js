const db = require("../db");
const { ARTIST_COLUMN } = require("../utils/artistName");
const { getTrackUrl, getArtistUrl, getAlbumUrl } = require("../utils/listenbrainzUrl");
const { ensureAlbumCover } = require("./albumCoverCache");
const { ensureAlbumYear } = require("./albumYearCache");
const { withDashboardCache } = require("./dashboardCache");

const SCROBBLE_LIMIT = 100;

const getTrackStats = db.prepare(`
  SELECT
    COUNT(*) AS plays,
    MIN(played_at) AS firstPlay,
    MAX(played_at) AS lastPlay
  FROM scrobbles
  WHERE (${ARTIST_COLUMN} = ? COLLATE NOCASE OR artist = ? COLLATE NOCASE)
    AND track = ? COLLATE NOCASE
`);

const getMainAlbum = db.prepare(`
  SELECT
    album,
    MAX(NULLIF(album_image, '')) AS album_image,
    MAX(release_mbid) AS release_mbid,
    COUNT(*) AS plays
  FROM scrobbles
  WHERE (${ARTIST_COLUMN} = ? COLLATE NOCASE OR artist = ? COLLATE NOCASE)
    AND track = ? COLLATE NOCASE
    AND album IS NOT NULL
    AND TRIM(album) != ''
  GROUP BY album
  ORDER BY plays DESC
  LIMIT 1
`);

const getTrackMbids = db.prepare(`
  SELECT
    MAX(artist_mbid) AS artist_mbid,
    MAX(release_mbid) AS release_mbid,
    MAX(recording_mbid) AS recording_mbid
  FROM scrobbles
  WHERE (${ARTIST_COLUMN} = ? COLLATE NOCASE OR artist = ? COLLATE NOCASE)
    AND track = ? COLLATE NOCASE
`);

const getArtistTrackRank = db.prepare(`
  SELECT COUNT(*) + 1 AS rank
  FROM (
    SELECT track
    FROM scrobbles
    WHERE (${ARTIST_COLUMN} = ? COLLATE NOCASE OR artist = ? COLLATE NOCASE)
    GROUP BY track
    HAVING COUNT(*) > (
      SELECT COUNT(*)
      FROM scrobbles
      WHERE (${ARTIST_COLUMN} = ? COLLATE NOCASE OR artist = ? COLLATE NOCASE)
        AND track = ? COLLATE NOCASE
    )
  )
`);

const getTrackScrobbles = db.prepare(`
  SELECT played_at, album
  FROM scrobbles
  WHERE (${ARTIST_COLUMN} = ? COLLATE NOCASE OR artist = ? COLLATE NOCASE)
    AND track = ? COLLATE NOCASE
  ORDER BY played_at DESC
  LIMIT ? OFFSET ?
`);

async function buildTrackPage(artist, track) {
  const stats = getTrackStats.get(artist, artist, track);
  if (!stats || stats.plays === 0) return null;

  const mainAlbum = getMainAlbum.get(artist, artist, track);
  const rank = getArtistTrackRank.get(artist, artist, artist, artist, track).rank;

  const [cover, year] = await Promise.all([
    mainAlbum
      ? ensureAlbumCover(artist, mainAlbum.album).catch(() => null)
      : Promise.resolve(null),
    mainAlbum
      ? ensureAlbumYear(artist, mainAlbum.album)
      : Promise.resolve(null)
  ]);

  const scrobbles = getTrackScrobbles.all(artist, artist, track, SCROBBLE_LIMIT, 0);
  const mbids = getTrackMbids.get(artist, artist, track) || {};

  return {
    artist,
    track,
    plays: stats.plays,
    firstPlay: stats.firstPlay,
    lastPlay: stats.lastPlay,
    artistRank: rank,
    album: mainAlbum?.album || null,
    albumUrl: mainAlbum ? getAlbumUrl(artist, mainAlbum.album, mainAlbum.release_mbid) : null,
    image: cover || mainAlbum?.album_image || null,
    year: year || null,
    url: getTrackUrl(artist, track, mbids.recording_mbid),
    artistUrl: getArtistUrl(artist, mbids.artist_mbid),
    scrobbles: scrobbles.map(row => ({
      playedAt: row.played_at,
      album: row.album || null
    })),
    scrobbleLimit: SCROBBLE_LIMIT
  };
}

async function getTrackPage(artistName, trackName) {
  const artist = String(artistName || "").trim();
  const track = String(trackName || "").trim();
  if (!artist || !track) return null;

  const cacheKey = `track:${artist.toLocaleLowerCase()}\u0000${track.toLocaleLowerCase()}`;
  const result = await withDashboardCache(cacheKey, () => buildTrackPage(artist, track));

  const data = result?.data || null;

  return {
    ...data,
    cache: result?.cache
  };
}

module.exports = { getTrackPage };
