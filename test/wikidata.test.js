const test = require("node:test");
const assert = require("node:assert/strict");

const {
  entityIdFromSparqlResponse,
  filePathUrl,
  imageFileFromEntityResponse,
  wikipediaTitleFromEntity,
  wikipediaTitleFromSitelinks
} = require("../src/services/wikidata");

test("entityIdFromSparqlResponse extracts the Q-id from the first binding", () => {
  const data = {
    results: {
      bindings: [
        { item: { value: "http://www.wikidata.org/entity/Q1045752" } }
      ]
    }
  };
  assert.equal(entityIdFromSparqlResponse(data), "Q1045752");
});

test("entityIdFromSparqlResponse returns null when there is no binding", () => {
  assert.equal(entityIdFromSparqlResponse({ results: { bindings: [] } }), null);
  assert.equal(entityIdFromSparqlResponse({}), null);
  assert.equal(entityIdFromSparqlResponse(null), null);
});

test("imageFileFromEntityResponse extracts the P18 file name", () => {
  const data = {
    entities: {
      Q42: {
        claims: {
          P18: [{ mainsnak: { datavalue: { value: "Spectrum band 2010.jpg" } } }]
        }
      }
    }
  };
  assert.equal(imageFileFromEntityResponse(data, "Q42"), "Spectrum band 2010.jpg");
});

test("imageFileFromEntityResponse returns null without P18", () => {
  assert.equal(imageFileFromEntityResponse({ entities: { Q42: { claims: {} } } }, "Q42"), null);
  assert.equal(imageFileFromEntityResponse({ entities: {} }, "Q42"), null);
  assert.equal(imageFileFromEntityResponse(null, "Q42"), null);
});

test("filePathUrl encodes the file name and sets a width", () => {
  assert.equal(
    filePathUrl("Spectrum band 2010.jpg", 1000),
    "https://commons.wikimedia.org/wiki/Special:FilePath/Spectrum%20band%202010.jpg?width=1000"
  );
});

test("wikipediaTitleFromSitelinks picks the requested language sitelink", () => {
  const data = {
    entities: {
      Q1045752: {
        sitelinks: {
          enwiki: { title: "Phoenix (French band)" },
          frwiki: { title: "Phoenix (groupe)" }
        }
      }
    }
  };
  assert.equal(wikipediaTitleFromSitelinks(data, "Q1045752", "en"), "Phoenix (French band)");
  assert.equal(wikipediaTitleFromSitelinks(data, "Q1045752", "fr"), "Phoenix (groupe)");
  assert.equal(wikipediaTitleFromSitelinks(data, "Q1045752", "de"), null);
  assert.equal(wikipediaTitleFromSitelinks(null, "Q1045752", "en"), null);
});

test("wikipediaTitleFromEntity reads the { sitelinks } object from getEntityData", () => {
  const entity = { imageFile: "x.jpg", sitelinks: { enwiki: { title: "Spectrum (band)" } } };
  assert.equal(wikipediaTitleFromEntity(entity, "en"), "Spectrum (band)");
  assert.equal(wikipediaTitleFromEntity(entity, "fr"), null);
  assert.equal(wikipediaTitleFromEntity(null, "en"), null);
});
