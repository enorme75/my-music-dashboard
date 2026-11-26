// Pure candidate-selection helpers for external metadata lookups (Deezer,
// MusicBrainz). Every lookup that returns a list of candidates must go through
// one of these pickers: taking the first hit blindly is what produced wrong
// artist images ("Nicked Drake" for Nick Drake) and wrong album covers
// (a Todd Terje album on a Todd Rundgren album).
const { normalize, scoreMatch } = require("./normalizeText");

// Minimum score for a candidate to be accepted (2 = same words, 3 = exact).
const MIN_SCORE = 2;

function bestScored(items, expected, textOf, minScore = MIN_SCORE) {
  const wanted = normalize(expected);
  if (!wanted) return null;

  let best = null;
  let bestScore = 0;
  for (const item of items || []) {
    const score = scoreMatch(normalize(textOf(item)), wanted);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  return best && bestScore >= minScore ? { item: best, score: bestScore } : null;
}

// Deezer /search/artist: pick the artist whose name matches.
function pickArtistCandidate(items, artist) {
  return bestScored(items, artist, item => item?.name);
}

// Deezer /search/album: both the artist and the album title must match.
function pickAlbumCandidate(items, artist, album) {
  const wantedArtist = normalize(artist);
  const wantedAlbum = normalize(album);
  if (!wantedArtist || !wantedAlbum) return null;

  let best = null;
  let bestScore = 0;
  for (const item of items || []) {
    const artistScore = scoreMatch(normalize(item?.artist?.name), wantedArtist);
    const titleScore = scoreMatch(normalize(item?.title), wantedAlbum);
    if (artistScore < MIN_SCORE || titleScore < MIN_SCORE) continue;
    const total = artistScore + titleScore;
    if (total > bestScore) {
      bestScore = total;
      best = item;
    }
  }

  return best ? { item: best, score: bestScore } : null;
}

// Deezer /search/track: both the artist and the track title must match.
function pickTrackCandidate(items, artist, track) {
  const wantedArtist = normalize(artist);
  const wantedTrack = normalize(track);
  if (!wantedArtist || !wantedTrack) return null;

  let best = null;
  let bestScore = 0;
  for (const item of items || []) {
    const artistScore = scoreMatch(normalize(item?.artist?.name), wantedArtist);
    const titleScore = scoreMatch(normalize(item?.title_short || item?.title), wantedTrack);
    if (artistScore < MIN_SCORE || titleScore < MIN_SCORE) continue;
    const total = artistScore + titleScore;
    if (total > bestScore) {
      bestScore = total;
      best = item;
    }
  }

  return best ? { item: best, score: bestScore } : null;
}

// MusicBrainz artist-credit is an array of { name, joinphrase } parts.
function artistCreditNameOf(release) {
  const credit = release?.["artist-credit"];
  if (!Array.isArray(credit)) return "";
  return credit
    .map(part => `${part?.name || ""}${part?.joinphrase || ""}`)
    .join("")
    .trim();
}

// Restrict a MusicBrainz result list to items whose artist-credit matches.
// When at least one item carries an artist-credit, a list where none of them
// matches means the query missed: return null instead of falling back to the
// first hit.
function filterByArtistCredit(items, artist) {
  const list = Array.isArray(items) ? items : [];
  const wanted = normalize(artist);
  if (!wanted) return list;

  const withCredit = list.filter(item => {
    const credit = item?.["artist-credit"];
    return Array.isArray(credit) && credit.length > 0;
  });
  if (!withCredit.length) return list;

  const matched = withCredit.filter(item => (
    scoreMatch(normalize(artistCreditNameOf(item)), wanted) >= MIN_SCORE
  ));
  return matched.length ? matched : null;
}

function pickMbArtist(artists, artist) {
  return bestScored(filterByArtistCredit(artists, artist) || [], artist, item => item?.name);
}

function pickMbReleaseGroup(groups, artist, album) {
  const byArtist = filterByArtistCredit(groups, artist);
  if (!byArtist) return null;
  return bestScored(byArtist, album, group => group?.title);
}

function pickMbRecording(recordings, artist, track) {
  const byArtist = filterByArtistCredit(recordings, artist);
  if (!byArtist) return null;
  return bestScored(byArtist, track, recording => recording?.title);
}

// Stable identity of a Deezer CDN image: the hash segment is shared by all
// sizes of the same picture (/images/artist/<hash>/1000x1000...jpg).
function deezerImageHash(url) {
  const match = String(url || "").match(/\/images\/(?:artist|cover)\/([0-9a-f]+)\//i);
  return match ? match[1].toLowerCase() : null;
}

// Identity of a remote image URL for comparisons: Deezer hash, Cover Art
// Archive MBID, or the full URL as last resort.
function imageIdentity(url) {
  const raw = String(url || "").trim();
  if (!raw) return null;

  const deezer = deezerImageHash(raw);
  if (deezer) return `dzcdn:${deezer}`;

  const caa = raw.match(/coverartarchive\.org\/(?:release|release-group)\/([0-9a-f-]{36})\//i);
  if (caa) return `caa:${caa[1].toLowerCase()}`;

  return raw.toLowerCase();
}

module.exports = {
  MIN_SCORE,
  artistCreditNameOf,
  bestScored,
  deezerImageHash,
  filterByArtistCredit,
  imageIdentity,
  pickAlbumCandidate,
  pickArtistCandidate,
  pickMbArtist,
  pickMbRecording,
  pickMbReleaseGroup,
  pickTrackCandidate
};
