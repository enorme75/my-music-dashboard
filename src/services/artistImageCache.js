const db = require("../db");
const { fetchArtistImage, fetchDeezerArtistImageById } = require("./deezerArtistImage");
const { findArtistCached, getArtistDetailsCached } = require("./musicbrainz");
const { filePathUrl, findEntityIdByMbid, getEntityData } = require("./wikidata");
const { getLocalArtistMbid } = require("../utils/artistMbid");
const { deezerArtistIdFromRelations } = require("../utils/mbRelations");
const { isUsableImageUrl, normalizeImageUrl } = require("../utils/imageUrl");

const getCachedImage = db.prepare(`
  SELECT artist, artist_image, updated_at
  FROM artists
  WHERE artist = ? COLLATE NOCASE
  ORDER BY updated_at DESC
  LIMIT 1
`);

const updateCachedImage = db.prepare(`
  UPDATE artists
  SET artist_image = ?, updated_at = ?
  WHERE artist = ? COLLATE NOCASE
`);

const insertCachedImage = db.prepare(`
  INSERT INTO artists (artist, artist_image, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(artist) DO UPDATE SET
    artist_image = excluded.artist_image,
    updated_at = excluded.updated_at
`);

const saveCachedImage = db.transaction((artist, image, updatedAt) => {
  const update = updateCachedImage.run(image, updatedAt, artist);
  if (!update.changes) insertCachedImage.run(artist, image, updatedAt);
});

const inFlight = new Map();
const failureTtlMs = Math.max(60000, Number(process.env.IMAGE_FAILURE_CACHE_MS) || 10 * 60 * 1000);

function getCachedArtistImage(artist) {
  if (!artist) return null;

  const cached = getCachedImage.get(artist);
  const image = normalizeImageUrl(cached?.artist_image);
  return isUsableImageUrl(image) ? image : null;
}

function rememberArtistImage(artist, image) {
  const normalized = normalizeImageUrl(image);
  if (!artist || !isUsableImageUrl(normalized)) return null;

  saveCachedImage(artist, normalized, Date.now());
  return normalized;
}

// Resolution order when a MusicBrainz MBID is known (from the local listens,
// else a MusicBrainz name search) — all exact, homonym-proof:
//   1. Wikidata entity via SPARQL P434 -> P18 image (no MB rate limit: tried
//      first, it avoids the 1 req/s MusicBrainz queue on list pages)
//   2. Deezer artist id from the MB url-rel -> artist picture
// Fallback: the name-verified Deezer artist search.
async function resolveArtistImage(artist) {
  const mbid = getLocalArtistMbid(artist)
    || (await findArtistCached(artist).catch(() => null))?.mbid;

  if (mbid) {
    const entityId = await findEntityIdByMbid(mbid).catch(() => null);
    if (entityId) {
      const entity = await getEntityData(entityId).catch(() => null);
      if (entity?.imageFile) {
        const url = filePathUrl(entity.imageFile, 1000);
        if (isUsableImageUrl(url)) return normalizeImageUrl(url);
      }
    }

    const details = await getArtistDetailsCached(mbid).catch(() => null);
    const deezerId = deezerArtistIdFromRelations(details?.relations);
    if (deezerId) {
      const url = await fetchDeezerArtistImageById(deezerId).catch(() => null);
      if (url && isUsableImageUrl(url)) return normalizeImageUrl(url);
    }
  }

  return fetchArtistImage(artist);
}

async function ensureArtistImage(artist) {
  if (!artist) return null;

  const cached = getCachedImage.get(artist);
  const cachedImage = getCachedArtistImage(artist);
  if (cachedImage) return cachedImage;
  if (cached?.updated_at && cached.updated_at > Date.now() - failureTtlMs) return null;

  const key = String(artist).toLocaleLowerCase();
  if (inFlight.has(key)) return inFlight.get(key);

  const request = resolveArtistImage(artist)
    .then(image => {
      const saved = rememberArtistImage(artist, image);
      if (!saved) saveCachedImage(artist, null, Date.now());
      return saved;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, request);
  return request;
}

module.exports = { ensureArtistImage, getCachedArtistImage, rememberArtistImage, resolveArtistImage };
