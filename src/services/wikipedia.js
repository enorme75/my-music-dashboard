require("dotenv").config();

const axios = require("axios");

const { version: APP_VERSION } = require("../../package.json");
const { fetchWithRetry } = require("../utils/fetchRetry");
const { normalize, scoreMatch } = require("../utils/normalizeText");

const USER_AGENT = String(
  process.env.WIKIPEDIA_USER_AGENT
    || `my-music-dashboard/${APP_VERSION} (+https://github.com/enorme75/my-music-dashboard)`
);
const REQUEST_TIMEOUT = Math.max(1000, Number(process.env.IMAGE_REQUEST_TIMEOUT_MS || 10000));

function wikiApiUrl(lang) {
  const code = /^[a-z-]+$/i.test(String(lang || "")) ? String(lang).toLowerCase() : "en";
  return `https://${code}.wikipedia.org/w/api.php`;
}

async function wikiApi(lang, params) {
  return fetchWithRetry(async () => {
    const result = await axios.get(wikiApiUrl(lang), {
      timeout: REQUEST_TIMEOUT,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      params: { format: "json", ...params }
    });
    return result.data;
  }, 2, 750);
}

// Short plain-text intro of an article title, null when the page is missing.
async function getExtract(lang, title) {
  const cleanTitle = String(title || "").trim();
  if (!cleanTitle) return null;

  const data = await wikiApi(lang, {
    action: "query",
    prop: "extracts",
    exintro: 1,
    explaintext: 1,
    redirects: 1,
    titles: cleanTitle
  });

  const pages = data?.query?.pages || {};
  const page = Object.values(pages)[0];
  if (!page || page.missing !== undefined) return null;

  const extract = String(page.extract || "").trim();
  return extract || null;
}

// Heuristics to avoid homonym traps: the article about an artist should talk
// about music, and disambiguation pages ("X may refer to...") are never it.
// "band" alone is NOT enough ("the band of the electromagnetic spectrum").
const MUSICAL_HINT = /\b(musician|singer|songwriter|rapper|disc jockey|\bdj\b|guitarist|drummer|bassist|keyboardist|vocalist|composer|record producer|rock band|pop band|indie band|folk band|jazz band|metal band|space rock|band formed|trio|duo|ensemble|orchestra)\b/i;
const MUSICAL_TITLE_SUFFIX = /\((band|musical group|group|musician|singer|duo|trio|rapper|artist)\)$/i;
const DISAMBIGUATION_HINT = /disambiguation|may refer to|most commonly refers to|is a list of/i;
// Article titles commonly used for a band/musician when "<name>" alone is a
// generic term ("Spectrum", "Phoenix", "Queen"...).
const MUSICAL_TITLE_SUFFIXES = ["(band)", "(musical group)", "(group)", "(musician)", "(singer)", "(duo)", "(trio)", "(rapper)", "(artist)"];

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, " ");
}

function looksMusical(text) {
  return MUSICAL_HINT.test(String(text || "").slice(0, 500));
}

function hasMusicalTitleSuffix(title) {
  return MUSICAL_TITLE_SUFFIX.test(String(title || "").trim());
}

function isDisambiguation(title, snippet) {
  return DISAMBIGUATION_HINT.test(String(title || "")) || DISAMBIGUATION_HINT.test(stripTags(snippet).slice(0, 160));
}

function titleMatchesName(title, name) {
  const wanted = normalize(name);
  const candidate = normalize(title);
  // Strict: "River Phoenix" must not match an artist named "Phoenix".
  return Boolean(wanted) && candidate.startsWith(wanted) && scoreMatch(candidate, wanted) >= 2;
}

// Candidate article titles when the exact "<name>" article is a generic
// homonym: "<name> (French band)" from the MusicBrainz disambiguation
// ("French indie band"), then the conventional generic suffixes.
function candidateTitles(name, disambiguation) {
  const list = [];
  const firstWord = String(disambiguation || "").trim().split(/\s+/)[0];
  if (firstWord) {
    list.push(`${name} (${firstWord} band)`, `${name} (${firstWord} group)`, `${name} (${firstWord} musician)`);
  }
  list.push(...MUSICAL_TITLE_SUFFIXES.map(suffix => `${name} ${suffix}`));
  return list;
}

// Artist bio in the requested language. The exact article title is only
// trusted when its intro actually talks about music; generic homonyms
// ("Spectrum" = the physical term) fall through to musical candidate titles
// (derived from the MusicBrainz disambiguation when known, e.g.
// "Spectrum (UK band)") and then to a search restricted to musical hits whose
// title starts with the artist name.
async function getArtistBio(lang, artistName, hint = {}) {
  const name = String(artistName || "").trim();
  if (!name) return null;

  try {
    const direct = await getExtract(lang, name);
    if (direct && looksMusical(direct) && !isDisambiguation(name, direct)) return direct;

    // Exact title is missing or a generic homonym: try candidate musical titles.
    for (const candidate of candidateTitles(name, hint.disambiguation)) {
      const extract = await getExtract(lang, candidate);
      if (extract && looksMusical(extract) && !isDisambiguation(candidate, extract)) return extract;
    }

    // Search: with the disambiguation as hint when known, plain name otherwise.
    const queries = hint.disambiguation
      ? [`${name} ${hint.disambiguation}`, name]
      : [name];
    for (const query of queries) {
      const search = await wikiApi(lang, {
        action: "query",
        list: "search",
        srsearch: query,
        srnamespace: 0,
        srlimit: 10
      });
      const hits = Array.isArray(search?.query?.search) ? search.query.search : [];
      const named = hits.filter(hit => titleMatchesName(hit?.title, name));
      const musicalHit = named.find(hit => (
        !isDisambiguation(hit.title, hit.snippet)
        && (hasMusicalTitleSuffix(hit.title) || looksMusical(`${hit.title} ${stripTags(hit.snippet)}`))
      ));
      const hit = musicalHit || named[0];
      if (hit) {
        const extract = await getExtract(lang, hit.title);
        if (extract) return extract;
      }
    }

    return direct || null;
  } catch (error) {
    console.warn(`⚠️ [Wikipedia] bio failed for "${name}" (${lang}):`, error.message);
    return null;
  }
}

module.exports = { candidateTitles, getArtistBio, getExtract, hasMusicalTitleSuffix, isDisambiguation, looksMusical, titleMatchesName, wikiApi };
