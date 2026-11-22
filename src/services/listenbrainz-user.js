require("dotenv").config();

const {
  getUserToken,
  getUsername,
  validateToken
} = require("../utils/listenbrainz");

const CACHE_TTL_MS = 10 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 1000;

let cachedUser = null;
let cacheExpiresAt = 0;
let inFlight = null;
let lastTokenWarning = 0;

// ListenBrainz profiles have no avatar; the UI falls back to its placeholder.
async function fetchListenBrainzUserInfo() {
  const username = getUsername();
  if (!username) throw new Error("LISTENBRAINZ_USERNAME is not configured");

  const token = getUserToken();
  if (token && Date.now() - lastTokenWarning > 60 * 1000) {
    try {
      const validation = await validateToken(token);
      if (!validation.valid) {
        lastTokenWarning = Date.now();
        console.warn("⚠️ LISTENBRAINZ_USER_TOKEN was rejected by ListenBrainz (validate-token)");
      }
    } catch (error) {
      lastTokenWarning = Date.now();
      console.warn("⚠️ Could not validate LISTENBRAINZ_USER_TOKEN:", error.message);
    }
  }

  return { name: username, avatar: null };
}

async function getListenBrainzUserInfo() {
  if (cachedUser && cacheExpiresAt > Date.now()) return cachedUser;
  if (inFlight) return inFlight;

  inFlight = fetchListenBrainzUserInfo()
    .then(user => {
      cachedUser = user;
      cacheExpiresAt = Date.now() + CACHE_TTL_MS;
      return user;
    })
    .catch(error => {
      console.warn("Error getting data from ListenBrainz:", error.message);
      cacheExpiresAt = Date.now() + FAILURE_TTL_MS;
      cachedUser ||= { name: getUsername() || "User", avatar: null };
      return cachedUser;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

module.exports = { getListenBrainzUserInfo };
