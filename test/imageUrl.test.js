const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isAllowedRemoteImageHost,
  isLastFmPlaceholder,
  isUsableImageUrl,
  normalizeImageUrl
} = require("../src/utils/imageUrl");

test("recognizes legacy Last.fm generic artwork placeholders", () => {
  const albumPlaceholder = "https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png";
  const trackPlaceholder = "https://lastfm.freetls.fastly.net/i/u/128s/4128a6eb29f94943c9d206c08e625904.jpg";

  assert.equal(isLastFmPlaceholder(albumPlaceholder), true);
  assert.equal(isLastFmPlaceholder(trackPlaceholder), true);
  assert.equal(isUsableImageUrl(albumPlaceholder), false);
  assert.equal(isUsableImageUrl("https://coverartarchive.org/release/x/front-500"), true);
});

test("normalizes HTTP image URLs to HTTPS on known CDNs only", () => {
  assert.equal(
    normalizeImageUrl("http://lastfm.freetls.fastly.net/i/u/300x300/cover.png"),
    "https://lastfm.freetls.fastly.net/i/u/300x300/cover.png"
  );
  assert.equal(
    normalizeImageUrl("http://cdn-images.dzcdn.net/images/cover/x.jpg"),
    "https://cdn-images.dzcdn.net/images/cover/x.jpg"
  );
  assert.equal(normalizeImageUrl("http://example.com/cover.png"), "http://example.com/cover.png");
  assert.equal(normalizeImageUrl("data:image/png;base64,abc"), null);
  assert.equal(normalizeImageUrl("javascript:alert(1)"), null);
  assert.equal(normalizeImageUrl("/covers/albums/local.jpg"), "/covers/albums/local.jpg");
});

test("allows the remote image hosts used after the ListenBrainz migration", () => {
  assert.equal(isAllowedRemoteImageHost("coverartarchive.org"), true);
  assert.equal(isAllowedRemoteImageHost("archive.org"), true);
  assert.equal(isAllowedRemoteImageHost("ia800500.us.archive.org"), true);
  assert.equal(isAllowedRemoteImageHost("cdn-images.dzcdn.net"), true);
  assert.equal(isAllowedRemoteImageHost("lastfm.freetls.fastly.net"), true);
  assert.equal(isAllowedRemoteImageHost("evil.example.com"), false);
  assert.equal(isAllowedRemoteImageHost("archive.org.evil.com"), false);
});
