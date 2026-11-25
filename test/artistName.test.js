const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ARTIST_COLUMN,
  ARTIST_KEY_COLUMN,
  MAIN_ARTIST_GROUPING,
  artistGroupKey,
  extractMainArtist,
  mainArtist,
  mbidKey,
  textKey
} = require("../src/utils/artistName");

test("extractMainArtist strips featuring markers", () => {
  assert.equal(extractMainArtist("Westside Gunn feat. Keisha Plum"), "Westside Gunn");
  assert.equal(extractMainArtist("Westside Gunn ft. Keisha Plum"), "Westside Gunn");
  assert.equal(extractMainArtist("Westside Gunn featuring Keisha Plum"), "Westside Gunn");
  assert.equal(extractMainArtist("Westside Gunn x Keisha Plum"), "Westside Gunn");
  assert.equal(extractMainArtist("Westside Gunn with Keisha Plum"), "Westside Gunn");
});

test("extractMainArtist keeps only the first artist of tag separator lists", () => {
  assert.equal(extractMainArtist("Westside Gunn/Keisha Plum"), "Westside Gunn");
  assert.equal(extractMainArtist("Westside Gunn/Benny The Butcher/Conway"), "Westside Gunn");
  assert.equal(extractMainArtist("Westside Gunn, Keisha Plum"), "Westside Gunn");
  assert.equal(extractMainArtist("Mach-Hommy, Westside Gunn, Keisha Plum"), "Mach-Hommy");
  assert.equal(extractMainArtist("Westside Gunn & Joey Bada$$"), "Westside Gunn");
  assert.equal(extractMainArtist("JID;Westside Gunn"), "JID");
});

test("extractMainArtist keeps single artist names intact", () => {
  assert.equal(extractMainArtist("Westside Gunn"), "Westside Gunn");
  assert.equal(extractMainArtist("Tyler, The Creator"), "Tyler, The Creator");
  assert.equal(extractMainArtist("AC/DC"), "AC/DC");
  assert.equal(extractMainArtist("Simon & Garfunkel"), "Simon & Garfunkel");
  assert.equal(extractMainArtist("Gunn - Truscinski Duo"), "Gunn - Truscinski Duo");
  assert.equal(extractMainArtist(""), "");
  assert.equal(extractMainArtist(null), "");
  assert.equal(extractMainArtist("  Westside Gunn  "), "Westside Gunn");
});

test("mainArtist follows ARTIST_GROUPING (default: main)", () => {
  assert.equal(MAIN_ARTIST_GROUPING, true);
  assert.equal(ARTIST_COLUMN, "artist_main");
  assert.equal(ARTIST_KEY_COLUMN, "artist_key");
  assert.equal(mainArtist("Westside Gunn/Keisha Plum"), "Westside Gunn");
  assert.equal(mainArtist("Westside Gunn"), "Westside Gunn");
});

test("hybrid group key prefers MBID, then stored key, then text", () => {
  assert.equal(mbidKey("ABC-123"), "mbid:abc-123");
  assert.equal(mbidKey(""), null);
  assert.equal(textKey("Westside Gunn"), "txt:westside gunn");
  assert.equal(textKey(""), null);

  // MBID wins over text (ListenBrainz-style canonicalization)
  assert.equal(
    artistGroupKey({ artistMbid: "9F42BA3D", artistMain: "Westside Gunn" }),
    "mbid:9f42ba3d"
  );
  // stored key wins over everything (local DB already resolved the group)
  assert.equal(
    artistGroupKey({ artistKey: "mbid:9f42ba3d", artistMbid: "other", artistMain: "Westside Gunn" }),
    "mbid:9f42ba3d"
  );
  // text fallback
  assert.equal(artistGroupKey({ artistMain: "Westside Gunn" }), "txt:westside gunn");
  // feat variant and plain name share the same text key
  assert.equal(
    artistGroupKey({ artistMain: mainArtist("Westside Gunn/Keisha Plum") }),
    artistGroupKey({ artistMain: "Westside Gunn" })
  );
});
