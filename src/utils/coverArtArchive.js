// Cover Art Archive (coverartarchive.org) serves release / release-group front
// covers at fixed sizes. front-XXX answers 307 -> archive.org when art exists
// and 404 when it does not, so callers should probe with hasCoverArt().
const CAA_URL = String(process.env.COVERARTARCHIVE_URL || "https://coverartarchive.org").replace(/\/+$/, "");

const COVER_SIZES = new Set(["250", "500", "1200"]);

function getReleaseCoverUrl(releaseMbid, size = "500") {
  const mbid = String(releaseMbid || "").trim();
  if (!mbid || !COVER_SIZES.has(String(size))) return null;
  return `${CAA_URL}/release/${encodeURIComponent(mbid)}/front-${size}`;
}

function getReleaseGroupCoverUrl(releaseGroupMbid, size = "500") {
  const mbid = String(releaseGroupMbid || "").trim();
  if (!mbid || !COVER_SIZES.has(String(size))) return null;
  return `${CAA_URL}/release-group/${encodeURIComponent(mbid)}/front-${size}`;
}

// Best cover URL for a normalized listen / stats item: prefer the exact
// caa_release_mbid computed by ListenBrainz, then the plain release_mbid.
function getListenCoverUrl({ caaReleaseMbid, releaseMbid } = {}, size = "500") {
  return getReleaseCoverUrl(caaReleaseMbid || releaseMbid, size);
}

module.exports = {
  CAA_URL,
  getListenCoverUrl,
  getReleaseCoverUrl,
  getReleaseGroupCoverUrl
};
