const test = require("node:test");
const assert = require("node:assert/strict");

const { normalize, isReasonableMatch, scoreMatch } = require("../src/utils/normalizeText");

test("normalize strips accents, punctuation and edition markers", () => {
  assert.equal(normalize("Björk — Hyperballad (Live Remastered)"), "bjork hyperballad");
  assert.equal(normalize("Pomme!"), "pomme");
  assert.equal(normalize(""), "");
  assert.equal(normalize(null), "");
  assert.equal(normalize("  Daft Punk  "), "daft punk");
});

test("isReasonableMatch accepts equality and inclusion", () => {
  assert.equal(isReasonableMatch("hyperballad", "hyperballad"), true);
  assert.equal(isReasonableMatch("hyperballad 2009", "hyperballad"), true);
  assert.equal(isReasonableMatch("hyperballad", "hyperballad 2009"), true);
  assert.equal(isReasonableMatch("something else", "hyperballad"), false);
  assert.equal(isReasonableMatch("", "hyperballad"), false);
  assert.equal(isReasonableMatch("hyperballad", ""), false);
});

test("scoreMatch scores exact / whole-word / none", () => {
  assert.equal(scoreMatch("nick drake", "nick drake"), 3);
  assert.equal(scoreMatch("nick becky drake", "nick drake"), 2);
  assert.equal(scoreMatch("nick drake", "nick becky drake"), 2);
  // Substring is not enough: no whole-word match.
  assert.equal(scoreMatch("nicked drake", "nick drake"), 0);
  assert.equal(scoreMatch("runddans", "runt"), 0);
  assert.equal(scoreMatch("tom waits", "nick drake"), 0);
  assert.equal(scoreMatch("", "nick drake"), 0);
  assert.equal(scoreMatch("nick drake", ""), 0);
  assert.equal(scoreMatch(null, undefined), 0);
});
