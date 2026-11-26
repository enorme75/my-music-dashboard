require("dotenv").config();

const axios = require("axios");

const { version: APP_VERSION } = require("../../package.json");
const { fetchWithRetry } = require("../utils/fetchRetry");

// Wikidata is the most reliable image source for an artist when its MusicBrainz
// MBID is known: the entity is found through the P434 (MusicBrainz artist ID)
// statement via SPARQL, so homonyms ("Spectrum" the band vs something else)
// cannot mix up, and the P18 (image) claim gives a real artist photo. The
// entity sitelinks also give the exact Wikipedia article title per language.
const API_URL = "https://www.wikidata.org/w/api.php";
const SPARQL_URL = "https://query.wikidata.org/sparql";
const COMMONS_FILE_PATH = "https://commons.wikimedia.org/wiki/Special:FilePath/";
const USER_AGENT = String(
  process.env.WIKIDATA_USER_AGENT
    || `my-music-dashboard/${APP_VERSION} (+https://github.com/enorme75/my-music-dashboard)`
);
const REQUEST_TIMEOUT = Math.max(1000, Number(process.env.IMAGE_REQUEST_TIMEOUT_MS || 10000));

async function wdApi(params) {
  return fetchWithRetry(async () => {
    const result = await axios.get(API_URL, {
      timeout: REQUEST_TIMEOUT,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      params: { format: "json", ...params }
    });
    return result.data;
  }, 2, 750);
}

// --- Pure parsers (unit-tested) ---

// SPARQL response: { results: { bindings: [{ item: { value: "http://www.wikidata.org/entity/Q42" } }] } }
function entityIdFromSparqlResponse(data) {
  const bindings = data?.results?.bindings || [];
  const uri = String(bindings[0]?.item?.value || "");
  const match = uri.match(/\/entity\/(Q\d+)$/i);
  return match ? match[1] : null;
}

// wbgetentities response: P18 image file name.
function imageFileFromEntityResponse(data, entityId) {
  const claims = data?.entities?.[entityId]?.claims?.P18;
  const file = claims?.[0]?.mainsnak?.datavalue?.value;
  return typeof file === "string" && file.trim() ? file.trim() : null;
}

// wbgetentities response: Wikipedia article title for a language ("en" -> enwiki).
function wikipediaTitleFromSitelinks(data, entityId, lang) {
  const key = `${String(lang || "en").toLowerCase()}wiki`;
  const title = data?.entities?.[entityId]?.sitelinks?.[key]?.title;
  return typeof title === "string" && title.trim() ? title.trim() : null;
}

// Same, on the { sitelinks } object returned by getEntityData.
function wikipediaTitleFromEntity(entity, lang) {
  const key = `${String(lang || "en").toLowerCase()}wiki`;
  const title = entity?.sitelinks?.[key]?.title;
  return typeof title === "string" && title.trim() ? title.trim() : null;
}

function filePathUrl(file, width = 1000) {
  return `${COMMONS_FILE_PATH}${encodeURIComponent(file)}?width=${width}`;
}

// --- Network ---

async function findEntityIdByMbid(mbid) {
  const clean = String(mbid || "").trim();
  if (!clean) return null;
  // haswbstatement:P434 does not work through the API search; SPARQL does.
  const query = `SELECT ?item WHERE { ?item wdt:P434 "${clean}" }`;
  const data = await fetchWithRetry(async () => {
    const result = await axios.get(SPARQL_URL, {
      timeout: REQUEST_TIMEOUT,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      params: { query, format: "json" }
    });
    return result.data;
  }, 2, 1000);
  return entityIdFromSparqlResponse(data);
}

async function getEntityData(entityId) {
  if (!entityId) return null;
  const data = await wdApi({
    action: "wbgetentities",
    ids: entityId,
    props: "claims|sitelinks"
  });
  return {
    imageFile: imageFileFromEntityResponse(data, entityId),
    sitelinks: data?.entities?.[entityId]?.sitelinks || {}
  };
}

// Artist image URL (Wikimedia Commons) for a MusicBrainz artist MBID, or null.
async function getArtistImageUrlByMbid(mbid) {
  const entityId = await findEntityIdByMbid(mbid);
  if (!entityId) return null;
  const entity = await getEntityData(entityId);
  if (!entity?.imageFile) return null;
  return filePathUrl(entity.imageFile, 1000);
}

// Wikipedia article title (requested language) for a MusicBrainz artist MBID.
async function getWikipediaTitleByMbid(mbid, lang) {
  const entityId = await findEntityIdByMbid(mbid);
  if (!entityId) return null;
  const entity = await getEntityData(entityId);
  return wikipediaTitleFromEntity(entity, lang);
}

module.exports = {
  entityIdFromSparqlResponse,
  filePathUrl,
  findEntityIdByMbid,
  getArtistImageUrlByMbid,
  getEntityData,
  getWikipediaTitleByMbid,
  imageFileFromEntityResponse,
  wikipediaTitleFromEntity,
  wikipediaTitleFromSitelinks
};
