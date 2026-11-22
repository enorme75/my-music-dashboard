const test = require("node:test");
const assert = require("node:assert/strict");

const { assertListenBrainzResponse } = require("../src/utils/listenbrainzResponse");

test("accepts successful ListenBrainz responses and 204 as empty", () => {
  const data = { payload: { listens: [] } };
  assert.equal(assertListenBrainzResponse(200, data), data);
  assert.equal(assertListenBrainzResponse(204, undefined), null);
});

test("maps ListenBrainz {code, error} payloads to retryable errors on 429/5xx", () => {
  assert.throws(
    () => assertListenBrainzResponse(429, { code: 429, error: "Rate limit exceeded" }),
    error => {
      assert.equal(error.name, "ListenBrainzApiError");
      assert.equal(error.listenBrainzCode, 429);
      assert.equal(error.statusCode, 502);
      assert.equal(error.response.status, 429);
      assert.match(error.message, /Rate limit exceeded/);
      return true;
    }
  );

  assert.throws(
    () => assertListenBrainzResponse(503, { code: 503, error: "Listen store unavailable" }),
    error => Boolean(error.response)
  );
});

test("does not mark permanent ListenBrainz errors as retryable", () => {
  assert.throws(
    () => assertListenBrainzResponse(404, { code: 404, error: "User not found" }),
    error => {
      assert.equal(error.listenBrainzCode, 404);
      assert.equal(error.statusCode, 502);
      assert.equal(error.response, undefined);
      return true;
    }
  );

  assert.throws(
    () => assertListenBrainzResponse(400, { code: 400, error: "Invalid range: bogus" }),
    error => error.response === undefined
  );
});
