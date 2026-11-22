const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeListen } = require("../src/utils/listenbrainz");
const {
  getListenCoverUrl,
  getReleaseCoverUrl,
  getReleaseGroupCoverUrl
} = require("../src/utils/coverArtArchive");

test("normalizes a full ListenBrainz listen (mbid_mapping + additional_info)", () => {
  const listen = {
    inserted_at: 1771414107,
    listened_at: 1771414109,
    recording_msid: "fd0cad33-ea33-453b-8155-1292379277db",
    track_metadata: {
      artist_name: "Röyksopp",
      track_name: "Some Resolve",
      release_name: "Profound Mysteries II",
      additional_info: {
        artist_mbids: ["1c70a3fc-fa3c-4be1-8b55-c3192db8a884"],
        duration_ms: 402390,
        recording_mbid: "30d08f4c-d825-4ae1-b79c-44242cddd7c0",
        release_mbid: "f1418001-7f1e-46af-bfdb-95faeded8841",
        release_group_mbid: "1d98b0bc-5832-49d2-a93e-463032631a2f"
      },
      mbid_mapping: {
        caa_id: 32916450708,
        caa_release_mbid: "f1418001-7f1e-46af-bfdb-95faeded8841",
        recording_mbid: "30d08f4c-d825-4ae1-b79c-44242cddd7c0"
      }
    }
  };

  assert.deepEqual(normalizeListen(listen), {
    artist: "Röyksopp",
    track: "Some Resolve",
    album: "Profound Mysteries II",
    playedAt: 1771414109,
    duration: 402,
    artistMbid: "1c70a3fc-fa3c-4be1-8b55-c3192db8a884",
    releaseMbid: "f1418001-7f1e-46af-bfdb-95faeded8841",
    releaseGroupMbid: "1d98b0bc-5832-49d2-a93e-463032631a2f",
    recordingMbid: "30d08f4c-d825-4ae1-b79c-44242cddd7c0",
    caaReleaseMbid: "f1418001-7f1e-46af-bfdb-95faeded8841"
  });
});

test("normalizes legacy listens with duration in seconds and no mapping", () => {
  const listen = {
    listened_at: 1600000000,
    track_metadata: {
      artist_name: "  Björk ",
      track_name: "Jóga",
      additional_info: {
        duration: 301,
        recording_mbid: "rec-1",
        artist_mbids: ["art-1"]
      }
    }
  };

  const normalized = normalizeListen(listen);
  assert.equal(normalized.artist, "Björk");
  assert.equal(normalized.track, "Jóga");
  assert.equal(normalized.album, null);
  assert.equal(normalized.duration, 301);
  assert.equal(normalized.recordingMbid, "rec-1");
  assert.equal(normalized.releaseMbid, null);
  assert.equal(normalized.caaReleaseMbid, null);
});

test("rejects listens without a usable timestamp", () => {
  assert.equal(normalizeListen({ track_metadata: { artist_name: "A", track_name: "T" } }).playedAt, null);
  assert.equal(normalizeListen({ listened_at: -5, track_metadata: {} }).playedAt, null);
  assert.equal(normalizeListen(null).playedAt, null);
});

test("builds Cover Art Archive URLs and prefers the CAA release mbid", () => {
  assert.equal(
    getReleaseCoverUrl("f1418001-7f1e-46af-bfdb-95faeded8841", "500"),
    "https://coverartarchive.org/release/f1418001-7f1e-46af-bfdb-95faeded8841/front-500"
  );
  assert.equal(
    getReleaseGroupCoverUrl("1d98b0bc-5832-49d2-a93e-463032631a2f", "250"),
    "https://coverartarchive.org/release-group/1d98b0bc-5832-49d2-a93e-463032631a2f/front-250"
  );
  assert.equal(getReleaseCoverUrl("", "500"), null);
  assert.equal(getReleaseCoverUrl("mbid", "999"), null);

  assert.equal(
    getListenCoverUrl({ caaReleaseMbid: "caa-mbid", releaseMbid: "other-mbid" }, "500"),
    "https://coverartarchive.org/release/caa-mbid/front-500"
  );
  assert.equal(
    getListenCoverUrl({ releaseMbid: "other-mbid" }, "250"),
    "https://coverartarchive.org/release/other-mbid/front-250"
  );
  assert.equal(getListenCoverUrl({}, "500"), null);
});
