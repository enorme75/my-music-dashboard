const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "../data");

fs.mkdirSync(dataDir, { recursive: true });

const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(dataDir, "stats.db");

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("busy_timeout = 5000");
db.pragma("temp_store = MEMORY");
db.pragma("foreign_keys = ON");

db.prepare(`
  CREATE TABLE IF NOT EXISTS scrobbles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artist TEXT NOT NULL,
    track TEXT NOT NULL,
    track_duration INTEGER,
    album TEXT,
    album_image TEXT,
    played_at INTEGER NOT NULL,
    artist_mbid TEXT,
    release_mbid TEXT,
    recording_mbid TEXT,
    UNIQUE(artist, track, played_at)
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS artists (
    artist TEXT PRIMARY KEY,
    artist_image TEXT,
    updated_at INTEGER
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS deleted_scrobbles (
    artist TEXT NOT NULL,
    track TEXT NOT NULL,
    played_at INTEGER NOT NULL,
    PRIMARY KEY (artist, track, played_at)
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS artist_info (
    artist TEXT PRIMARY KEY,
    lang TEXT,
    bio TEXT,
    listenbrainz_url TEXT,
    updated_at INTEGER
  )
`).run();

// Migration from the Last.fm source: the artist_info.url column used to hold a
// last.fm URL. Rename it and drop the stale rows so they are re-fetched from
// ListenBrainz/MusicBrainz with fresh links.
const artistInfoColumns = db.prepare("PRAGMA table_info(artist_info)").all();
if (artistInfoColumns.some(column => column.name === "lastfm_url")) {
  db.prepare("ALTER TABLE artist_info RENAME COLUMN lastfm_url TO listenbrainz_url").run();
  db.prepare("DELETE FROM artist_info").run();
  console.log("✅ artist_info.lastfm_url renamed to listenbrainz_url (cache cleared)");
}

db.prepare(`
  CREATE TABLE IF NOT EXISTS album_info (
    artist TEXT NOT NULL,
    album TEXT NOT NULL,
    release_year INTEGER,
    updated_at INTEGER,
    PRIMARY KEY (artist, album)
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS discogs_links (
    kind TEXT NOT NULL,
    artist TEXT NOT NULL,
    album TEXT NOT NULL DEFAULT '',
    url TEXT,
    updated_at INTEGER,
    PRIMARY KEY (kind, artist, album)
  )
`).run();

const discogsColumns = db.prepare("PRAGMA table_info(discogs_links)").all();
if (!discogsColumns.some(column => column.name === "payload")) {
  db.prepare("ALTER TABLE discogs_links ADD COLUMN payload TEXT").run();
}

db.prepare(`
  CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS dashboard_cache (
    cache_key TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`).run();

// Leaderboard groups and API caches are intentionally stored in the same SQLite
// database so a container update never loses locally configured groups.
db.exec(`
  CREATE TABLE IF NOT EXISTS leaderboard_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS leaderboard_members (
    group_id INTEGER NOT NULL,
    username_key TEXT NOT NULL,
    username TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (group_id, username_key),
    FOREIGN KEY (group_id) REFERENCES leaderboard_groups(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS leaderboard_user_cache (
    username_key TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    realname TEXT,
    avatar TEXT,
    profile_url TEXT,
    playcount INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS leaderboard_chart_cache (
    cache_key TEXT PRIMARY KEY,
    username_key TEXT NOT NULL,
    chart_type TEXT NOT NULL,
    range_from INTEGER NOT NULL,
    range_to INTEGER NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS leaderboard_result_cache (
    cache_key TEXT PRIMARY KEY,
    group_id INTEGER NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (group_id) REFERENCES leaderboard_groups(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS leaderboard_album_cache (
    cache_key TEXT PRIMARY KEY,
    artist TEXT NOT NULL,
    album TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_leaderboard_members_group_position
  ON leaderboard_members (group_id, position);

  CREATE INDEX IF NOT EXISTS idx_leaderboard_chart_lookup
  ON leaderboard_chart_cache (username_key, chart_type, range_from, range_to);

  CREATE INDEX IF NOT EXISTS idx_leaderboard_result_group
  ON leaderboard_result_cache (group_id, created_at DESC);
`);

const scrobbleColumns = db.prepare("PRAGMA table_info(scrobbles)").all();
const hasTrackDuration = scrobbleColumns.some(column => column.name === "track_duration");

if (!hasTrackDuration) {
  db.prepare("ALTER TABLE scrobbles ADD COLUMN track_duration INTEGER").run();
  console.log("✅ Column track_duration added");
}

// Main-artist column used when ARTIST_GROUPING=main (default): featurings are
// stripped from the raw artist tag so stats group like Last.fm/ListenBrainz,
// which canonicalize listens to the recording's main artist. Always stores the
// extracted main artist (independent of the mode); read queries pick the
// artist_main or artist column depending on ARTIST_GROUPING.
const { extractMainArtist, mbidKey, textKey } = require("./utils/artistName");

if (!scrobbleColumns.some(column => column.name === "artist_main")) {
  db.prepare("ALTER TABLE scrobbles ADD COLUMN artist_main TEXT").run();
  console.log("✅ Column artist_main added");
}

const scrobbleColumnsAfterMain = db.prepare("PRAGMA table_info(scrobbles)").all();
if (!scrobbleColumnsAfterMain.some(column => column.name === "artist_key")) {
  db.prepare("ALTER TABLE scrobbles ADD COLUMN artist_key TEXT").run();
  console.log("✅ Column artist_key added");
}

// Backfill artist_main, then artist_key. The key is hybrid: if any scrobble of
// a main artist carries an artist MBID, the whole group is keyed "mbid:<mbid>"
// (what ListenBrainz does with its server-side mapping); otherwise the key is
// the normalized main-artist text. This only uses locally stored data — no
// external API call.
const backfillArtistColumns = db.transaction(() => {
  const mainRows = db.prepare(`
    SELECT DISTINCT artist
    FROM scrobbles
    WHERE artist_main IS NULL OR artist_main = ''
  `).all();
  const updateMain = db.prepare("UPDATE scrobbles SET artist_main = ? WHERE artist = ?");
  for (const row of mainRows) {
    updateMain.run(extractMainArtist(row.artist), row.artist);
  }

  // Map each main artist to its most frequent non-empty artist MBID.
  const mbidRows = db.prepare(`
    SELECT artist_main, artist_mbid, COUNT(*) AS c
    FROM scrobbles
    WHERE artist_mbid IS NOT NULL AND TRIM(artist_mbid) != ''
      AND artist_main IS NOT NULL AND TRIM(artist_main) != ''
    GROUP BY artist_main, artist_mbid
    ORDER BY artist_main, c DESC
  `).all();
  const mbidByMain = new Map();
  for (const row of mbidRows) {
    const key = String(row.artist_main).toLocaleLowerCase();
    if (!mbidByMain.has(key)) mbidByMain.set(key, row.artist_mbid);
  }

  const keyRows = db.prepare(`
    SELECT DISTINCT artist_main
    FROM scrobbles
    WHERE artist_key IS NULL OR artist_key = ''
  `).all();
  // Exact-match UPDATE so the artist_main index is used (COLLATE NOCASE would
  // force a full scan per artist). Case variants are covered because DISTINCT
  // returns each of them separately and textKey() is already lowercase.
  const updateKey = db.prepare(
    "UPDATE scrobbles SET artist_key = ? WHERE artist_main = ?"
  );
  for (const row of keyRows) {
    const main = String(row.artist_main || "").trim();
    if (!main) continue;
    const mbid = mbidByMain.get(main.toLocaleLowerCase());
    updateKey.run(mbid ? mbidKey(mbid) : textKey(main), main);
  }

  return { artists: mainRows.length, keys: keyRows.length };
});

const backfilled = backfillArtistColumns();
if (backfilled.artists > 0 || backfilled.keys > 0) {
  console.log(
    `✅ artist_main backfilled for ${backfilled.artists} artists, artist_key for ${backfilled.keys} main artists`
  );
}

// Assigns the grouping key for a freshly synced listen. If the main artist
// already has a key, reuse it; if the listen brings an MBID to a text-keyed
// group, rekey the whole group to the MBID (indexed UPDATE on artist_main).
// Lookups stay indexed: by normalized text key (case variants of a text-keyed
// group share the same lowercase key) and by exact artist_main (covers
// MBID-keyed groups, whose rows no longer carry the text key).
const getKeyByTextKeyStmt = db.prepare(
  "SELECT artist_key FROM scrobbles WHERE artist_key = ? LIMIT 1"
);
const getKeyByMainStmt = db.prepare(`
  SELECT artist_key
  FROM scrobbles
  WHERE artist_main = ? AND artist_key IS NOT NULL AND artist_key != ''
  LIMIT 1
`);
const rekeyByKeyStmt = db.prepare(
  "UPDATE scrobbles SET artist_key = ? WHERE artist_key = ?"
);

function assignArtistKey(artistMain, artistMbid) {
  const main = String(artistMain || "").trim();
  if (!main) return null;
  const mbid = mbidKey(artistMbid);
  const text = textKey(main);

  let existing = getKeyByTextKeyStmt.get(text)?.artist_key
    || getKeyByMainStmt.get(main)?.artist_key;

  if (existing) {
    if (mbid && existing !== mbid && !String(existing).startsWith("mbid:")) {
      // The group was text-keyed but now has an MBID: rekey it (indexed).
      rekeyByKeyStmt.run(mbid, existing);
      return mbid;
    }
    return existing;
  }
  return mbid || text;
}

// ListenBrainz migration: keep the MusicBrainz IDs carried by each listen so we
// can build exact listenbrainz.org links and Cover Art Archive covers.
// Rows imported from the previous Last.fm source simply keep NULL MBIDs.
const MBID_COLUMNS = ["artist_mbid", "release_mbid", "recording_mbid"];
for (const column of MBID_COLUMNS) {
  if (!scrobbleColumns.some(entry => entry.name === column)) {
    db.prepare(`ALTER TABLE scrobbles ADD COLUMN ${column} TEXT`).run();
    console.log(`✅ Column ${column} added`);
  }
}

const scrobblesTable = db.prepare(`
  SELECT sql
  FROM sqlite_master
  WHERE type = 'table' AND name = 'scrobbles'
`).get();

const hasInlineUniqueConstraint = /UNIQUE\s*\(\s*artist\s*,\s*track\s*,\s*played_at\s*\)/i
  .test(scrobblesTable?.sql || "");

if (hasInlineUniqueConstraint) {
  db.exec("DROP INDEX IF EXISTS idx_scrobble_unique");
} else {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_scrobble_unique
    ON scrobbles (artist, track, played_at)
  `);
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_scrobbles_played_at
  ON scrobbles (played_at DESC);

  CREATE INDEX IF NOT EXISTS idx_scrobbles_artist_played_at
  ON scrobbles (artist, played_at DESC);

  CREATE INDEX IF NOT EXISTS idx_scrobbles_artist_album
  ON scrobbles (artist, album);

  CREATE INDEX IF NOT EXISTS idx_scrobbles_artist_track
  ON scrobbles (artist, track);

  CREATE INDEX IF NOT EXISTS idx_scrobbles_artist_key
  ON scrobbles (artist_key);

  CREATE INDEX IF NOT EXISTS idx_scrobbles_artist_key_played_at
  ON scrobbles (artist_key, played_at DESC);

  CREATE INDEX IF NOT EXISTS idx_scrobbles_artist_main_played_at
  ON scrobbles (artist_main, played_at DESC);

  CREATE INDEX IF NOT EXISTS idx_scrobbles_artist_main_album
  ON scrobbles (artist_main, album);

  CREATE INDEX IF NOT EXISTS idx_scrobbles_artist_main_track
  ON scrobbles (artist_main, track);

  CREATE INDEX IF NOT EXISTS idx_scrobbles_release_mbid
  ON scrobbles (release_mbid);

  CREATE INDEX IF NOT EXISTS idx_scrobbles_recording_mbid
  ON scrobbles (recording_mbid);
`);

module.exports = db;
module.exports.dataDir = dataDir;
module.exports.dbPath = dbPath;
module.exports.assignArtistKey = assignArtistKey;
