// Paginated "top" lists (artists / albums / tracks) behind GET /api/top-list.
// Same SQL shapes as the /api/top-* endpoints (which stay untouched), with
// LIMIT/OFFSET, a total count, ListenBrainz URLs per row and an optional
// artist filter (used by the "see all" link of an artist page).
const db = require("../db");
const { ARTIST_COLUMN, ARTIST_KEY_COLUMN } = require("../utils/artistName");
const { getAlbumUrl, getArtistUrl, getTrackUrl } = require("../utils/listenbrainzUrl");
const { ensureArtistImage, getCachedArtistImage, rememberArtistImage } = require("./artistImageCache");
const { ensureAlbumCover, getCachedAlbumCover, rememberAlbumCover } = require("./albumCoverCache");
const { mapWithConcurrency } = require("../utils/mapWithConcurrency");

// List pages enrich many rows at once (artist images, album covers): use a
// wider lane than the default so pagination stays responsive.
const LIST_CONCURRENCY = Math.max(
  4,
  2 * (Number.parseInt(process.env.EXTERNAL_REQUEST_CONCURRENCY || "4", 10) || 4)
);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const TYPES = {
  artists: {
    select: `${ARTIST_COLUMN} AS artist, MAX(artist_mbid) AS artist_mbid, COUNT(*) AS plays`,
    groupBy: ARTIST_KEY_COLUMN,
    url: row => getArtistUrl(row.artist, row.artist_mbid)
  },
  albums: {
    select: `
      ${ARTIST_COLUMN} AS artist,
      album,
      MAX(release_mbid) AS release_mbid,
      MAX(NULLIF(album_image, '')) AS album_image,
      COUNT(*) AS plays
    `,
    where: "album IS NOT NULL AND TRIM(album) != ''",
    groupBy: `${ARTIST_KEY_COLUMN}, album`,
    url: row => getAlbumUrl(row.artist, row.album, row.release_mbid)
  },
  tracks: {
    select: `
      track,
      ${ARTIST_COLUMN} AS artist,
      album,
      MAX(recording_mbid) AS recording_mbid,
      MAX(NULLIF(album_image, '')) AS album_image,
      MAX(track_duration) AS track_duration,
      COUNT(*) AS plays
    `,
    where: "album IS NOT NULL AND TRIM(album) != ''",
    groupBy: `track, ${ARTIST_KEY_COLUMN}, album`,
    url: row => getTrackUrl(row.artist, row.track, row.recording_mbid)
  }
};

function parsePaging(query = {}) {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(query.limit, 10) || DEFAULT_LIMIT));
  const offset = Math.max(0, Number.parseInt(query.offset, 10) || 0);
  return { limit, offset };
}

// Pure query builder (unit-tested): returns the count/rows SQL + params.
function buildTopListQuery(type, filter = {}, { limit, offset } = {}, artist = null) {
  const config = TYPES[type];
  if (!config) return null;

  const whereParts = [];
  const params = [];

  if (config.where) whereParts.push(config.where);
  if (filter.where) {
    whereParts.push(filter.where);
    params.push(...filter.params);
  }
  if (artist) {
    whereParts.push(`(${ARTIST_COLUMN} = ? COLLATE NOCASE OR artist = ? COLLATE NOCASE)`);
    params.push(artist, artist);
  }

  const where = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
  const base = `FROM scrobbles ${where}`;

  return {
    countSql: `SELECT COUNT(*) AS total FROM (SELECT 1 ${base} GROUP BY ${config.groupBy})`,
    countParams: params,
    rowsSql: `
      SELECT ${config.select}
      ${base}
      GROUP BY ${config.groupBy}
      ORDER BY plays DESC, artist COLLATE NOCASE
      LIMIT ? OFFSET ?
    `,
    rowsParams: [...params, limit, offset]
  };
}

// Cache-only enrichment: instant, no network. Used to answer list pages
// immediately; missing images/covers are enriched in the background.
function cachedEnrich(type, row) {
  if (type === "artists") {
    return { image: getCachedArtistImage(row.artist) };
  }
  const cover = getCachedAlbumCover(row.artist, row.album) || row.album_image || null;
  if (type === "tracks") {
    return { album_image: cover, total_seconds: (row.track_duration || 0) * row.plays };
  }
  return { album_image: cover };
}

function needsEnrich(type, row) {
  if (type === "artists") return !getCachedArtistImage(row.artist);
  return !(getCachedAlbumCover(row.artist, row.album) || row.album_image);
}

// Network enrichment of a single row (background path).
async function enrichRow(type, row) {
  if (type === "artists") {
    return { image: await ensureArtistImage(row.artist).catch(() => null) };
  }
  const albumImage = await ensureAlbumCover(row.artist, row.album).catch(() => null);
  return { album_image: albumImage };
}

function rememberEnriched(type, row, enriched) {
  if (!enriched) return;
  if (type === "artists") {
    if (enriched.image) rememberArtistImage(row.artist, enriched.image);
    return;
  }
  if (enriched.album_image) rememberAlbumCover(row.artist, row.album, enriched.album_image);
}

// Two-phase: answer immediately with the SQL rows + cached images + LB urls,
// and enrich the missing images/covers in the background (they land in the
// persistent cache; the frontend polls with cachedOnly=1 to pick them up).
// With cachedOnly=1 no background work is started.
async function getTopList(type, filter = {}, paging = {}, artist = null, { cachedOnly = false } = {}) {
  const { limit, offset } = parsePaging(paging);
  const query = buildTopListQuery(type, filter, { limit, offset }, artist);
  if (!query) return null;

  const total = db.prepare(query.countSql).get(...query.countParams)?.total || 0;
  const rows = db.prepare(query.rowsSql).all(...query.rowsParams);

  const items = rows.map(row => ({
    ...row,
    ...cachedEnrich(type, row),
    url: TYPES[type].url(row)
  }));

  const missing = rows.filter(row => needsEnrich(type, row));
  const enriching = missing.length > 0;

  if (enriching && !cachedOnly) {
    mapWithConcurrency(missing, LIST_CONCURRENCY, row => (
      enrichRow(type, row)
        .then(enriched => rememberEnriched(type, row, enriched))
        .catch(() => {})
    )).catch(() => {});
  }

  return {
    type,
    items,
    total,
    offset,
    limit,
    hasMore: offset + rows.length < total,
    enriching
  };
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  TYPES,
  buildTopListQuery,
  cachedEnrich,
  getTopList,
  parsePaging
};
