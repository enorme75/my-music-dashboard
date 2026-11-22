const db = require("../db");
const { findReleaseGroup, getReleaseGroupTracks } = require("./musicbrainz");
const { getStoredAlbumCover, resolveCoverUrl } = require("./coverArtLookup");
const { getReleaseGroupCoverUrl } = require("../utils/coverArtArchive");
const { sanitizeError } = require("../utils/sanitizeAxios");

const COVER_SIZE = "500";

// Album cover: first from the release MBIDs stored with the listens (Cover Art
// Archive), then from the MusicBrainz release-group. Deezer is the last
// resort and is handled by albumCoverCache.
async function getAlbumImage(artist, album) {
  try {
    const stored = await getStoredAlbumCover(db, artist, album, COVER_SIZE);
    if (stored) return stored;

    const group = await findReleaseGroup(artist, album);
    if (group?.mbid) {
      const fromGroup = await resolveCoverUrl(getReleaseGroupCoverUrl(group.mbid, COVER_SIZE));
      if (fromGroup) return fromGroup;
    }
  } catch (error) {
    console.warn(`⚠️ [MusicBrainz/CAA] Album image failed: ${artist} - ${album}`, sanitizeError(error));
  }

  return null;
}

// Track list of an album via the MusicBrainz release-group.
async function getAlbumTracks(artist, album) {
  try {
    const group = await findReleaseGroup(artist, album);
    if (!group?.mbid) return null;

    const tracks = await getReleaseGroupTracks(group.mbid);
    if (!tracks.length) return null;

    return tracks.map(track => ({
      title: track.name,
      duration: track.duration
    }));
  } catch (error) {
    console.warn(`⚠️ [MusicBrainz] Album tracks failed: ${artist} - ${album}`, sanitizeError(error));
    return null;
  }
}

async function getAlbumInfo(artist, album) {
  const [image, tracks] = await Promise.all([
    getAlbumImage(artist, album),
    getAlbumTracks(artist, album)
  ]);

  return { image, tracks };
}

module.exports = { getAlbumImage, getAlbumInfo, getAlbumTracks };
