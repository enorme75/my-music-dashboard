const db = require("../db");
const { findArtist, getArtistDetails } = require("./musicbrainz");
const { getArtistBio } = require("./wikipedia");
const { getArtistUrl } = require("../utils/listenbrainzUrl");
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

// Artist bio + ListenBrainz artist page: the MBID comes from MusicBrainz, the
// bio text from Wikipedia in the requested language (MusicBrainz annotations
// are kept as a last-resort fallback), and the public page URL from
// ListenBrainz. The UI already handles a null bio.
async function fetchArtistInfo(artist, lang) {
  const match = await findArtist(artist);

  let bio = await getArtistBio(lang, match?.name || artist);
  let listenbrainzUrl = match?.mbid
    ? getArtistUrl(match.name || artist, match.mbid)
    : null;

  if (!bio && match?.mbid) {
    const details = await getArtistDetails(match.mbid);
    bio = stripHtml(details?.annotation) || null;
  }

  if (!match?.mbid) return { bio, listenbrainzUrl: null, image: null };

  return {
    bio,
    listenbrainzUrl,
    image: null
  };
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

module.exports = { ensureArtistInfo };
