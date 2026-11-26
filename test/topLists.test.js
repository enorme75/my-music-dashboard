const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Isolate the database before requiring the modules.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-toplists-"));
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, "test.db");

const db = require("../src/db");
const { buildTopListQuery, parsePaging, TYPES } = require("../src/services/topLists");

const insert = db.prepare(`
  INSERT INTO scrobbles (artist, artist_main, artist_key, track, album, played_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const NOW = 1_800_000_000;
function seed() {
  // "A" has 3 plays (2 on album X, 1 on album Y), "B" has 1 play.
  const rows = [
    ["Artist A", "Artist A", "txt:artist a", "Song 1", "Album X", NOW - 100],
    ["Artist A", "Artist A", "txt:artist a", "Song 1", "Album X", NOW - 200],
    ["Artist A", "Artist A", "txt:artist a", "Song 2", "Album Y", NOW - 300],
    ["Artist B", "Artist B", "txt:artist b", "Song 9", "Album Z", NOW - 400]
  ];
  for (const row of rows) insert.run(...row);
}

test("parsePaging clamps limit and offset", () => {
  assert.deepEqual(parsePaging({}), { limit: 50, offset: 0 });
  assert.deepEqual(parsePaging({ limit: "10", offset: "20" }), { limit: 10, offset: 20 });
  assert.deepEqual(parsePaging({ limit: "99999", offset: "-5" }), { limit: 200, offset: 0 });
  assert.deepEqual(parsePaging({ limit: "abc", offset: "x" }), { limit: 50, offset: 0 });
});

test("buildTopListQuery returns null for an unknown type", () => {
  assert.equal(buildTopListQuery("genres", {}, { limit: 10, offset: 0 }), null);
  assert.deepEqual(Object.keys(TYPES).sort(), ["albums", "artists", "tracks"]);
});

test("artists list: groups by artist key, orders by plays, paginates", () => {
  seed();
  const q = buildTopListQuery("artists", { where: null, params: [] }, { limit: 1, offset: 1 });
  const total = db.prepare(q.countSql).get(...q.countParams).total;
  const rows = db.prepare(q.rowsSql).all(...q.rowsParams);
  assert.equal(total, 2);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].artist, "Artist B"); // offset 1 skips the top artist
  assert.equal(rows[0].plays, 1);
});

test("albums list: requires a non-empty album and groups by artist+album", () => {
  const q = buildTopListQuery("albums", { where: null, params: [] }, { limit: 10, offset: 0 });
  const rows = db.prepare(q.rowsSql).all(...q.rowsParams);
  assert.equal(rows.length, 3); // Album X, Album Y, Album Z
  assert.equal(rows[0].album, "Album X");
  assert.equal(rows[0].plays, 2);
});

test("tracks list: groups by track+artist+album", () => {
  const q = buildTopListQuery("tracks", { where: null, params: [] }, { limit: 10, offset: 0 });
  const rows = db.prepare(q.rowsSql).all(...q.rowsParams);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].track, "Song 1");
  assert.equal(rows[0].plays, 2);
});

test("artist filter restricts the rows and the count", () => {
  const q = buildTopListQuery("tracks", { where: null, params: [] }, { limit: 10, offset: 0 }, "artist a");
  const total = db.prepare(q.countSql).get(...q.countParams).total;
  const rows = db.prepare(q.rowsSql).all(...q.rowsParams);
  assert.equal(total, 2); // Song 1 + Song 2 only
  assert.ok(rows.every(row => row.artist === "Artist A"));
});

test("period filter is combined with the type where clause", () => {
  const filter = { where: "played_at >= ? AND played_at <= ?", params: [NOW - 150, NOW] };
  const q = buildTopListQuery("artists", filter, { limit: 10, offset: 0 });
  assert.match(q.rowsSql, /WHERE/);
  const rows = db.prepare(q.rowsSql).all(...q.rowsParams);
  // only the play at NOW-100 of Artist A falls inside the window
  assert.equal(rows.length, 1);
  assert.equal(rows[0].artist, "Artist A");
  assert.equal(rows[0].plays, 1);
});
