// Pure extractors for MusicBrainz artist url-rels. When a MBID is known, its
// own relations are the exact source of truth: the Deezer artist id (image)
// and the Wikidata entity id (image P18 + Wikipedia sitelinks) — immune to
// homonym mix-ups that a plain name search cannot avoid.

function relationResourcesOf(relations, type) {
  return (Array.isArray(relations) ? relations : [])
    .filter(rel => rel && rel.type === type && rel.url && rel.url.resource)
    .map(rel => String(rel.url.resource));
}

// "https://www.deezer.com/artist/248719" -> "248719"
function deezerArtistIdFromRelations(relations) {
  for (const resource of relationResourcesOf(relations, "deezer")) {
    const match = resource.match(/\/artist\/(\d+)/i);
    if (match) return match[1];
  }
  return null;
}

// "https://www.wikidata.org/entity/Q42" or ".../wiki/Q42" -> "Q42"
function wikidataEntityFromRelations(relations) {
  for (const resource of relationResourcesOf(relations, "wikidata")) {
    const match = resource.match(/\/(?:entity|wiki)\/(Q\d+)$/i);
    if (match) return match[1];
  }
  return null;
}

module.exports = {
  deezerArtistIdFromRelations,
  relationResourcesOf,
  wikidataEntityFromRelations
};
