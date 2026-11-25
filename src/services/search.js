const db = require("../db");
const { ARTIST_COLUMN, ARTIST_KEY_COLUMN } = require("../utils/artistName");
const { getArtistUrl, getAlbumUrl, getTrackUrl } = require("../utils/listenbrainzUrl");
const { getCachedArtistImage } = require("./artistImageCache");

db.function("norm", { deterministic: true }, value => {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase();
});

function escapeLike(value) {
  return String(value || "").replace(/[\\%_]/g, match => `\\${match}`);
}

function likePattern(query) {
  return `%${escapeLike(
    String(query || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase()
  )}%`;
}

const searchArtists = db.prepare(`
  SELECT ${ARTIST_COLUMN} AS artist, COUNT(*) AS plays, MAX(artist_mbid) AS artist_mbid
  FROM scrobbles
  WHERE norm(artist) LIKE ? ESCAPE '\\'
  GROUP BY ${ARTIST_KEY_COLUMN}
  ORDER BY plays DESC
  LIMIT 10
`);

const searchAlbums = db.prepare(`
  SELECT
    ${ARTIST_COLUMN} AS artist,
    album,
    COUNT(*) AS plays,
    MAX(NULLIF(album_image, '')) AS album_image,
    MAX(artist_mbid) AS artist_mbid,
    MAX(release_mbid) AS release_mbid
  FROM scrobbles
  WHERE norm(album) LIKE ? ESCAPE '\\'
    AND album IS NOT NULL
    AND TRIM(album) != ''
  GROUP BY ${ARTIST_KEY_COLUMN}, album
  ORDER BY plays DESC
  LIMIT 10
`);

const searchTracks = db.prepare(`
  SELECT
    ${ARTIST_COLUMN} AS artist,
    track,
    COUNT(*) AS plays,
    MAX(artist_mbid) AS artist_mbid,
    MAX(release_mbid) AS release_mbid,
    MAX(recording_mbid) AS recording_mbid
  FROM scrobbles
  WHERE norm(track) LIKE ? ESCAPE '\\'
  GROUP BY ${ARTIST_KEY_COLUMN}, track
  ORDER BY plays DESC
  LIMIT 10
`);

function searchLibrary(query) {
  const pattern = likePattern(query);

  const artists = searchArtists.all(pattern).map(row => ({
    artist: row.artist,
    plays: row.plays,
    image: getCachedArtistImage(row.artist),
    url: getArtistUrl(row.artist, row.artist_mbid)
  }));

  const albums = searchAlbums.all(pattern).map(row => ({
    artist: row.artist,
    album: row.album,
    plays: row.plays,
    image: row.album_image || null,
    url: getAlbumUrl(row.artist, row.album, row.release_mbid)
  }));

  const tracks = searchTracks.all(pattern).map(row => ({
    artist: row.artist,
    track: row.track,
    plays: row.plays,
    url: getTrackUrl(row.artist, row.track, row.recording_mbid),
    artist_url: getArtistUrl(row.artist, row.artist_mbid)
  }));

  return { query, artists, albums, tracks };
}

module.exports = { searchLibrary };
