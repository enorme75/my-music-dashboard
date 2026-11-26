const db = require("../db");
const { findArtistCached, getArtistDetailsCached } = require("./musicbrainz");
const { getArtistBio, getExtract } = require("./wikipedia");
const { getEntityData, findEntityIdByMbid, wikipediaTitleFromEntity } = require("./wikidata");
const { getArtistUrl } = require("../utils/listenbrainzUrl");
const { getLocalArtistMbid } = require("../utils/artistMbid");
const { pickWikipediaTitle } = require("../utils/wikiLinks");
const { wikidataEntityFromRelations } = require("../utils/mbRelations");
const { sanitizeError } = require("../utils/sanitizeAxios");

const BIO_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FAILURE_TTL_MS = Math.max(
  60000,
  Number(process.env.METADATA_FAILURE_CACHE_MS) || 10 * 60 * 1000
);

const getCachedInfo = db.prepare(`
  SELECT artist, lang, bio, listenbrainz_url, updated_at
  FROM artist_info
  WHERE artist = ? COLLATE NOCASE
`);

const saveCachedInfo = db.prepare(`
  INSERT INTO artist_info (artist, lang, bio, listenbrainz_url, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(artist) DO UPDATE SET
    lang = excluded.lang,
    bio = excluded.bio,
    listenbrainz_url = excluded.listenbrainz_url,
    updated_at = excluded.updated_at
`);

const inFlight = new Map();

// Wikipedia bios are fetched in this language. English Wikipedia is the
// richest, so it is the default; override with ARTIST_BIO_LANG=fr etc.
function bioLang() {
  return String(process.env.ARTIST_BIO_LANG || "en").trim().toLowerCase() || "en";
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getCachedArtistInfo(artist, lang) {
  const cached = getCachedInfo.get(artist);
  if (!cached) return null;

  const usable = cached.updated_at > Date.now() - FAILURE_TTL_MS;

  if (!cached.bio && !usable) return null;
  if (cached.lang !== lang) return null;

  return {
    bio: cached.bio || null,
    listenbrainzUrl: cached.listenbrainz_url || null
  };
}

// Artist bio + ListenBrainz artist page. The MBID comes from the local listens
// when available (ground truth, no homonym risk), otherwise from a MusicBrainz
// name search. When a MBID is known, the bio is resolved through the artist's
// own Wikipedia url-relation (exact article, e.g. "Spectrum (band)" instead of
// the "Spectrum" disambiguation page); the name-based Wikipedia search and the
// MusicBrainz annotation remain as fallbacks. The public page URL is ListenBrainz.
// The UI already handles a null bio.
async function fetchArtistInfo(artist, lang) {
  let mbid = getLocalArtistMbid(artist);
  let canonicalName = artist;

  let disambiguation = null;
  if (!mbid) {
    const match = await findArtistCached(artist).catch(() => null);
    if (match?.mbid) {
      mbid = match.mbid;
      canonicalName = match.name || artist;
      disambiguation = match.disambiguation || null;
    }
  }

  let bio = null;
  const listenbrainzUrl = mbid ? getArtistUrl(canonicalName, mbid) : null;

  if (mbid) {
    const details = await getArtistDetailsCached(mbid).catch(() => null);
    disambiguation = details?.disambiguation || disambiguation;

    // 1. the artist's own Wikipedia url-relation on MusicBrainz
    let wikiTitle = pickWikipediaTitle(details?.relations, lang);

    // 2. the Wikidata entity linked to the MBID (url-rel, else SPARQL P434):
    //    its sitelinks give the exact Wikipedia article in the wanted language
    if (!wikiTitle) {
      const entityId = wikidataEntityFromRelations(details?.relations)
        || await findEntityIdByMbid(mbid).catch(() => null);
      if (entityId) {
        const entity = await getEntityData(entityId).catch(() => null);
        wikiTitle = wikipediaTitleFromEntity(entity, lang);
      }
    }

    if (wikiTitle) {
      bio = await getExtract(lang, wikiTitle).catch(() => null);
    }
    if (!bio) {
      bio = await getArtistBio(lang, canonicalName, { disambiguation });
    }
    if (!bio) {
      bio = stripHtml(details?.annotation) || null;
    }
  } else {
    bio = await getArtistBio(lang, canonicalName, { disambiguation });
  }

  return { bio, listenbrainzUrl, image: null };
}

async function ensureArtistInfo(artist, lang = "en") {
  if (!artist) return null;

  // The caller's UI language is intentionally overridden: bios are always
  // fetched/cached in ARTIST_BIO_LANG (default "en", richer Wikipedia).
  lang = bioLang();

  const cached = getCachedArtistInfo(artist, lang);
  if (cached) return cached;

  const key = `${String(artist).toLocaleLowerCase()}:${lang}`;
  if (inFlight.has(key)) return inFlight.get(key);

  const request = fetchArtistInfo(artist, lang)
    .then(info => {
      saveCachedInfo.run(
        artist,
        lang,
        info?.bio || null,
        info?.listenbrainzUrl || null,
        Date.now()
      );
      return info;
    })
    .catch(error => {
      console.warn(
        `[artistInfo] could not load MusicBrainz info for "${artist}":`,
        sanitizeError(error).message
      );
      saveCachedInfo.run(artist, lang, null, null, Date.now());
      return null;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, request);
  return request;
}

// Read-only access for the fast (DB-only) page build. Bios are stored in
// ARTIST_BIO_LANG regardless of the UI language, so the lang check is skipped.
function getCachedArtistBio(artist) {
  const cached = getCachedInfo.get(artist);
  if (!cached) return null;
  if (!cached.bio && cached.updated_at <= Date.now() - FAILURE_TTL_MS) return null;
  return {
    bio: cached.bio || null,
    listenbrainzUrl: cached.listenbrainz_url || null
  };
}

module.exports = { ensureArtistInfo, getCachedArtistBio };
