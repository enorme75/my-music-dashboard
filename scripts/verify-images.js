#!/usr/bin/env node
// Audit and repair of cached artist / album images.
//
// History: images used to be cached from the blind first hit of fuzzy
// searches (Deezer limit=1 without name check, MusicBrainz fallback to the
// first result), which produced wrong visuals ("Nicked Drake" as Nick Drake's
// artist image, a Todd Terje cover on a Todd Rundgren album). Lookups are now
// verified by name; this script re-checks the images ALREADY stored in the
// database against the verified lookups and repairs the mismatches.
//
// Usage:
//   node scripts/verify-images.js                 # dry-run, artists + albums
//   node scripts/verify-images.js --apply         # write the repairs
//   node scripts/verify-images.js --artists       # artists only
//   node scripts/verify-images.js --albums        # albums only
//   node scripts/verify-images.js --limit 50      # cap per scope
//   node scripts/verify-images.js --only-artist "Nick Drake"
//   node scripts/verify-images.js --only-album "Todd Rundgren" --only-album-name "Runt"
//
// Scope: only Deezer-sourced URLs (dzcdn.net) are re-checked — they are the
// unverified ones. Legacy last.fm URLs (source-verified by the Last.fm API at
// the time) and manual uploads (/covers/albums/...) are never touched.
// Nothing is ever set to null: an entry is only replaced when a verified
// candidate exists and differs from the cached one.

require("dotenv").config();

const db = require("../src/db");
const { ARTIST_COLUMN } = require("../src/utils/artistName");
const { mapWithConcurrency } = require("../src/utils/mapWithConcurrency");
const { imageIdentity } = require("../src/utils/matchCandidates");
const { fetchArtistImage } = require("../src/services/deezerArtistImage");
const { getDeezerAlbumImage } = require("../src/services/deezer-album");
const { getAlbumImage } = require("../src/services/albumMetadata");
const { rememberArtistImage } = require("../src/services/artistImageCache");
const { rememberAlbumCover } = require("../src/services/albumCoverCache");
const { invalidateDashboardCache } = require("../src/services/dashboardCache");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const ONLY_ARTISTS = args.includes("--artists");
const ONLY_ALBUMS = args.includes("--albums");
const LIMIT = Number(argsValue("--limit") || 0) || null;
const ONLY_ARTIST = argsValue("--only-artist");
const ONLY_ALBUM_ARTIST = argsValue("--only-album");
const ONLY_ALBUM_NAME = argsValue("--only-album-name");

const CONCURRENCY = 3;
const PACING_MS = 120;

function argsValue(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const summary = {
  scope: [],
  artists: { checked: 0, ok: 0, fixed: 0, unresolved: 0, skipped: 0 },
  albums: { checked: 0, ok: 0, fixed: 0, upgraded: 0, unresolved: 0, skipped: 0 }
};
const changes = [];

async function verifyArtists() {
  if (ONLY_ALBUMS) return;
  let rows = db.prepare(`
    SELECT artist, artist_image
    FROM artists
    WHERE artist_image IS NOT NULL AND TRIM(artist_image) != ''
      AND artist_image LIKE '%dzcdn.net%'
    ORDER BY artist
  `).all();

  const legacy = db.prepare(`
    SELECT COUNT(*) AS c FROM artists
    WHERE artist_image IS NOT NULL AND TRIM(artist_image) != ''
      AND artist_image NOT LIKE '%dzcdn.net%'
  `).get().c;
  summary.artists.skipped += legacy;

  if (ONLY_ARTIST) rows = rows.filter(row => row.artist.toLowerCase() === ONLY_ARTIST.toLowerCase());
  if (LIMIT) rows = rows.slice(0, LIMIT);

  console.log(`\n[artists] ${rows.length} Deezer-cached images to verify (${legacy} legacy skipped, apply=${APPLY})`);

  await mapWithConcurrency(rows, CONCURRENCY, async row => {
    await sleep(PACING_MS);
    summary.artists.checked++;

    let verified;
    try {
      verified = await fetchArtistImage(row.artist);
    } catch {
      verified = null;
    }

    if (!verified) {
      summary.artists.unresolved++;
      console.log(`  UNRESOLVED ${row.artist} (cached kept: ${row.artist_image})`);
      return;
    }

    if (imageIdentity(verified) === imageIdentity(row.artist_image)) {
      summary.artists.ok++;
      return;
    }

    summary.artists.fixed++;
    changes.push({ kind: "artist", artist: row.artist, from: row.artist_image, to: verified });
    console.log(`  FIX ${row.artist}\n    from ${row.artist_image}\n    to   ${verified}`);
    if (APPLY) rememberArtistImage(row.artist, verified);
  });
}

async function verifyAlbums() {
  if (ONLY_ARTISTS) return;
  let rows = db.prepare(`
    SELECT ${ARTIST_COLUMN} AS artist, album, MAX(NULLIF(album_image, '')) AS img, COUNT(*) AS plays
    FROM scrobbles
    WHERE album_image IS NOT NULL AND TRIM(album_image) != ''
      AND album_image LIKE '%dzcdn.net%'
    GROUP BY ${ARTIST_COLUMN}, album
    ORDER BY plays DESC
  `).all();

  const other = db.prepare(`
    SELECT COUNT(DISTINCT album_image) AS c FROM scrobbles
    WHERE album_image IS NOT NULL AND TRIM(album_image) != ''
      AND album_image NOT LIKE '%dzcdn.net%'
  `).get().c;
  summary.albums.skipped += other;

  if (ONLY_ALBUM_ARTIST && ONLY_ALBUM_NAME) {
    rows = rows.filter(row => (
      row.artist.toLowerCase() === ONLY_ALBUM_ARTIST.toLowerCase()
      && row.album.toLowerCase() === ONLY_ALBUM_NAME.toLowerCase()
    ));
  }
  if (LIMIT) rows = rows.slice(0, LIMIT);

  console.log(`\n[albums] ${rows.length} Deezer-cached covers to verify (${other} legacy/local skipped, apply=${APPLY})`);

  await mapWithConcurrency(rows, CONCURRENCY, async row => {
    await sleep(PACING_MS);
    summary.albums.checked++;

    let verified;
    try {
      // Same trust order as the runtime: CAA via stored release MBID /
      // MusicBrainz release-group first, verified Deezer as fallback.
      verified = await getAlbumImage(row.artist, row.album);
      if (!verified) verified = await getDeezerAlbumImage(row.artist, row.album);
    } catch {
      verified = null;
    }

    if (!verified) {
      summary.albums.unresolved++;
      console.log(`  UNRESOLVED ${row.artist} - ${row.album} (cached kept: ${row.img})`);
      return;
    }

    if (imageIdentity(verified) === imageIdentity(row.img)) {
      summary.albums.ok++;
      return;
    }

    const upgraded = String(verified).includes("coverartarchive.org");
    if (upgraded) summary.albums.upgraded++; else summary.albums.fixed++;
    changes.push({ kind: "album", artist: row.artist, album: row.album, from: row.img, to: verified });
    console.log(`  ${upgraded ? "UPGRADE" : "FIX"} ${row.artist} - ${row.album}\n    from ${row.img}\n    to   ${verified}`);
    if (APPLY) rememberAlbumCover(row.artist, row.album, verified);
  });
}

(async () => {
  const startedAt = Date.now();
  if (!ONLY_ALBUMS) summary.scope.push("artists");
  if (!ONLY_ARTISTS) summary.scope.push("albums");

  console.log(`verify-images ${APPLY ? "APPLY" : "DRY-RUN"} — scope: ${summary.scope.join("+") || "all"}`);
  await verifyArtists();
  await verifyAlbums();

  if (APPLY && changes.length) {
    invalidateDashboardCache();
    console.log("\nDashboard cache invalidated.");
  }

  console.log("\n==== SUMMARY ====");
  console.log(JSON.stringify({ apply: APPLY, ...summary, changes: changes.length, durationMs: Date.now() - startedAt }, null, 2));
  process.exit(0);
})().catch(error => {
  console.error("verify-images failed:", error);
  process.exit(1);
});
