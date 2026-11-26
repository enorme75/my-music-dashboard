const test = require("node:test");
const assert = require("node:assert/strict");

const {
  deezerArtistIdFromRelations,
  relationResourcesOf,
  wikidataEntityFromRelations
} = require("../src/utils/mbRelations");

const relations = [
  { type: "discogs", url: { resource: "https://www.discogs.com/artist/125296" } },
  { type: "deezer", url: { resource: "https://www.deezer.com/artist/248719" } },
  { type: "wikidata", url: { resource: "https://www.wikidata.org/entity/Q1045752" } },
  { type: "official homepage", url: { resource: "https://example.com" } }
];

test("deezerArtistIdFromRelations extracts the artist id", () => {
  assert.equal(deezerArtistIdFromRelations(relations), "248719");
  assert.equal(deezerArtistIdFromRelations([]), null);
  assert.equal(deezerArtistIdFromRelations(null), null);
  assert.equal(
    deezerArtistIdFromRelations([{ type: "deezer", url: { resource: "https://www.deezer.com/artist/abc" } }]),
    null
  );
});

test("wikidataEntityFromRelations extracts the Q-id", () => {
  assert.equal(wikidataEntityFromRelations(relations), "Q1045752");
  assert.equal(wikidataEntityFromRelations([]), null);
  assert.equal(
    wikidataEntityFromRelations([{ type: "wikidata", url: { resource: "https://www.wikidata.org/wiki/Q42" } }]),
    "Q42"
  );
});

test("relationResourcesOf filters by type", () => {
  assert.deepEqual(relationResourcesOf(relations, "discogs"), ["https://www.discogs.com/artist/125296"]);
  assert.deepEqual(relationResourcesOf(relations, "myspace"), []);
  assert.deepEqual(relationResourcesOf(null, "discogs"), []);
});
