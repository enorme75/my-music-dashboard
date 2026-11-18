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

test("is not configured without MA_API_URL/MA_TOKEN", () => {
  teardownEnv();
  const client = createMusicAssistantClient({ httpPost: async () => ({}) });
  assert.equal(client.isConfigured(), false);
  assert.throws(
    () => client.resolveQueueId(""),
    error => error.code === "queue_required" && error.statusCode === 400
  );
});

test("resolveQueueId prefers the request queue_id then MA_PLAYER_ID", () => {
  setupEnv({ MA_PLAYER_ID: "default-queue" });
  const client = createMusicAssistantClient({ httpPost: async () => ({}) });
  assert.equal(client.resolveQueueId("chosen-queue"), "chosen-queue");
  assert.equal(client.resolveQueueId(""), "default-queue");
  assert.equal(client.resolveQueueId(null), "default-queue");
});

test("searchTrack picks the best library match and sends the bearer token", async () => {
  setupEnv();
  const calls = [];
  const client = createMusicAssistantClient({
    httpPost: async (url, payload, headers) => {
      calls.push({ url, payload, headers });
      return {
        message_id: payload.message_id,
        result: {
          tracks: [
            {
              item_id: "1",
              name: "Hyperballad (Live Remastered)",
              artists: [{ name: "Björk" }],
              uri: "library://track/1",
              provider_mappings: [{ provider_instance: "library" }]
            },
            {
              item_id: "2",
              name: "Hyperballad",
              artists: [{ name: "Björk" }],
              uri: "library://track/2",
              provider_mappings: [{ provider_instance: "library" }]
            },
            {
              item_id: "3",
              name: "Hyperballad",
              artists: [{ name: "Björk" }],
              uri: "spotify://track/3",
              provider_mappings: [{ provider_instance: "spotify" }]
            }
          ]
        }
      };
    }
  });

  const match = await client.searchTrack("Björk", "Hyperballad");
  assert.ok(match);
  assert.equal(match.id, "2");
  assert.equal(match.uri, "library://track/2");
  assert.equal(match.name, "Hyperballad");
  assert.equal(match.artist, "Björk");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://ma.local:8095/api");
  assert.equal(calls[0].payload.command, "music/search");
  assert.match(calls[0].payload.args.search_query, /Björk Hyperballad/);
  assert.equal(calls[0].headers.Authorization, "Bearer test-token");
});

test("searchTrack returns null when nothing matches the library", async () => {
  setupEnv();
  const client = createMusicAssistantClient({
    httpPost: async () => ({ result: { tracks: [
      { item_id: "9", name: "Something Else", artists: [{ name: "Other" }], uri: "library://track/9" }
    ] } })
  });
  assert.equal(await client.searchTrack("Björk", "Hyperballad"), null);
});

test("searchTrack caches results per normalized artist/track", async () => {
  setupEnv();
  let calls = 0;
  const client = createMusicAssistantClient({
    httpPost: async () => {
      calls += 1;
      return { result: { tracks: [
        { item_id: "2", name: "Hyperballad", artists: [{ name: "Björk" }], uri: "library://track/2" }
      ] } };
    }
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
  const client = createMusicAssistantClient({
    httpPost: async (url, payload) => {
      calls.push(payload);
      return { message_id: payload.message_id, result: null };
    }
  });

  assert.equal(await client.playTrack("queue-1", "library://track/2"), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "player_queues/play_media");
  assert.deepEqual(calls[0].args, { queue_id: "queue-1", media: "library://track/2" });
});

test("MA error payloads become MusicAssistantError with code and 502", async () => {
  setupEnv();
  const client = createMusicAssistantClient({
    httpPost: async () => ({ error: { code: "player_not_found", message: "No such player" } })
  });
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
  const client = createMusicAssistantClient({
    httpPost: async () => { throw new Error("connect ECONNREFUSED"); }
  });
  await assert.rejects(
    () => client.listPlayers(),
    error => error.code === "ma_unreachable" && error.statusCode === 502
  );
});

test("not configured command throws not_configured with 503", async () => {
  teardownEnv();
  const client = createMusicAssistantClient({ httpPost: async () => ({}) });
  await assert.rejects(
    () => client.searchTrack("A", "T"),
    error => error.code === "not_configured" && error.statusCode === 503
  );
});

test("listPlayers maps player_queues/all entries", async () => {
  setupEnv();
  const client = createMusicAssistantClient({
    httpPost: async (url, payload) => {
      assert.equal(payload.command, "player_queues/all");
      return { result: [
        { queue_id: "q1", display_name: "Salon", active: true },
        { player_id: "q2", name: "Chambre" }
      ] };
    }
  });
  assert.deepEqual(await client.listPlayers(), [
    { queue_id: "q1", name: "Salon", active: true },
    { queue_id: "q2", name: "Chambre", active: false }
  ]);
});

test("checkAvailability maps raw artist/track keys to booleans", async () => {
  setupEnv();
  const client = createMusicAssistantClient({
    httpPost: async (url, payload) => {
      if (payload.args.search_query.includes("T1")) {
        return { result: { tracks: [
          { item_id: "2", name: "T1", artists: [{ name: "A" }], uri: "library://track/2" }
        ] } };
      }
      return { result: { tracks: [] } };
    }
  });
  const results = await client.checkAvailability([
    { artist: "A", track: "T1" },
    { artist: "A", track: "T2" }
  ]);
  assert.deepEqual(results, { "A T1": true, "A T2": false });
});

test("getStatus reports configured=false without env and players when configured", async () => {
  teardownEnv();
  const offline = createMusicAssistantClient({ httpPost: async () => ({}) });
  assert.deepEqual(await offline.getStatus(), { configured: false, players: [], defaultQueueId: null });

  setupEnv({ MA_PLAYER_ID: "q-default" });
  const online = createMusicAssistantClient({
    httpPost: async (url, payload) => ({ result: payload.command === "player_queues/all"
      ? [{ queue_id: "q1", display_name: "Salon", active: true }]
      : {} })
  });
  const status = await online.getStatus();
  assert.equal(status.configured, true);
  assert.equal(status.defaultQueueId, "q-default");
  assert.deepEqual(status.players, [{ queue_id: "q1", name: "Salon", active: true }]);
});
