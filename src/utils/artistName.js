// Artist grouping ("main artist" mode).
//
// Scrobblers often submit the full artist tag of a track, featurings included
// ("Westside Gunn/Keisha Plum", "Westside Gunn, Benny The Butcher", "A feat. B").
// Last.fm and ListenBrainz canonicalize those listens to the main artist of the
// recording (via MusicBrainz), so a whole album counts towards the album artist.
// This app stores the raw artist string, so we derive the same "main artist"
// textually and group stats on it.
//
// ARTIST_GROUPING=main (default): group by the main artist, like Last.fm/LB.
// ARTIST_GROUPING=raw: group by the full artist string (previous behavior).

const GROUPING_MODE = String(process.env.ARTIST_GROUPING || "main")
  .trim()
  .toLocaleLowerCase();

const MAIN_ARTIST_GROUPING = GROUPING_MODE !== "raw";

// Column holding the main artist (display name) on the scrobbles table. In
// "raw" mode we simply keep grouping on the original artist column.
const ARTIST_COLUMN = MAIN_ARTIST_GROUPING ? "artist_main" : "artist";

// Hybrid grouping key: when any scrobble of a main artist carries a MusicBrainz
// artist MBID, the whole group is keyed by "mbid:<mbid>" (exactly what
// ListenBrainz does with its server-side mapping); otherwise the key is the
// normalized main-artist text ("txt:<name>"). In "raw" mode both collapse to
// the original artist column.
const ARTIST_KEY_COLUMN = MAIN_ARTIST_GROUPING ? "artist_key" : "artist";

function mbidKey(mbid) {
  const value = String(mbid || "").trim().toLocaleLowerCase();
  return value ? `mbid:${value}` : null;
}

function textKey(artistMain) {
  const value = String(artistMain || "").trim().toLocaleLowerCase();
  return value ? `txt:${value}` : null;
}

// Key for a listen/row: stored key > MBID > main-artist text.
function artistGroupKey({ artistKey, artistMbid, artistMain }) {
  const stored = String(artistKey || "").trim();
  if (stored) return stored.toLocaleLowerCase();
  return mbidKey(artistMbid) || textKey(artistMain);
}

// "A feat. B", "A ft B", "A featuring B", "A with B", "A x B"
const FEATURING_MARKER = /\s+(?:featuring|feat|ft|with|x)\b\.?\s+/i;

function hasSpaceOnEitherSide(parts, index) {
  const left = String(parts[index] || "").trim();
  const right = String(parts[index + 1] || "").trim();
  return left.includes(" ") || right.includes(" ");
}

// Keeps only the first artist of a collaboration string. "/" and "&" only act
// as separators when at least one side contains a space, so genuine single-word
// names like "AC/DC" or "Simon & Garfunkel" stay intact.
function firstListSegment(value) {
  let rest = value;

  const semicolonParts = rest.split(";");
  rest = semicolonParts[0];

  const ampParts = rest.split("&");
  if (ampParts.length > 1 && ampParts.some((part, index) => hasSpaceOnEitherSide(ampParts, index))) {
    rest = ampParts[0];
  }

  const slashParts = rest.split("/");
  if (slashParts.length > 1 && slashParts.some((part, index) => hasSpaceOnEitherSide(slashParts, index))) {
    rest = slashParts[0];
  }

  const commaParts = rest.split(/,(?!\s*the\b)/i);
  rest = commaParts[0];

  return rest;
}

// "Westside Gunn/Keisha Plum" -> "Westside Gunn"
// "Westside Gunn feat. Keisha Plum" -> "Westside Gunn"
// "Tyler, The Creator" -> "Tyler, The Creator"
// "AC/DC" -> "AC/DC"
// Pure function of the input string: the artist_main column always stores this
// value, whatever ARTIST_GROUPING is, so the mode can be switched at read time.
function extractMainArtist(artist) {
  const original = String(artist || "").trim();
  if (!original) return original;

  let value = original.replace(/\s+/g, " ");

  const markerParts = value.split(FEATURING_MARKER);
  if (markerParts.length > 1) value = markerParts[0];

  value = firstListSegment(value);

  value = value.trim();
  return value || original;
}

// Mode-aware variant used when aggregating in JS (e.g. raw ListenBrainz
// listens): returns the input unchanged when ARTIST_GROUPING=raw.
function mainArtist(artist) {
  if (!MAIN_ARTIST_GROUPING) return String(artist || "").trim();
  return extractMainArtist(artist);
}

module.exports = {
  ARTIST_COLUMN,
  ARTIST_KEY_COLUMN,
  MAIN_ARTIST_GROUPING,
  artistGroupKey,
  artistGroupingMode: () => GROUPING_MODE,
  extractMainArtist,
  mainArtist,
  mbidKey,
  textKey
};
