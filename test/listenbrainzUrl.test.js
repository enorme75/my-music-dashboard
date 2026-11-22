const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getAlbumUrl,
  getArtistUrl,
  getSearchUrl,
  getTrackUrl,
  getUserListensUrl,
  getUserUrl
} = require("../src/utils/listenbrainzUrl");

test("builds exact listenbrainz.org links when MBIDs are known", () => {
  assert.equal(
    getArtistUrl("Radiohead", "a74b1b7f-71a5-4011-9441-d0b5e4b13c6f"),
    "https://listenbrainz.org/artist/a74b1b7f-71a5-4011-9441-d0b5e4b13c6f/"
  );
  assert.equal(
    getAlbumUrl("Björk", "Vespertine", "release-mbid-1"),
    "https://listenbrainz.org/release/release-mbid-1/"
  );
  assert.equal(
    getTrackUrl("Björk", "Jóga", "recording-mbid-1"),
    "https://listenbrainz.org/track/recording-mbid-1/"
  );
});

test("falls back to ListenBrainz search when no MBID is available", () => {
  assert.equal(
    getArtistUrl("Tyler, The Creator"),
    "https://listenbrainz.org/search/?q=Tyler%2C%20The%20Creator"
  );
  assert.equal(
    getAlbumUrl("Björk", "Debut / Live"),
    "https://listenbrainz.org/search/?q=Bj%C3%B6rk%20Debut%20%2F%20Live"
  );
  assert.equal(
    getTrackUrl("Radiohead", "How to Disappear Completely"),
    "https://listenbrainz.org/search/?q=Radiohead%20How%20to%20Disappear%20Completely"
  );
});

test("does not build incomplete links", () => {
  assert.equal(getArtistUrl(""), null);
  assert.equal(getAlbumUrl("Artist", ""), null);
  assert.equal(getTrackUrl("Artist", ""), null);
  assert.equal(getSearchUrl("   "), null);
  // without an MBID, a track with a name still gets a search link
  assert.equal(
    getTrackUrl("", "Track"),
    "https://listenbrainz.org/search/?q=Track"
  );
});

test("builds user profile and listens links", () => {
  assert.equal(getUserUrl("OUF"), "https://listenbrainz.org/user/OUF/");
  assert.equal(
    getUserListensUrl("OUF"),
    "https://listenbrainz.org/user/OUF/listens/"
  );
  assert.equal(getUserUrl(""), null);
  assert.equal(getUserListensUrl(""), null);
});
