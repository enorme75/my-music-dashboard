const axios = require("axios");
require("dotenv").config();

const { fetchWithRetry } = require("../utils/fetchRetry");
const { assertLastFmResponse } = require("../utils/lastfmResponse");
const { getLastFmImage } = require("../utils/lastfmImage");
const { sanitizeError } = require("../utils/sanitizeAxios");

const LASTFM_URL = "https://ws.audioscrobbler.com/2.0/";
const REQUEST_TIMEOUT = Number(process.env.LASTFM_REQUEST_TIMEOUT_MS || 15000);

async function getAlbumInfo(artist, album) {
  try {
    const response = await fetchWithRetry(async () => {
      const result = await axios.get(LASTFM_URL, {
        timeout: REQUEST_TIMEOUT,
        params: {
          method: "album.getinfo",
          api_key: process.env.LASTFM_API_KEY,
          artist,
          album,
          autocorrect: 1,
          format: "json"
        }
      });
      assertLastFmResponse(result.data);
      return result;
    });

    const albumData = response.data?.album || {};
    const tracks = Array.isArray(albumData.tracks?.track)
      ? albumData.tracks.track
      : albumData.tracks?.track
        ? [albumData.tracks.track]
        : [];

    return {
      image: getLastFmImage(albumData.image),
      tracks: tracks
        .map(track => ({
          title: String(track?.name || "").trim(),
          duration: Number(track?.duration || 0) || null
        }))
        .filter(track => track.title)
    };
  } catch (error) {
    console.warn(`⚠️ [Last.fm] Album info failed: ${artist} - ${album}`, sanitizeError(error));
    return null;
  }
}

async function getAlbumImage(artist, album) {
  const info = await getAlbumInfo(artist, album);
  return info?.image || null;
}

async function getAlbumTracks(artist, album) {
  const info = await getAlbumInfo(artist, album);
  return info?.tracks || null;
}

module.exports = { getAlbumInfo, getAlbumImage, getAlbumTracks };
