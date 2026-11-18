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
  process.env.MA_REQUEST_TIMEOUT_MS = "8000";
  process.env.MA_SEARCH_CACHE_TTL_MS = "300000";
  process.env.MA_PLAYERS_CACHE_TTL_MS = "60000";
  Object.assign(process.env, overrides);
}

function teardownEnv() {
  delete process.env.MA_API_URL;
  delete process.env.MA_TOKEN;
  delete process.env.MA_PLAYER_ID;
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
  assert.throws(
    () => client.resolveQueueId(""),
    error => error.code === "queue_required" && error.statusCode === 400
  );
});

test("resolveQueueId prefers the request queue_id then MA_PLAYER_ID", () => {
  setupEnv({ MA_PLAYER_ID: "default-queue" });
  const client = clientWith(async () => ({}));
  assert.equal(client.resolveQueueId("chosen-queue"), "chosen-queue");
  assert.equal(client.resolveQueueId(""), "default-queue");
  assert.equal(client.resolveQueueId(null), "default-queue");
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

test("searchTrack falls back to music/search when item_by_name returns an external provider", async () => {
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
        artists: [{ name: "Daft Punk" }]
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
        uri: "deezer--UceRmhqT://track/3", provider: "deezer--UceRmhqT"
      }
    ] } };
  });

  const match = await client.searchTrack("Daft Punk", "One More Time");
  assert.ok(match);
  assert.equal(match.id, "2", "studio library edition wins over live remaster and external provider");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers.Authorization, "Bearer test-token");
});

test("searchTrack returns null when no local match exists", async () => {
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

test("playTrack posts player_queues/play_media with queue_id and media uri", async () => {
  setupEnv();
  const calls = [];
  const client = clientWith(async (url, payload) => {
    calls.push(payload);
    return { message_id: payload.message_id, result: null };
  });

  assert.equal(await client.playTrack("queue-1", "library://track/2"), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "player_queues/play_media");
  assert.deepEqual(calls[0].args, { queue_id: "queue-1", media: "library://track/2" });
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
  assert.deepEqual(await offline.getStatus(), { configured: false, players: [], defaultQueueId: null });

  setupEnv({ MA_PLAYER_ID: "q-default" });
  const online = clientWith(async (url, payload) => ({ result: payload.command === "player_queues/all"
    ? [{ queue_id: "q1", display_name: "Salon", active: true }]
    : {} }));
  const status = await online.getStatus();
  assert.equal(status.configured, true);
  assert.equal(status.defaultQueueId, "q-default");
  assert.deepEqual(status.players, [{ queue_id: "q1", name: "Salon", active: true }]);
});
