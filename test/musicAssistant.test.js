const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createMusicAssistantClient,
  MusicAssistantError
} = require("../src/services/musicAssistant");

function setupEnv(overrides = {}) {
  process.env.MA_API_URL = "http://ma.local:8095/api";
  process.env.MA_TOKEN = "test-token";
  process.env.MA_PLAYER_ID = "";
  process.env.MA_DEFAULT_PLAYER = "Squeezelite-MacBook";
  process.env.MA_REQUEST_TIMEOUT_MS = "8000";
  process.env.MA_SEARCH_CACHE_TTL_MS = "300000";
  process.env.MA_PLAYERS_CACHE_TTL_MS = "60000";
  Object.assign(process.env, overrides);
}

function teardownEnv() {
  delete process.env.MA_API_URL;
  delete process.env.MA_TOKEN;
  delete process.env.MA_PLAYER_ID;
  delete process.env.MA_DEFAULT_PLAYER;
}

const LIBRARY_ITEM = {
  item_id: "2",
  provider: "library",
  name: "Hyperballad",
  uri: "library://track/2",
  artists: [{ name: "Björk" }]
};

function clientWith(handler) {
  return createMusicAssistantClient({ httpPost: handler });
}

test("is not configured without MA_API_URL/MA_TOKEN", () => {
  teardownEnv();
  const client = clientWith(async () => ({}));
  assert.equal(client.isConfigured(), false);
});

test("resolveQueueId prefers the request queue_id then MA_PLAYER_ID", async () => {
  setupEnv({ MA_PLAYER_ID: "default-queue" });
  const client = clientWith(async () => ({}));
  assert.equal(await client.resolveQueueId("chosen-queue"), "chosen-queue");
  assert.equal(await client.resolveQueueId(""), "default-queue");
  assert.equal(await client.resolveQueueId(null), "default-queue");
});

test("resolveQueueId throws queue_required when no default is configured", async () => {
  setupEnv({ MA_DEFAULT_PLAYER: "" });
  const client = clientWith(async () => ({}));
  await assert.rejects(
    client.resolveQueueId(""),
    error => error.code === "queue_required" && error.statusCode === 400
  );
});

test("resolveQueueId resolves the default player by name from the MA player list", async () => {
  setupEnv(); // MA_DEFAULT_PLAYER unset -> built-in default "Squeezelite-MacBook"
  const client = clientWith(async (url, payload) => {
    assert.equal(payload.command, "player_queues/all");
    return { result: [
      { queue_id: "dc:a6:32:c6:0c:ba", display_name: "Squeezelite-Delormel-Salon", active: true },
      { queue_id: "02:00:00:00:00:00", display_name: "Squeezelite-MacBook", active: true }
    ] };
  });
  assert.equal(await client.resolveQueueId(""), "02:00:00:00:00:00");
  assert.equal(await client.resolveQueueId(""), "02:00:00:00:00:00", "players cache is reused");
});

test("resolveQueueId falls back to the configured default when the player list is unavailable", async () => {
  setupEnv({ MA_DEFAULT_PLAYER: "Squeezelite-MacBook" });
  const client = clientWith(async () => { throw new Error("boom"); });
  assert.equal(await client.resolveQueueId(""), "Squeezelite-MacBook");
});

test("searchTrack accepts a direct library match from music/item_by_name", async () => {
  setupEnv();
  const calls = [];
  const client = clientWith(async (url, payload, headers) => {
    calls.push({ url, payload, headers });
    assert.equal(payload.command, "music/item_by_name");
    assert.deepEqual(payload.args, { name: "Hyperballad", artist: "Björk" });
    return { message_id: payload.message_id, result: LIBRARY_ITEM };
  });

  const match = await client.searchTrack("Björk", "Hyperballad");
  assert.ok(match);
  assert.equal(match.id, "2");
  assert.equal(match.uri, "library://track/2");
  assert.equal(match.artist, "Björk");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://ma.local:8095/api");
  assert.equal(calls[0].headers.Authorization, "Bearer test-token");
});

test("searchTrack prefers the local library copy over an external provider", async () => {
  setupEnv();
  const calls = [];
  const client = clientWith(async (url, payload, headers) => {
    calls.push({ payload, headers });
    if (payload.command === "music/item_by_name") {
      // MA answers with Deezer even though a local copy exists
      return { result: {
        item_id: "3135553",
        provider: "deezer--UceRmhqT",
        name: "One More Time",
        uri: "deezer--UceRmhqT://track/3135553",
        artists: [{ name: "Daft Punk" }],
        is_playable: true
      } };
    }
    assert.equal(payload.command, "music/search");
    return { result: { tracks: [
      {
        item_id: "1", name: "One More Time (Live Remastered)", artists: [{ name: "Daft Punk" }],
        uri: "library://track/1", provider: "library"
      },
      {
        item_id: "2", name: "One More Time", artists: [{ name: "Daft Punk" }],
        uri: "library://track/2", provider: "library"
      },
      {
        item_id: "3", name: "One More Time", artists: [{ name: "Daft Punk" }],
        uri: "deezer--UceRmhqT://track/3", provider: "deezer--UceRmhqT", is_playable: true
      }
    ] } };
  });

  const match = await client.searchTrack("Daft Punk", "One More Time");
  assert.ok(match);
  assert.equal(match.id, "2", "studio library edition wins over live remaster and external provider");
  assert.equal(match.source, "library");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers.Authorization, "Bearer test-token");
});

test("searchTrack falls back to a playable external provider when no local copy exists", async () => {
  setupEnv();
  const client = clientWith(async (url, payload) => {
    if (payload.command === "music/item_by_name") {
      return { result: {
        item_id: "2430837725",
        provider: "deezer--UceRmhqT",
        name: "Fur Alina",
        uri: "deezer--UceRmhqT://track/2430837725",
        artists: [{ name: "Arvo Pärt" }],
        is_playable: true
      } };
    }
    return { result: { tracks: [] } };
  });

  const match = await client.searchTrack("Arvo Pärt", "Für Alina");
  assert.ok(match);
  assert.equal(match.uri, "deezer--UceRmhqT://track/2430837725");
  assert.equal(match.source, "deezer--UceRmhqT");
});

test("searchTrack rejects external items with wrong or missing artist", async () => {
  setupEnv();
  const client = clientWith(async (url, payload) => {
    if (payload.command === "music/item_by_name") {
      return { result: {
        item_id: "1", provider: "deezer--x", name: "Hyperballad", uri: "deezer--x://track/1",
        artists: [{ name: "Someone Else" }], is_playable: true
      } };
    }
    return { result: { tracks: [
      { item_id: "2", provider: "deezer--x", name: "Hyperballad", uri: "deezer--x://track/2", artists: [], is_playable: true }
    ] } };
  });
  assert.equal(await client.searchTrack("Björk", "Hyperballad"), null);
});

test("searchTrack ignores non-playable external items", async () => {
  setupEnv();
  const client = clientWith(async (url, payload) => {
    if (payload.command === "music/item_by_name") {
      return { result: {
        item_id: "1", provider: "tidal--x", name: "Hyperballad", uri: "tidal--x://track/1",
        artists: [{ name: "Björk" }], is_playable: false
      } };
    }
    return { result: { tracks: [] } };
  });
  assert.equal(await client.searchTrack("Björk", "Hyperballad"), null);
});

test("searchTrack returns null when nothing matches at all", async () => {
  setupEnv();
  const client = clientWith(async (url, payload) => {
    if (payload.command === "music/item_by_name") {
      return { result: {
        item_id: "9", provider: "deezer--x", name: "Something Else",
        uri: "deezer--x://track/9", artists: [{ name: "Other" }]
      } };
    }
    return { result: { tracks: [
      { item_id: "9", name: "Something Else", artists: [{ name: "Other" }], uri: "library://track/9" }
    ] } };
  });
  assert.equal(await client.searchTrack("Björk", "Hyperballad"), null);
});

test("searchTrack caches results per normalized artist/track", async () => {
  setupEnv();
  let calls = 0;
  const client = clientWith(async () => {
    calls += 1;
    return { result: LIBRARY_ITEM };
  });

  const first = await client.searchTrack("Björk", "Hyperballad");
  const second = await client.searchTrack("bjork", "Hyperballad (Remastered)");
  assert.equal(first.id, "2");
  assert.equal(second.id, "2");
  assert.equal(calls, 1);
});

test("playTrack clears the queue first, then posts player_queues/play_media", async () => {
  setupEnv();
  const calls = [];
  const client = clientWith(async (url, payload) => {
    calls.push(payload);
    return { message_id: payload.message_id, result: null };
  });

  assert.equal(await client.playTrack("queue-1", "library://track/2"), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, "player_queues/clear");
  assert.deepEqual(calls[0].args, { queue_id: "queue-1" });
  assert.equal(calls[1].command, "player_queues/play_media");
  assert.deepEqual(calls[1].args, { queue_id: "queue-1", media: "library://track/2" });
});

test("MA error payloads become MusicAssistantError with code and 502", async () => {
  setupEnv();
  const client = clientWith(async () => ({ error: { code: "player_not_found", message: "No such player" } }));
  await assert.rejects(
    () => client.listPlayers(),
    error => error instanceof MusicAssistantError
      && error.code === "player_not_found"
      && error.statusCode === 502
      && /No such player/.test(error.message)
  );
});

test("unreachable MA becomes ma_unreachable", async () => {
  setupEnv();
  const client = clientWith(async () => { throw new Error("connect ECONNREFUSED"); });
  await assert.rejects(
    () => client.listPlayers(),
    error => error.code === "ma_unreachable" && error.statusCode === 502
  );
});

test("HTTP error responses become ma_http_<status>", async () => {
  setupEnv();
  const client = clientWith(async () => {
    const error = new Error("Request failed with status code 500");
    error.response = { status: 500 };
    throw error;
  });
  await assert.rejects(
    () => client.listPlayers(),
    error => error.code === "ma_http_500" && error.statusCode === 502
  );
});

test("not configured command throws not_configured with 503", async () => {
  teardownEnv();
  const client = clientWith(async () => ({}));
  await assert.rejects(
    () => client.searchTrack("A", "T"),
    error => error.code === "not_configured" && error.statusCode === 503
  );
});

test("listPlayers maps player_queues/all entries", async () => {
  setupEnv();
  const client = clientWith(async (url, payload) => {
    assert.equal(payload.command, "player_queues/all");
    return { result: [
      { queue_id: "q1", display_name: "Salon", active: true },
      { player_id: "q2", name: "Chambre" }
    ] };
  });
  assert.deepEqual(await client.listPlayers(), [
    { queue_id: "q1", name: "Salon", active: true },
    { queue_id: "q2", name: "Chambre", active: false }
  ]);
});

test("checkAvailability maps raw artist/track keys to booleans", async () => {
  setupEnv();
  const client = clientWith(async (url, payload) => {
    if (payload.command === "music/item_by_name") {
      if (payload.args.name === "T1") return { result: { ...LIBRARY_ITEM, name: "T1", artists: [{ name: "A" }] } };
      throw new Error("not found");
    }
    return { result: { tracks: [] } };
  });
  const results = await client.checkAvailability([
    { artist: "A", track: "T1" },
    { artist: "A", track: "T2" }
  ]);
  assert.deepEqual(results, { "A T1": true, "A T2": false });
});

test("getStatus reports configured=false without env and players when configured", async () => {
  teardownEnv();
  const offline = clientWith(async () => ({}));
  assert.deepEqual(await offline.getStatus(), {
    configured: false,
    players: [],
    defaultQueueId: null,
    defaultPlayerName: "Squeezelite-MacBook"
  });

  setupEnv({ MA_PLAYER_ID: "q-default" });
  const online = clientWith(async (url, payload) => ({ result: payload.command === "player_queues/all"
    ? [{ queue_id: "q1", display_name: "Salon", active: true }]
    : {} }));
  const status = await online.getStatus();
  assert.equal(status.configured, true);
  assert.equal(status.defaultQueueId, "q-default");
  assert.deepEqual(status.players, [{ queue_id: "q1", name: "Salon", active: true }]);
});

const LIBRARY_ALBUM = {
  item_id: "5487",
  provider: "library",
  name: "Abbey Road",
  uri: "library://album/5487",
  media_type: "album",
  artists: [{ name: "The Beatles" }]
};

test("searchAlbum accepts a direct library album from music/item_by_name with media_type album", async () => {
  setupEnv();
  const calls = [];
  const client = clientWith(async (url, payload) => {
    calls.push(payload);
    assert.equal(payload.command, "music/item_by_name");
    assert.deepEqual(payload.args, { name: "Abbey Road", artist: "The Beatles", media_type: "album" });
    return { result: LIBRARY_ALBUM };
  });

  const match = await client.searchAlbum("The Beatles", "Abbey Road");
  assert.ok(match);
  assert.equal(match.id, "5487");
  assert.equal(match.uri, "library://album/5487");
  assert.equal(match.source, "library");
  assert.equal(calls.length, 1);
});

test("searchAlbum prefers the local library album over an external provider", async () => {
  setupEnv();
  const client = clientWith(async (url, payload) => {
    if (payload.command === "music/item_by_name") {
      return { result: {
        item_id: "12047952",
        provider: "deezer--UceRmhqT",
        name: "Abbey Road",
        version: "Remastered 2009",
        uri: "deezer--UceRmhqT://album/12047952",
        media_type: "album",
        artists: [{ name: "The Beatles" }],
        is_playable: true
      } };
    }
    assert.equal(payload.command, "music/search");
    return { result: { albums: [
      { ...LIBRARY_ALBUM },
      {
        item_id: "112126942",
        provider: "deezer--UceRmhqT",
        name: "Abbey Road",
        version: "Super Deluxe Edition",
        uri: "deezer--UceRmhqT://album/112126942",
        media_type: "album",
        artists: [{ name: "The Beatles" }],
        is_playable: true
      }
    ] } };
  });

  const match = await client.searchAlbum("The Beatles", "Abbey Road");
  assert.ok(match);
  assert.equal(match.uri, "library://album/5487");
  assert.equal(match.source, "library");
});

test("searchAlbum falls back to a playable external album when no local copy exists", async () => {
  setupEnv();
  const client = clientWith(async (url, payload) => {
    if (payload.command === "music/item_by_name") return { result: null };
    assert.equal(payload.command, "music/search");
    return { result: { albums: [
      {
        item_id: "6575789",
        provider: "deezer--UceRmhqT",
        name: "Random Access Memories",
        uri: "deezer--UceRmhqT://album/6575789",
        media_type: "album",
        artists: [{ name: "Daft Punk" }],
        is_playable: true
      },
      {
        item_id: "999",
        provider: "bandcamp--x",
        name: "Random Access Memories Tribute",
        uri: "https://example.bandcamp.com/album/x",
        media_type: "album",
        artists: [{ name: "Someone Else" }],
        is_playable: true
      }
    ] } };
  });

  const match = await client.searchAlbum("Daft Punk", "Random Access Memories");
  assert.ok(match);
  assert.equal(match.uri, "deezer--UceRmhqT://album/6575789");
  assert.equal(match.source, "deezer--UceRmhqT");
});

test("searchAlbum rejects external albums with wrong artist and ignores non-album items", async () => {
  setupEnv();
  const client = clientWith(async (url, payload) => {
    if (payload.command === "music/item_by_name") {
      return { result: {
        item_id: "1",
        provider: "deezer--x",
        name: "Abbey Road",
        uri: "deezer--x://album/1",
        media_type: "album",
        artists: [{ name: "Someone Else" }],
        is_playable: true
      } };
    }
    return { result: { albums: [
      // right album name but it is a track, not an album
      { item_id: "2", provider: "library", name: "Abbey Road", uri: "library://track/2", media_type: "track", artists: [{ name: "The Beatles" }] },
      { item_id: "3", provider: "deezer--x", name: "Abbey Road", uri: "deezer--x://album/3", media_type: "album", artists: [], is_playable: true }
    ] } };
  });
  assert.equal(await client.searchAlbum("The Beatles", "Abbey Road"), null);
});

test("searchAlbum strips edition suffixes on the item_by_name retry", async () => {
  setupEnv();
  const names = [];
  const client = clientWith(async (url, payload) => {
    if (payload.command === "music/item_by_name") {
      names.push(payload.args.name);
      if (payload.args.name === "Abbey Road") return { result: LIBRARY_ALBUM };
      return { result: null };
    }
    return { result: { albums: [] } };
  });

  const match = await client.searchAlbum("The Beatles", "Abbey Road (Remastered)");
  assert.ok(match);
  assert.equal(match.uri, "library://album/5487");
  assert.deepEqual(names, ["Abbey Road (Remastered)", "Abbey Road"]);
});

test("searchAlbum caches results per normalized artist/album", async () => {
  setupEnv();
  let calls = 0;
  const client = clientWith(async () => {
    calls += 1;
    return { result: LIBRARY_ALBUM };
  });

  const first = await client.searchAlbum("The Beatles", "Abbey Road");
  const second = await client.searchAlbum("the beatles", "abbey road");
  assert.equal(first.uri, "library://album/5487");
  assert.equal(second.uri, "library://album/5487");
  assert.equal(calls, 1);
});

test("playAlbum clears the queue first, then plays the album uri", async () => {
  setupEnv();
  const calls = [];
  const client = clientWith(async (url, payload) => {
    calls.push(payload);
    return { message_id: payload.message_id, result: null };
  });

  assert.equal(await client.playAlbum("queue-1", "library://album/5487"), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, "player_queues/clear");
  assert.deepEqual(calls[0].args, { queue_id: "queue-1" });
  assert.equal(calls[1].command, "player_queues/play_media");
  assert.deepEqual(calls[1].args, { queue_id: "queue-1", media: "library://album/5487" });
});

test("checkAlbumAvailability maps raw artist/album keys to booleans", async () => {
  setupEnv();
  const client = clientWith(async (url, payload) => {
    if (payload.command === "music/item_by_name") {
      if (payload.args.name === "Abbey Road") return { result: LIBRARY_ALBUM };
      return { result: null };
    }
    return { result: { albums: [] } };
  });
  const results = await client.checkAlbumAvailability([
    { artist: "The Beatles", album: "Abbey Road" },
    { artist: "The Beatles", album: "Let It Be" }
  ]);
  assert.deepEqual(results, { "The Beatles Abbey Road": true, "The Beatles Let It Be": false });
});
