const test = require("node:test");
const assert = require("node:assert/strict");

const {
  aggregateMemberCharts,
  buildChartItemsFromListens,
  normalizeChartItems,
  normalizeGroupInput
} = require("../src/utils/leaderboard");
const { getAlbumUrl, getArtistUrl, getTrackUrl } = require("../src/utils/listenbrainzUrl");

test("normalizes chart rows with playcount or ListenBrainz listen_count", () => {
  assert.deepEqual(normalizeChartItems("artists", {
    name: "Radiohead",
    listen_count: 12,
    mbid: "a74b1b7f-71a5-4011-9441-d0b5e4b13c6f",
    url: "https://listenbrainz.org/artist/a74b1b7f-71a5-4011-9441-d0b5e4b13c6f/"
  }), [{
    key: "mbid:a74b1b7f-71a5-4011-9441-d0b5e4b13c6f",
    name: "Radiohead",
    artist: null,
    playcount: 12,
    url: "https://listenbrainz.org/artist/a74b1b7f-71a5-4011-9441-d0b5e4b13c6f/",
    mbid: "a74b1b7f-71a5-4011-9441-d0b5e4b13c6f"
  }]);

  const albums = normalizeChartItems("albums", [{
    name: "Vespertine",
    artist: { "#text": "Björk" },
    playcount: "8"
  }]);
  assert.equal(albums[0].artist, "Björk");
  assert.equal(albums[0].key, "txt:björk\u0000vespertine");

  const tracks = normalizeChartItems("tracks", [{
    name: "Jóga",
    artist: "Björk",
    playcount: "4"
  }]);
  assert.equal(tracks[0].artist, "Björk");
  assert.equal(tracks[0].playcount, 4);
});

test("aggregates raw ListenBrainz listens into artist, album and track charts", () => {
  const listens = [
    { listened_at: 100, track_metadata: { artist_name: "Radiohead", track_name: "Creep", release_name: "Pablo Honey", additional_info: { artist_mbids: ["ar"], recording_mbid: "tr1", release_mbid: "rel1" } } },
    { listened_at: 90, track_metadata: { artist_name: "radiohead", track_name: "Creep", release_name: "Pablo Honey", additional_info: { artist_mbids: ["ar"], recording_mbid: "tr1", release_mbid: "rel1" } } },
    { listened_at: 80, track_metadata: { artist_name: "Björk", track_name: "Jóga", release_name: "Homogenic", additional_info: { artist_mbids: ["ab"], recording_mbid: "tr2", release_mbid: "rel2" } } },
    { listened_at: 70, track_metadata: { artist_name: "Portishead", track_name: "No name" } }
  ];

  const urlBuilders = { getArtistUrl, getAlbumUrl, getTrackUrl };

  const artists = buildChartItemsFromListens("artists", listens, urlBuilders);
  assert.equal(artists.length, 3);
  assert.equal(artists[0].name, "Radiohead");
  assert.equal(artists[0].playcount, 2);
  assert.equal(artists[0].url, "https://listenbrainz.org/artist/ar/");
  assert.equal(artists[0].mbid, "ar");

  const albums = buildChartItemsFromListens("albums", listens, urlBuilders);
  assert.equal(albums.length, 2); // the listen without release_name is skipped
  assert.equal(albums[0].key, "mbid:ar\u0000pablo honey");
  assert.equal(albums[0].playcount, 2);
  assert.equal(albums[0].url, "https://listenbrainz.org/release/rel1/");

  const tracks = buildChartItemsFromListens("tracks", listens, urlBuilders);
  assert.equal(tracks.length, 3);
  assert.equal(tracks[0].key, "mbid:ar\u0000creep");
  assert.equal(tracks[0].url, "https://listenbrainz.org/track/tr1/");
});

test("aggregates case-insensitive group charts and preserves contributions", () => {
  const charts = [
    {
      username: "samuel",
      profile: { username: "samuel", avatar: "/samuel.png" },
      items: normalizeChartItems("artists", [
        { name: "Radiohead", playcount: "12" },
        { name: "Björk", playcount: "4" }
      ])
    },
    {
      username: "friend",
      profile: { username: "friend", avatar: "/friend.png" },
      items: normalizeChartItems("artists", [
        { name: "radiohead", playcount: "7" },
        { name: "Portishead", playcount: "8" }
      ])
    }
  ];

  const result = aggregateMemberCharts("artists", charts, 10);
  assert.equal(result.totalScrobbles, 31);
  assert.equal(result.members[0].username, "samuel");
  assert.equal(result.members[0].scrobbles, 16);
  assert.equal(result.items[0].name, "Radiohead");
  assert.equal(result.items[0].plays, 19);
  assert.equal(result.items[0].listeners, 2);
  assert.deepEqual(result.items[0].contributions, [
    { username: "samuel", plays: 12 },
    { username: "friend", plays: 7 }
  ]);
});

test("keeps failed members in the ranking without affecting totals", () => {
  const result = aggregateMemberCharts("tracks", [
    {
      username: "available",
      profile: { username: "available" },
      items: normalizeChartItems("tracks", [{
        name: "Track",
        artist: "Artist",
        playcount: "3"
      }])
    },
    {
      username: "offline",
      profile: { username: "offline" },
      error: "Temporary ListenBrainz error",
      items: []
    }
  ]);

  assert.equal(result.totalScrobbles, 3);
  assert.equal(result.members.length, 2);
  assert.equal(result.members[1].error, "Temporary ListenBrainz error");
});

test("normalizes group members and rejects invalid group payloads", () => {
  assert.deepEqual(normalizeGroupInput({
    name: "  Friends  ",
    members: ["Samuel", "friend", "samuel"]
  }), {
    name: "Friends",
    members: ["Samuel", "friend"]
  });

  assert.throws(
    () => normalizeGroupInput({ name: "Solo", members: ["Samuel"] }),
    /at least 2 members/
  );
  assert.throws(
    () => normalizeGroupInput({ name: "Bad", members: ["valid", "has space"] }),
    /Invalid ListenBrainz username/
  );
});
