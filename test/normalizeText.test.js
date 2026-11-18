const test = require("node:test");
const assert = require("node:assert/strict");

const { normalize, isReasonableMatch } = require("../src/utils/normalizeText");

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
