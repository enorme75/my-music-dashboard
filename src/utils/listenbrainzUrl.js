// Builds listenbrainz.org links. When a MusicBrainz MBID is known the link is
// exact (artist/release/track pages); otherwise we fall back to LB search.
const WEB_URL = String(process.env.LISTENBRAINZ_WEB_URL || "https://listenbrainz.org").replace(/\/+$/, "");

function encodeSegment(value) {
  return encodeURIComponent(String(value || "").trim());
}

function getSearchUrl(query) {
  const text = String(query || "").trim();
  if (!text) return null;
  return `${WEB_URL}/search/?q=${encodeURIComponent(text)}`;
}

function getArtistUrl(artist, artistMbid) {
  const mbid = String(artistMbid || "").trim();
  if (mbid) return `${WEB_URL}/artist/${encodeSegment(mbid)}/`;
  return getSearchUrl(artist);
}

function getAlbumUrl(artist, album, releaseMbid) {
  const mbid = String(releaseMbid || "").trim();
  if (mbid) return `${WEB_URL}/release/${encodeSegment(mbid)}/`;
  const name = String(album || "").trim();
  if (!name) return null;
  return getSearchUrl(`${String(artist || "").trim()} ${name}`.trim());
}

function getTrackUrl(artist, track, recordingMbid) {
  const mbid = String(recordingMbid || "").trim();
  if (mbid) return `${WEB_URL}/track/${encodeSegment(mbid)}/`;
  const name = String(track || "").trim();
  if (!name) return null;
  return getSearchUrl(`${String(artist || "").trim()} ${name}`.trim());
}

function getUserUrl(username) {
  const name = String(username || "").trim();
  if (!name) return null;
  return `${WEB_URL}/user/${encodeSegment(name)}/`;
}

function getUserListensUrl(username) {
  const url = getUserUrl(username);
  return url ? `${url}listens/` : null;
}

module.exports = {
  WEB_URL,
  getAlbumUrl,
  getArtistUrl,
  getSearchUrl,
  getTrackUrl,
  getUserListensUrl,
  getUserUrl
};
