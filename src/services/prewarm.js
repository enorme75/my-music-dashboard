// Warms the persistent metadata caches (artist image, album cover, track
// duration) for freshly synced listens, so that the next dashboard / artist
// page build finds them already cached instead of paying the MusicBrainz /
// Cover Art Archive lookup latency on the request path.
const { mapWithConcurrency } = require("../utils/mapWithConcurrency");
const { mainArtist } = require("../utils/artistName");
const { ensureArtistImage } = require("./artistImageCache");
const { ensureAlbumCover } = require("./albumCoverCache");
const { ensureTrackDuration } = require("./trackDurationCache");

const MAX_ITEMS = Math.max(1, Number(process.env.PREWARM_MAX_ITEMS || 120));
const CONCURRENCY = Math.max(1, Number(process.env.PREWARM_CONCURRENCY || 2));

async function prewarmMetadata(listens) {
  const artists = new Set();
  const albums = new Set();
  const tracks = new Set();

  for (const listen of Array.isArray(listens) ? listens : []) {
    if (!listen?.artist || !listen?.track) continue;
    // Warm the caches under the main artist, which is the key used by the
    // aggregated views (ARTIST_GROUPING=main).
    const artist = mainArtist(listen.artist);
    artists.add(artist);
    if (listen.album) albums.add(`${artist}\u0000${listen.album}`);
    tracks.add(`${artist}\u0000${listen.track}`);
  }

  const tasks = [];
  for (const artist of artists) {
    tasks.push(() => ensureArtistImage(artist).catch(() => null));
  }
  for (const key of albums) {
    const [artist, album] = key.split("\u0000");
    tasks.push(() => ensureAlbumCover(artist, album).catch(() => null));
  }
  for (const key of tracks) {
    const [artist, track] = key.split("\u0000");
    tasks.push(() => ensureTrackDuration(artist, track).catch(() => null));
  }

  const bounded = tasks.slice(0, MAX_ITEMS);
  await mapWithConcurrency(bounded, CONCURRENCY, task => task());

  return {
    artists: artists.size,
    albums: albums.size,
    tracks: tracks.size,
    warmed: bounded.length
  };
}

module.exports = { prewarmMetadata };
