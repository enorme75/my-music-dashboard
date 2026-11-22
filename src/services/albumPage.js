const db = require("../db");
const { getTrackUrl, getAlbumUrl, getArtistUrl } = require("../utils/listenbrainzUrl");
const { ensureAlbumCover } = require("./albumCoverCache");
const { ensureAlbumYear } = require("./albumYearCache");
const { ensureDiscogsAlbumLink } = require("./discogsCache");
const { getAlbumTracks: fetchAlbumTracks } = require("./albumMetadata");
const { withDashboardCache } = require("./dashboardCache");

const getAlbumStats = db.prepare(`
  SELECT
    COUNT(*) AS plays,
    MIN(played_at) AS firstPlay,
    MAX(played_at) AS lastPlay,
    COUNT(DISTINCT track) AS uniqueTracks,
    MAX(NULLIF(album_image, '')) AS album_image,
    MAX(artist_mbid) AS artist_mbid,
    MAX(release_mbid) AS release_mbid
  FROM scrobbles
  WHERE artist = ? COLLATE NOCASE AND album = ? COLLATE NOCASE
`);

const getAlbumTracks = db.prepare(`
  SELECT
    track,
    COUNT(*) AS plays,
    MAX(played_at) AS lastPlay,
    MAX(recording_mbid) AS recording_mbid
  FROM scrobbles
  WHERE artist = ? COLLATE NOCASE AND album = ? COLLATE NOCASE
  GROUP BY track
  ORDER BY plays DESC
`);

async function buildAlbumPage(artist, album) {
  const stats = getAlbumStats.get(artist, album);
  if (!stats || stats.plays === 0) return null;

  const tracks = getAlbumTracks.all(artist, album);
  const [cover, year, discogs, albumTracks] = await Promise.all([
    ensureAlbumCover(artist, album).catch(() => null),
    ensureAlbumYear(artist, album),
    ensureDiscogsAlbumLink(artist, album).catch(() => null),
    fetchAlbumTracks(artist, album).catch(() => null)
  ]);

  return {
    artist,
    album,
    plays: stats.plays,
    firstPlay: stats.firstPlay,
    lastPlay: stats.lastPlay,
    uniqueTracks: stats.uniqueTracks,
    image: cover || stats.album_image || null,
    year: year || null,
    url: getAlbumUrl(artist, album, stats.release_mbid),
    artistUrl: getArtistUrl(artist, stats.artist_mbid),
    discogsUrl: discogs?.url || null,
    genres: discogs?.genres || null,
    styles: discogs?.styles || null,
    label: discogs?.label || null,
    discogsTracklist: discogs?.tracklist || null,
    externalTracklist: albumTracks || null,
    tracks: tracks.map(row => ({
      track: row.track,
      plays: row.plays,
      lastPlay: row.lastPlay,
      url: getTrackUrl(artist, row.track, row.recording_mbid)
    }))
  };
}

async function getAlbumPage(artistName, albumName) {
  const artist = String(artistName || "").trim();
  const album = String(albumName || "").trim();
  if (!artist || !album) return null;

  const cacheKey = `album:${artist.toLocaleLowerCase()}\u0000${album.toLocaleLowerCase()}`;
  const result = await withDashboardCache(cacheKey, () => buildAlbumPage(artist, album));

  const data = result?.data || null;

  return {
    ...data,
    cache: result?.cache
  };
}

module.exports = { getAlbumPage };
