const test = require("node:test");
const assert = require("node:assert/strict");

const {
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
} = require("../src/utils/matchCandidates");
const { normalize, scoreMatch } = require("../src/utils/normalizeText");

test("scoreMatch: exact beats word match beats none", () => {
  assert.equal(scoreMatch(normalize("Nick Drake"), normalize("Nick Drake")), 3);
  assert.equal(scoreMatch(normalize("Nick & Becky Drake"), normalize("Nick Drake")), 2);
  assert.equal(scoreMatch(normalize("Nick Drake"), normalize("Nick & Becky Drake")), 2);
  // The cases that produced wrong visuals:
  assert.equal(scoreMatch(normalize("Nicked Drake"), normalize("Nick Drake")), 0);
  assert.equal(scoreMatch(normalize("Runddans (Remixed)"), normalize("Runt")), 0);
  assert.equal(scoreMatch(normalize("Tom Waits"), normalize("Nick Drake")), 0);
  assert.equal(scoreMatch("", "nick drake"), 0);
  assert.equal(scoreMatch("nick drake", ""), 0);
});

test("pickArtistCandidate keeps Nick Drake away from Nicked Drake", () => {
  const items = [
    { id: 427470, name: "Nicked Drake" },
    { id: 2062, name: "Nick Drake" },
    { id: 1128, name: "Tom Waits" }
  ];
  const match = pickArtistCandidate(items, "Nick Drake");
  assert.equal(match.item.id, 2062);
  assert.equal(match.score, 3);

  assert.equal(pickArtistCandidate([{ name: "Nicked Drake" }], "Nick Drake"), null);
  assert.equal(pickArtistCandidate([], "Nick Drake"), null);
});

test("pickAlbumCandidate requires both artist and title to match", () => {
  const items = [
    { id: 12430544, artist: { name: "Todd Rundgren" }, title: "The Complete Bearsville Album Collection" },
    { id: 12431884, artist: { name: "Todd Rundgren" }, title: "Runt" },
    { id: 999, artist: { name: "Todd Terje" }, title: "Runt" }
  ];
  const match = pickAlbumCandidate(items, "Todd Rundgren", "Runt");
  assert.equal(match.item.id, 12431884);

  // No candidate with a matching title -> null (never the first hit).
  assert.equal(pickAlbumCandidate(items, "Todd Rundgren", "Faithful"), null);
  // Right title but wrong artist -> null.
  assert.equal(pickAlbumCandidate([items[2]], "Todd Rundgren", "Runt"), null);
});

test("pickTrackCandidate matches artist and title", () => {
  const items = [
    { artist: { name: "Todd Terje" }, title_short: "Inspector Norse" },
    { artist: { name: "Todd Rundgren" }, title_short: "I Saw the Light", title: "I Saw the Light (Remastered)" }
  ];
  const match = pickTrackCandidate(items, "Todd Rundgren", "I Saw the Light");
  assert.equal(match.item.title_short, "I Saw the Light");
  assert.equal(pickTrackCandidate(items, "Todd Rundgren", "Hello It's Me"), null);
});

test("bestScored prefers exact over partial and keeps ranking on ties", () => {
  const items = [{ name: "a b" }, { name: "a b c" }, { name: "a b" }];
  const match = bestScored(items, "a b", item => item.name);
  assert.equal(match.score, 3);
  assert.equal(match.item, items[0]);
});

test("artistCreditNameOf joins name + joinphrase", () => {
  assert.equal(artistCreditNameOf({
    "artist-credit": [{ name: "Simon", joinphrase: " & " }, { name: "Garfunkel" }]
  }), "Simon & Garfunkel");
  assert.equal(artistCreditNameOf({}), "");
  assert.equal(artistCreditNameOf({ "artist-credit": [] }), "");
});

test("filterByArtistCredit rejects lists whose credits do not match", () => {
  const groups = [
    { title: "Runt", "artist-credit": [{ name: "Todd Terje" }] },
    { title: "Runt", "artist-credit": [{ name: "Todd Rundgren" }] }
  ];
  const filtered = filterByArtistCredit(groups, "Todd Rundgren");
  assert.equal(filtered.length, 1);
  assert.equal(filterByArtistCredit(groups, "Someone Else"), null);
  // No artist-credit at all -> list passes through untouched.
  assert.deepEqual(filterByArtistCredit([{ title: "X" }], "Anyone"), [{ title: "X" }]);
});

test("pickMbReleaseGroup never falls back to the first hit", () => {
  const groups = [
    { id: "g1", title: "Runt", "artist-credit": [{ name: "Todd Terje" }] },
    { id: "g2", title: "Runt", "artist-credit": [{ name: "Todd Rundgren" }] },
    { id: "g3", title: "Runt: The Ballad of Todd Rundgren", "artist-credit": [{ name: "Todd Rundgren" }] }
  ];
  const match = pickMbReleaseGroup(groups, "Todd Rundgren", "Runt");
  assert.equal(match.item.id, "g2");
  assert.equal(match.score, 3);

  assert.equal(pickMbReleaseGroup(groups, "Todd Terje", "Something Else"), null);
  assert.equal(pickMbReleaseGroup([], "Todd Rundgren", "Runt"), null);
});

test("pickMbArtist and pickMbRecording verify names", () => {
  const artists = [{ id: "a1", name: "Nicked Drake" }, { id: "a2", name: "Nick Drake" }];
  assert.equal(pickMbArtist(artists, "Nick Drake").item.id, "a2");
  assert.equal(pickMbArtist(artists, "Nicolas Drake"), null);

  const recordings = [
    { id: "r1", title: "Pink Moon", "artist-credit": [{ name: "Someone Else" }] },
    { id: "r2", title: "Pink Moon", "artist-credit": [{ name: "Nick Drake" }] }
  ];
  assert.equal(pickMbRecording(recordings, "Nick Drake", "Pink Moon").item.id, "r2");
  assert.equal(pickMbRecording(recordings, "Nobody", "Pink Moon"), null);
});

test("deezerImageHash extracts the hash shared by all sizes", () => {
  assert.equal(
    deezerImageHash("https://cdn-images.dzcdn.net/images/artist/6e8750b76709a75f37d5556735c8f17a/1000x1000-000000-80-0-0.jpg"),
    "6e8750b76709a75f37d5556735c8f17a"
  );
  assert.equal(
    deezerImageHash("https://e-cdns-images.dzcdn.net/images/cover/AbCdEf12/500x500.jpg"),
    "abcdef12"
  );
  assert.equal(deezerImageHash("https://coverartarchive.org/release/x/front-500"), null);
});

test("imageIdentity distinguishes dzcdn, CAA and other URLs", () => {
  assert.equal(
    imageIdentity("https://cdn-images.dzcdn.net/images/cover/AAAA/1000x1000.jpg"),
    imageIdentity("https://cdn-images.dzcdn.net/images/cover/AAAA/250x250.jpg")
  );
  assert.equal(
    imageIdentity("https://coverartarchive.org/release/3b5c5f2e-1111-4a2b-8c3d-444455556666/front-500"),
    "caa:3b5c5f2e-1111-4a2b-8c3d-444455556666"
  );
  assert.notEqual(
    imageIdentity("https://coverartarchive.org/release/3b5c5f2e-1111-4a2b-8c3d-444455556666/front-500"),
    imageIdentity("https://cdn-images.dzcdn.net/images/cover/AAAA/1000x1000.jpg")
  );
  assert.equal(imageIdentity(""), null);
});
