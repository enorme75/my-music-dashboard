const test = require("node:test");
const assert = require("node:assert/strict");

const { pickWikipediaTitle, wikipediaTitleFromUrl } = require("../src/utils/wikiLinks");

test("wikipediaTitleFromUrl parses lang and title", () => {
  assert.deepEqual(
    wikipediaTitleFromUrl("https://en.wikipedia.org/wiki/Spectrum_(band)"),
    { lang: "en", title: "Spectrum (band)" }
  );
  assert.deepEqual(
    wikipediaTitleFromUrl("https://fr.wikipedia.org/wiki/Phoenix_(groupe)"),
    { lang: "fr", title: "Phoenix (groupe)" }
  );
  // underscores become spaces, percent-encoding is decoded
  assert.deepEqual(
    wikipediaTitleFromUrl("https://en.wikipedia.org/wiki/Sigur_R%C3%B3s"),
    { lang: "en", title: "Sigur Rós" }
  );
});

test("wikipediaTitleFromUrl rejects non-wikipedia URLs", () => {
  assert.equal(wikipediaTitleFromUrl("https://musicbrainz.org/artist/123"), null);
  assert.equal(wikipediaTitleFromUrl("https://example.com/wiki/Foo"), null);
  assert.equal(wikipediaTitleFromUrl(""), null);
  assert.equal(wikipediaTitleFromUrl(null), null);
});

test("pickWikipediaTitle prefers the requested language", () => {
  const relations = [
    { type: "wikipedia", resource: "https://en.wikipedia.org/wiki/Spectrum_(band)" },
    { type: "wikipedia", resource: "https://fr.wikipedia.org/wiki/Spectrum_(groupe)" },
    { type: "official homepage", resource: "https://example.com" }
  ];
  assert.equal(pickWikipediaTitle(relations, "en"), "Spectrum (band)");
  assert.equal(pickWikipediaTitle(relations, "fr"), "Spectrum (groupe)");
  // unknown language -> first wikipedia relation
  assert.equal(pickWikipediaTitle(relations, "de"), "Spectrum (band)");
});

test("pickWikipediaTitle ignores non-wikipedia relations and junk", () => {
  const relations = [
    { type: "official homepage", resource: "https://example.com" },
    { type: "wikipedia" },
    { type: "wikipedia", resource: "not a url" },
    { type: "wikidata", resource: "https://www.wikidata.org/entity/Q1" }
  ];
  assert.equal(pickWikipediaTitle(relations, "en"), null);
  assert.equal(pickWikipediaTitle([], "en"), null);
  assert.equal(pickWikipediaTitle(null, "en"), null);
});
