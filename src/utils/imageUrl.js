// Generic remote-image URL helpers. The Last.fm placeholder hashes are kept so
// that covers cached before the ListenBrainz migration are still recognized as
// unusable instead of being displayed as broken images.
const LASTFM_PLACEHOLDER_PATTERNS = [
  "2a96cbd8b46e442fc41c2b86b821562f",
  "4128a6eb29f94943c9d206c08e625904"
];

// Hosts whose plain-HTTP image URLs are upgraded to HTTPS.
const HTTPS_IMAGE_HOSTS = new Set([
  "lastfm.freetls.fastly.net",
  "lastfm-img2.akamaized.net",
  "img2-ak.lst.fm",
  "userserve-ak.last.fm",
  "cdn-images.dzcdn.net",
  "e-cdns-images.dzcdn.net",
  "coverartarchive.org",
  "archive.org"
]);

// Host patterns allowed for remote images fetched through /api/image-proxy.
// Kept as patterns because Cover Art Archive redirects to *.archive.org.
const REMOTE_IMAGE_HOST_PATTERNS = [
  /(^|\.)last\.fm$/i,
  /(^|\.)lastfm\.freetls\.fastly\.net$/i,
  /(^|\.)lastfm-img2\.akamaized\.net$/i,
  /(^|\.)img2-ak\.lst\.fm$/i,
  /(^|\.)userserve-ak\.last\.fm$/i,
  /(^|\.)dzcdn\.net$/i,
  /(^|\.)deezer\.com$/i,
  /(^|\.)coverartarchive\.org$/i,
  /(^|\.)archive\.org$/i
];

function normalizeImageUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (raw.startsWith("/")) return raw;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

    // Older cached payloads sometimes use HTTP; upgrade the known CDNs only.
    if (parsed.protocol === "http:" && HTTPS_IMAGE_HOSTS.has(parsed.hostname.toLowerCase())) {
      parsed.protocol = "https:";
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

function isLastFmPlaceholder(value) {
  const url = String(value || "").toLowerCase();
  return LASTFM_PLACEHOLDER_PATTERNS.some(pattern => url.includes(pattern));
}

function isUsableImageUrl(value) {
  const url = normalizeImageUrl(value);
  return Boolean(url && !isLastFmPlaceholder(url));
}

function isAllowedRemoteImageHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return REMOTE_IMAGE_HOST_PATTERNS.some(pattern => pattern.test(host));
}

module.exports = {
  LASTFM_PLACEHOLDER_PATTERNS,
  REMOTE_IMAGE_HOST_PATTERNS,
  isAllowedRemoteImageHost,
  isLastFmPlaceholder,
  isUsableImageUrl,
  normalizeImageUrl
};
