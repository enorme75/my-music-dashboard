// Pure helpers around Wikipedia URLs found in MusicBrainz artist url-rels.
// Resolving the bio through the MBID's own Wikipedia relation is what avoids
// homonym disasters ("Spectrum" the band vs the Wikipedia article about the
// physical spectrum).

// "https://en.wikipedia.org/wiki/Spectrum_(band)" -> { lang: "en", title: "Spectrum (band)" }
function wikipediaTitleFromUrl(resource) {
  const match = String(resource || "").match(/^https?:\/\/([a-z-]+)\.wikipedia\.org\/wiki\/(.+)$/i);
  if (!match) return null;

  let title;
  try {
    title = decodeURIComponent(match[2]);
  } catch {
    title = match[2];
  }
  title = title.replace(/_/g, " ").trim();
  if (!title) return null;

  return { lang: match[1].toLowerCase(), title };
}

// Pick the Wikipedia article title for an artist from its MusicBrainz
// relations (type "wikipedia"): prefer the relation in the requested language,
// fall back to the first one. Returns null when no Wikipedia relation exists.
function pickWikipediaTitle(relations, lang) {
  const list = (Array.isArray(relations) ? relations : [])
    .filter(rel => rel && rel.type === "wikipedia" && rel.resource);

  const wanted = String(lang || "en").toLowerCase();
  const parsed = list
    .map(rel => wikipediaTitleFromUrl(rel.resource))
    .filter(Boolean);

  const exact = parsed.find(entry => entry.lang === wanted);
  return (exact || parsed[0] || {}).title || null;
}

module.exports = { pickWikipediaTitle, wikipediaTitleFromUrl };
