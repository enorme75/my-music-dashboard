// The most frequent artist MBID stored with the local listens for an artist.
// ListenBrainz canonicalizes artist names through MusicBrainz, so this MBID is
// the ground truth for who the artist really is (unlike a name search, which
// confuses homonyms like "Spectrum"). No network call involved.
const db = require("../db");
const { ARTIST_COLUMN } = require("./artistName");

const getMbid = db.prepare(`
  SELECT artist_mbid
  FROM scrobbles
  WHERE (${ARTIST_COLUMN} = ? COLLATE NOCASE OR artist = ? COLLATE NOCASE)
    AND artist_mbid IS NOT NULL AND TRIM(artist_mbid) != ''
  GROUP BY artist_mbid
  ORDER BY COUNT(*) DESC
  LIMIT 1
`);

function getLocalArtistMbid(artist) {
  const name = String(artist || "").trim();
  if (!name) return null;
  return getMbid.get(name, name)?.artist_mbid || null;
}

module.exports = { getLocalArtistMbid };
