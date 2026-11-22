require("dotenv").config();

const cors = require("cors");
const crypto = require("crypto");
const express = require("express");
const fs = require("fs/promises");
const multer = require("multer");
const path = require("path");
const { createCanvas, loadImage } = require("canvas");

const db = require("./db");
const { startSync, getSyncStatus } = require("./sync");
const { getActiveFilter } = require("./utils/filters");
const { fillMissingDates, getLocalDayModifier, parseTimezoneOffset } = require("./utils/dateRange");
const { mapWithConcurrency } = require("./utils/mapWithConcurrency");
const { sanitizeError } = require("./utils/sanitizeAxios");
const {
  MAX_LISTENS_PER_REQUEST,
  getListens,
  getPlayingNow,
  getUsername,
  normalizeListen
} = require("./utils/listenbrainz");
const { getUserListensUrl } = require("./utils/listenbrainzUrl");
const { getListenCoverUrl } = require("./utils/coverArtArchive");
const { deleteScrobbleLocally } = require("./services/scrobbleDeletion");
const { getArtistPage } = require("./services/artistPage");
const { getAlbumPage } = require("./services/albumPage");
const { searchLibrary } = require("./services/search");
const { getTrackPage } = require("./services/trackPage");
const { ensureAlbumCover } = require("./services/albumCoverCache");
const { ensureArtistImage } = require("./services/artistImageCache");
const { importScrobbleCSV } = require("./services/importScrobbleCSV");
const { exportScrobbleCSV } = require("./services/exportScrobbleCSV");
const { ensureTrackDuration } = require("./services/trackDurationCache");
const { getListenBrainzUserInfo } = require("./services/listenbrainz-user");
const { getRemoteImage } = require("./services/remoteImageCache");
const { getFriendsList, compareWithFriend } = require("./services/listenbrainz-friends");
const {
  createLeaderboardGroup,
  deleteLeaderboardGroup,
  getLeaderboardGroup,
  getLeaderboardItemDetails,
  getLeaderboardResult,
  listLeaderboardGroups,
  updateLeaderboardGroup
} = require("./services/leaderboards");
const { getDashboard, getInsights } = require("./services/dashboard");
const { invalidateDashboardCache } = require("./services/dashboardCache");
const {
  generateShareImage,
  ShareGenerationBusyError
} = require("./services/shareGenerator");
const ma = require("./services/musicAssistant");

const app = express();
const PORT = Math.max(1, Number(process.env.PORT) || 1533);
const AVG_TRACK_SECONDS = 180;
const EXTERNAL_REQUEST_CONCURRENCY = Number(process.env.EXTERNAL_REQUEST_CONCURRENCY || 4);
const publicDir = path.join(__dirname, "../public");
const albumCoversDir = path.join(db.dataDir, "covers/albums");
const allowedImageTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const STATIC_ASSET_CACHE_SECONDS = Math.max(0, Number(process.env.STATIC_ASSET_CACHE_SECONDS) || 300);

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function setNoStore(res) {
  res.set("Cache-Control", "no-store");
}

const PLAY_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const PLAY_RATE_LIMIT_MAX = 30;
const playRateLimitHits = new Map();

function checkPlayRateLimit(req) {
  const now = Date.now();
  const key = req.ip || req.socket?.remoteAddress || "unknown";
  const hits = (playRateLimitHits.get(key) || []).filter(ts => now - ts < PLAY_RATE_LIMIT_WINDOW_MS);
  if (hits.length >= PLAY_RATE_LIMIT_MAX) {
    playRateLimitHits.set(key, hits);
    return false;
  }
  hits.push(now);
  playRateLimitHits.set(key, hits);
  return true;
}

function parsePlayBody(body) {
  const artist = String(body?.artist || "").trim();
  const track = String(body?.track || "").trim();
  const queueId = String(body?.queue_id || "").trim();

  if (!artist || !track || artist.length > 200 || track.length > 200) {
    const error = new Error("artist and track are required (max 200 characters each)");
    error.statusCode = 400;
    throw error;
  }

  return { artist, track, queueId };
}

function parseAlbumPlayBody(body) {
  const artist = String(body?.artist || "").trim();
  const album = String(body?.album || "").trim();
  const queueId = String(body?.queue_id || "").trim();

  if (!artist || !album || artist.length > 200 || album.length > 200) {
    const error = new Error("artist and album are required (max 200 characters each)");
    error.statusCode = 400;
    throw error;
  }

  return { artist, album, queueId };
}

function getUploadErrorMessage(error) {
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    return "Uploaded file is too large";
  }

  return error.message || "Upload failed";
}

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => {
    const allowed = allowedImageTypes.has(file.mimetype);
    callback(allowed ? null : new Error("Type d'image non pris en charge"), allowed);
  }
});

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 }
});

const corsOrigin = process.env.CORS_ORIGIN?.trim();
if (corsOrigin) {
  const allowedOrigins = corsOrigin.split(",").map(origin => origin.trim()).filter(Boolean);
  app.use(cors({ origin: allowedOrigins }));
}

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use("/covers", express.static(path.join(db.dataDir, "covers"), {
  immutable: true,
  maxAge: "30d"
}));

app.get("/api/image-proxy", asyncRoute(async (req, res) => {
  const source = String(req.query.url || "").trim();
  if (!source) return res.status(400).json({ error: "Missing image URL" });

  const image = await getRemoteImage(source);
  if (req.headers["if-none-match"] === image.etag) return res.status(304).end();

  res.set({
    "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
    ETag: image.etag,
    "X-Content-Type-Options": "nosniff"
  });
  res.type(image.contentType).send(image.buffer);
}));

app.use(express.static(publicDir, {
  etag: true,
  lastModified: true,
  maxAge: STATIC_ASSET_CACHE_SECONDS * 1000,
  setHeaders(res, filePath) {
    if (filePath.endsWith("index.html")) {
      res.set("Cache-Control", "no-cache");
      return;
    }

    res.set(
      "Cache-Control",
      `public, max-age=${STATIC_ASSET_CACHE_SECONDS}, must-revalidate`
    );
  }
}));

app.get("/api/health", (req, res) => {
  const database = db.prepare("SELECT 1 AS ok").get();
  res.json({ ok: database.ok === 1, timestamp: Date.now() });
});

app.get("/api/dashboard", asyncRoute(async (req, res) => {
  setNoStore(res);
  const dashboard = await getDashboard(req.query);

  res.set({
    "X-Dashboard-Cache": dashboard.cache.hit ? "HIT" : "MISS",
    "X-Dashboard-Cache-Age": String(dashboard.cache.ageMs)
  });
  res.json(dashboard);
}));

app.get("/api/insights", asyncRoute(async (req, res) => {
  setNoStore(res);
  const insights = await getInsights(req.query);

  res.set({
    "X-Dashboard-Cache": insights.cache.hit ? "HIT" : "MISS",
    "X-Dashboard-Cache-Age": String(insights.cache.ageMs)
  });
  res.json(insights);
}));

app.get("/api/search", asyncRoute(async (req, res) => {
  setNoStore(res);
  const query = String(req.query.q || "").trim();

  if (query.length < 2 || query.length > 100) {
    const error = new Error("Search query must be between 2 and 100 characters");
    error.statusCode = 400;
    throw error;
  }

  res.json(searchLibrary(query));
}));

app.get("/api/track/:artist/:track", asyncRoute(async (req, res) => {
  setNoStore(res);

  const page = await getTrackPage(req.params.artist, req.params.track);

  if (!page || !page.track) {
    const error = new Error("Track not found in your library");
    error.statusCode = 404;
    throw error;
  }

  res.set({
    "X-Dashboard-Cache": page.cache.hit ? "HIT" : "MISS",
    "X-Dashboard-Cache-Age": String(page.cache.ageMs)
  });
  res.json(page);
}));

app.get("/api/artist/:name", asyncRoute(async (req, res) => {
  setNoStore(res);
  const lang = /^[a-z]{2}$/.test(String(req.query.lang || ""))
    ? String(req.query.lang)
    : "en";

  const page = await getArtistPage(req.params.name, { lang });

  if (!page || !page.artist) {
    const error = new Error("Artist not found in your library");
    error.statusCode = 404;
    throw error;
  }

  res.set({
    "X-Dashboard-Cache": page.cache.hit ? "HIT" : "MISS",
    "X-Dashboard-Cache-Age": String(page.cache.ageMs)
  });
  res.json(page);
}));

app.get("/api/album/:artist/:album", asyncRoute(async (req, res) => {
  setNoStore(res);

  const page = await getAlbumPage(req.params.artist, req.params.album);

  if (!page || !page.album) {
    const error = new Error("Album not found in your library");
    error.statusCode = 404;
    throw error;
  }

  res.set({
    "X-Dashboard-Cache": page.cache.hit ? "HIT" : "MISS",
    "X-Dashboard-Cache-Age": String(page.cache.ageMs)
  });
  res.json(page);
}));

app.get("/api/top-artists", asyncRoute(async (req, res) => {
  setNoStore(res);
  const filter = getActiveFilter(req.query);

  const rows = db.prepare(`
    SELECT artist, COUNT(*) AS plays
    FROM scrobbles
    ${filter.where ? `WHERE ${filter.where}` : ""}
    GROUP BY artist
    ORDER BY plays DESC
    LIMIT 10
  `).all(...filter.params);

  const result = await mapWithConcurrency(rows, EXTERNAL_REQUEST_CONCURRENCY, async row => ({
    ...row,
    image: await ensureArtistImage(row.artist).catch(() => null)
  }));

  res.json(result);
}));

app.get("/api/top-tracks", asyncRoute(async (req, res) => {
  setNoStore(res);
  const filter = getActiveFilter(req.query);

  const rows = db.prepare(`
    SELECT
      track,
      artist,
      album,
      MAX(NULLIF(album_image, '')) AS album_image,
      COUNT(*) AS plays
    FROM scrobbles
    WHERE album IS NOT NULL
      AND TRIM(album) != ''
      ${filter.where ? `AND ${filter.where}` : ""}
    GROUP BY track, artist, album
    ORDER BY plays DESC
    LIMIT 20
  `).all(...filter.params);

  const result = await mapWithConcurrency(rows, EXTERNAL_REQUEST_CONCURRENCY, async row => {
    const [duration, albumImage] = await Promise.all([
      ensureTrackDuration(row.artist, row.track),
      ensureAlbumCover(row.artist, row.album)
    ]);

    return {
      ...row,
      album_image: albumImage,
      total_seconds: duration * row.plays
    };
  });

  res.json(result);
}));

app.get("/api/last-sync", (req, res) => {
  setNoStore(res);
  const row = db.prepare(`
    SELECT value
    FROM metadata
    WHERE key = 'last_sync'
  `).get();

  res.json({
    timestamp: Number(row?.value || 0),
    status: getSyncStatus()
  });
});

app.get("/api/sync/status", (req, res) => {
  setNoStore(res);
  res.json(getSyncStatus());
});

app.post("/api/sync", asyncRoute(async (req, res) => {
  const task = startSync({ full: req.query.full === "true" });

  if (!task.started) {
    return res.status(409).json({
      success: false,
      running: true,
      status: task.status
    });
  }

  task.promise.catch(error => {
    console.error("Manual sync failed:", sanitizeError(error));
  });

  res.status(202).json({
    success: true,
    running: true,
    status: getSyncStatus()
  });
}));

app.get("/api/plays-per-day", (req, res) => {
  setNoStore(res);
  const filter = getActiveFilter(req.query);
  const useLocalDays = req.query.range === "day";
  const timezoneOffset = useLocalDays ? parseTimezoneOffset(req.query.tzOffset) : 0;
  const dayModifier = useLocalDays ? getLocalDayModifier(timezoneOffset) : null;

  const rows = db.prepare(`
    SELECT
      ${dayModifier ? "date(played_at, 'unixepoch', ?)" : "date(played_at, 'unixepoch')"} AS day,
      COUNT(*) AS plays
    FROM scrobbles
    ${filter.where ? `WHERE ${filter.where}` : ""}
    GROUP BY day
    ORDER BY day
  `).all(...(dayModifier ? [dayModifier] : []), ...filter.params);

  res.json(fillMissingDates(rows, req.query.range, req.query.year, req.query.month, timezoneOffset));
});

app.get("/api/summary", (req, res) => {
  setNoStore(res);
  const filter = getActiveFilter(req.query);

  const row = db.prepare(`
    SELECT
      COUNT(*) AS totalPlays,
      COUNT(DISTINCT date(played_at, 'unixepoch')) AS days,
      COALESCE(SUM(COALESCE(track_duration, ?)), 0) AS totalSeconds
    FROM scrobbles
    ${filter.where ? `WHERE ${filter.where}` : ""}
  `).get(AVG_TRACK_SECONDS, ...filter.params);

  res.json({
    totalPlays: row.totalPlays,
    totalMinutes: Math.round(row.totalSeconds / 60),
    avgPerDay: row.days ? (row.totalPlays / row.days).toFixed(1) : "0"
  });
});

app.get("/api/top-albums", asyncRoute(async (req, res) => {
  setNoStore(res);
  const filter = getActiveFilter(req.query);

  const albums = db.prepare(`
    SELECT
      artist,
      album,
      MAX(NULLIF(album_image, '')) AS album_image,
      COUNT(*) AS plays
    FROM scrobbles
    WHERE album IS NOT NULL
      AND TRIM(album) != ''
      ${filter.where ? `AND ${filter.where}` : ""}
    GROUP BY artist, album
    ORDER BY plays DESC
    LIMIT 12
  `).all(...filter.params);

  const result = await mapWithConcurrency(albums, EXTERNAL_REQUEST_CONCURRENCY, async album => ({
    ...album,
    album_image: await ensureAlbumCover(album.artist, album.album)
  }));

  res.json(result);
}));

app.post("/api/album-cover", (req, res, next) => {
  imageUpload.single("cover")(req, res, error => {
    if (error) return res.status(400).json({ error: getUploadErrorMessage(error) });
    next();
  });
}, asyncRoute(async (req, res) => {
  const artist = String(req.body.artist || "").trim();
  const album = String(req.body.album || "").trim();

  if (!artist || !album || !req.file) {
    return res.status(400).json({ error: "Payload invalide" });
  }

  let sourceImage;
  try {
    sourceImage = await loadImage(req.file.buffer);
  } catch {
    return res.status(400).json({ error: "Image invalide ou non prise en charge" });
  }

  const cropSize = Math.min(sourceImage.width, sourceImage.height);
  const outputSize = Math.max(1, Math.min(1000, Math.floor(cropSize)));
  const sourceX = Math.floor((sourceImage.width - cropSize) / 2);
  const sourceY = Math.floor((sourceImage.height - cropSize) / 2);
  const canvas = createCanvas(outputSize, outputSize);
  const context = canvas.getContext("2d");

  context.drawImage(
    sourceImage,
    sourceX,
    sourceY,
    cropSize,
    cropSize,
    0,
    0,
    outputSize,
    outputSize
  );

  const albumHash = crypto
    .createHash("sha1")
    .update(`${artist}\u0000${album}`)
    .digest("hex")
    .slice(0, 24);
  const imageBuffer = canvas.toBuffer("image/jpeg", {
    quality: 0.9,
    progressive: true
  });
  const contentHash = crypto
    .createHash("sha1")
    .update(imageBuffer)
    .digest("hex")
    .slice(0, 12);
  const fileName = `${albumHash}-${contentHash}.jpg`;
  const filePath = path.join(albumCoversDir, fileName);
  const previousCover = db.prepare(`
    SELECT MAX(NULLIF(album_image, '')) AS album_image
    FROM scrobbles
    WHERE artist = ? AND album = ?
  `).get(artist, album)?.album_image;

  await fs.mkdir(albumCoversDir, { recursive: true });
  await fs.writeFile(filePath, imageBuffer);

  const publicPath = `/covers/albums/${fileName}`;
  db.prepare(`
    UPDATE scrobbles
    SET album_image = ?
    WHERE artist = ? AND album = ?
  `).run(publicPath, artist, album);
  invalidateDashboardCache();

  if (previousCover?.startsWith("/covers/albums/") && previousCover !== publicPath) {
    const previousName = path.basename(previousCover);
    await fs.rm(path.join(albumCoversDir, previousName), { force: true });
  }

  res.json({ image: publicPath });
}));

app.post("/api/album-tracks", (req, res) => {
  const artist = String(req.body.artist || "").trim();
  const album = String(req.body.album || "").trim();

  if (!artist || !album) {
    return res.status(400).json({ error: "Payload invalide" });
  }

  const filter = getActiveFilter(req.query);
  const tracks = db.prepare(`
    SELECT track, COUNT(*) AS plays
    FROM scrobbles
    WHERE album = ?
      AND artist = ?
      ${filter.where ? `AND ${filter.where}` : ""}
    GROUP BY track
    ORDER BY plays DESC
  `).all(album, artist, ...filter.params);

  res.json(tracks);
});

app.get("/api/recent-scrobbles", asyncRoute(async (req, res) => {
  setNoStore(res);
  const parsedPage = Number.parseInt(req.query.page || "1", 10);
  const page = Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const parsedLimit = Number.parseInt(req.query.limit || "50", 10);
  const limit = Number.isInteger(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, 100)
    : 50;

  const username = getUsername();
  const deleteUrl = getUserListensUrl(username);

  const toItem = (listen, nowPlaying = false) => {
    const normalized = normalizeListen(listen);
    return {
      track: normalized.track,
      artist: normalized.artist || "Unknown artist",
      album: normalized.album,
      image: getListenCoverUrl(normalized, "500"),
      nowPlaying,
      date: normalized.playedAt ? normalized.playedAt * 1000 : null,
      delete_url: deleteUrl
    };
  };

  // ListenBrainz has no page parameter: fetch up to page*limit newest listens
  // by walking the max_ts cursor backwards, then slice the requested page.
  const target = page * limit;
  const collected = [];
  let cursorMax = 0;

  while (collected.length < target) {
    const wanted = Math.min(target - collected.length, MAX_LISTENS_PER_REQUEST);
    const payload = await getListens({ user: username, maxTs: cursorMax, count: wanted });
    const batch = Array.isArray(payload?.listens) ? payload.listens : [];
    if (!batch.length) break;

    collected.push(...batch);
    if (batch.length < wanted) break;

    const oldest = Math.min(...batch.map(listen => Number(listen?.listened_at) || 0));
    cursorMax = oldest - 1;
  }

  let tracks = collected
    .slice((page - 1) * limit, page * limit)
    .map(listen => toItem(listen));

  if (page === 1) {
    try {
      const playingNow = await getPlayingNow(username);
      if (playingNow) {
        tracks = [toItem(playingNow, true), ...tracks];
      }
    } catch (error) {
      console.warn("[ListenBrainz] playing-now unavailable:", sanitizeError(error).message);
    }
  }

  res.json({
    tracks,
    hasMore: collected.length >= target
  });
}));

app.get("/api/scrobbles", asyncRoute(async (req, res) => {
  setNoStore(res);
  const from = Number.parseInt(String(req.query.from || ""), 10);
  const to = Number.parseInt(String(req.query.to || ""), 10);
  const parsedPage = Number.parseInt(req.query.page || "1", 10);
  const parsedLimit = Number.parseInt(req.query.limit || "50", 10);

  if (!Number.isInteger(from) || !Number.isInteger(to) || from <= 0 || to <= from) {
    const error = new Error("Fenêtre de période invalide");
    error.statusCode = 400;
    throw error;
  }

  const page = Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const limit = Number.isInteger(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, 200)
    : 50;
  const offset = (page - 1) * limit;

  const { total } = db.prepare(`
    SELECT COUNT(*) AS total
    FROM scrobbles
    WHERE played_at >= ? AND played_at <= ?
  `).get(from, to);

  const rows = db.prepare(`
    SELECT track, artist, album, album_image, played_at
    FROM scrobbles
    WHERE played_at >= ? AND played_at <= ?
    ORDER BY played_at DESC
    LIMIT ? OFFSET ?
  `).all(from, to, limit, offset);

  res.json({
    total,
    hasMore: offset + rows.length < total,
    tracks: rows.map(row => ({
      track: row.track,
      artist: row.artist,
      album: row.album,
      image: row.album_image || null,
      date: row.played_at * 1000
    }))
  });
}));

app.delete("/api/scrobbles", asyncRoute(async (req, res) => {
  setNoStore(res);
  const { artist, track, date } = req.body || {};
  const playedAt = Math.floor(Number(date) / 1000);

  if (
    typeof artist !== "string" || !artist.trim() ||
    typeof track !== "string" || !track.trim() ||
    !Number.isInteger(playedAt) || playedAt <= 0
  ) {
    const error = new Error("Référence de scrobble invalide");
    error.statusCode = 400;
    throw error;
  }

  const deleted = deleteScrobbleLocally(artist.trim(), track.trim(), playedAt);

  res.json({ deleted });
}));

app.post("/api/import/scrobbles", (req, res, next) => {
  csvUpload.single("file")(req, res, error => {
    if (error) return res.status(400).json({ error: getUploadErrorMessage(error) });
    next();
  });
}, asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const result = await importScrobbleCSV(req.file.buffer);
  if (result.imported > 0) invalidateDashboardCache();
  res.json(result);
}));

app.get("/api/export/scrobbles", (req, res) => {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="scrobbles.csv"');
  exportScrobbleCSV(res);
});

app.get("/api/user-stats", asyncRoute(async (req, res) => {
  setNoStore(res);

  const [listenBrainzData, stats] = await Promise.all([
    getListenBrainzUserInfo(),
    Promise.resolve(db.prepare(`
      SELECT
        COUNT(*) AS totalScrobbles,
        COUNT(DISTINCT artist) AS uniqueArtists,
        (
          SELECT COUNT(*)
          FROM (
            SELECT artist, album
            FROM scrobbles
            WHERE album IS NOT NULL AND TRIM(album) != ''
            GROUP BY artist, album
          )
        ) AS uniqueAlbums,
        (
          SELECT COUNT(*)
          FROM (
            SELECT artist, track
            FROM scrobbles
            GROUP BY artist, track
          )
        ) AS uniqueTracks,
        MIN(played_at) AS joinedDate
      FROM scrobbles
    `).get())
  ]);

  res.json({
    username: listenBrainzData.name,
    avatar: listenBrainzData.avatar,
    ...stats
  });
}));

app.get("/api/generate-share", asyncRoute(async (req, res) => {
  setNoStore(res);

  try {
    const buffer = await generateShareImage(req.query);
    res.type("png").send(buffer);
  } catch (error) {
    if (error instanceof ShareGenerationBusyError) {
      return res.status(429).json({ error: error.message });
    }

    throw error;
  }
}));

app.get("/api/friends", asyncRoute(async (req, res) => {
  setNoStore(res);
  res.json(await getFriendsList());
}));

app.get("/api/friends/compare/:username", asyncRoute(async (req, res) => {
  setNoStore(res);
  const comparison = await compareWithFriend(db, req.params.username);

  if (comparison.error) {
    return res.status(502).json(comparison);
  }

  res.json(comparison);
}));

app.get("/api/leaderboards/groups", (req, res) => {
  setNoStore(res);
  res.json(listLeaderboardGroups());
});

app.get("/api/leaderboards/groups/:groupId", (req, res) => {
  setNoStore(res);
  res.json(getLeaderboardGroup(req.params.groupId));
});

app.post("/api/leaderboards/groups", asyncRoute(async (req, res) => {
  setNoStore(res);
  const group = await createLeaderboardGroup(req.body);
  res.status(201).json(group);
}));

app.put("/api/leaderboards/groups/:groupId", asyncRoute(async (req, res) => {
  setNoStore(res);
  const group = await updateLeaderboardGroup(req.params.groupId, req.body);
  res.json(group);
}));

app.delete("/api/leaderboards/groups/:groupId", (req, res) => {
  setNoStore(res);
  res.json(deleteLeaderboardGroup(req.params.groupId));
});

app.get("/api/leaderboards/groups/:groupId/results", asyncRoute(async (req, res) => {
  setNoStore(res);
  res.json(await getLeaderboardResult(req.params.groupId, req.query));
}));

app.get("/api/leaderboards/groups/:groupId/details", asyncRoute(async (req, res) => {
  setNoStore(res);
  res.json(await getLeaderboardItemDetails(req.params.groupId, req.query));
}));

app.get("/api/player/status", asyncRoute(async (req, res) => {
  setNoStore(res);
  res.json(await ma.getStatus());
}));

app.post("/api/play", asyncRoute(async (req, res) => {
  setNoStore(res);

  if (!checkPlayRateLimit(req)) {
    return res.status(429).json({ error: "Too many play requests, slow down", code: "rate_limited" });
  }

  const { artist, track, queueId } = parsePlayBody(req.body);

  if (!ma.isConfigured()) {
    return res.status(503).json({
      error: "Music Assistant is not configured (set MA_API_URL and MA_TOKEN)",
      code: "not_configured"
    });
  }

  const match = await ma.searchTrack(artist, track);
  if (!match) {
    return res.status(404).json({
      error: "Track not found in Music Assistant library",
      code: "not_found"
    });
  }

  const resolvedQueueId = await ma.resolveQueueId(queueId);
  await ma.playTrack(resolvedQueueId, match.uri);

  const players = await ma.listPlayers().catch(() => []);
  const player = players.find(entry => entry.queue_id === resolvedQueueId);

  res.json({
    ok: true,
    track: match,
    queue_id: resolvedQueueId,
    player_name: player?.name || resolvedQueueId
  });
}));

app.post("/api/play/availability", asyncRoute(async (req, res) => {
  setNoStore(res);

  if (!checkPlayRateLimit(req)) {
    return res.status(429).json({ error: "Too many requests, slow down", code: "rate_limited" });
  }

  if (!ma.isConfigured()) {
    return res.json({ configured: false, results: {} });
  }

  const rawTracks = Array.isArray(req.body?.tracks) ? req.body.tracks : [];
  const tracks = rawTracks
    .map(entry => ({
      artist: String(entry?.artist || "").trim(),
      track: String(entry?.track || "").trim()
    }))
    .filter(entry => entry.artist && entry.track && entry.artist.length <= 200 && entry.track.length <= 200);

  res.json({ configured: true, results: await ma.checkAvailability(tracks) });
}));

app.post("/api/play/album", asyncRoute(async (req, res) => {
  setNoStore(res);

  if (!checkPlayRateLimit(req)) {
    return res.status(429).json({ error: "Too many play requests, slow down", code: "rate_limited" });
  }

  const { artist, album, queueId } = parseAlbumPlayBody(req.body);

  if (!ma.isConfigured()) {
    return res.status(503).json({
      error: "Music Assistant is not configured (set MA_API_URL and MA_TOKEN)",
      code: "not_configured"
    });
  }

  const match = await ma.searchAlbum(artist, album);
  if (!match) {
    return res.status(404).json({
      error: "Album not found in Music Assistant library",
      code: "not_found"
    });
  }

  const resolvedQueueId = await ma.resolveQueueId(queueId);
  await ma.playAlbum(resolvedQueueId, match.uri);

  const players = await ma.listPlayers().catch(() => []);
  const player = players.find(entry => entry.queue_id === resolvedQueueId);

  res.json({
    ok: true,
    album: match,
    queue_id: resolvedQueueId,
    player_name: player?.name || resolvedQueueId
  });
}));

app.post("/api/play/album/availability", asyncRoute(async (req, res) => {
  setNoStore(res);

  if (!checkPlayRateLimit(req)) {
    return res.status(429).json({ error: "Too many requests, slow down", code: "rate_limited" });
  }

  if (!ma.isConfigured()) {
    return res.json({ configured: false, results: {} });
  }

  const rawAlbums = Array.isArray(req.body?.albums) ? req.body.albums : [];
  const albums = rawAlbums
    .map(entry => ({
      artist: String(entry?.artist || "").trim(),
      album: String(entry?.album || "").trim()
    }))
    .filter(entry => entry.artist && entry.album && entry.artist.length <= 200 && entry.album.length <= 200);

  res.json({ configured: true, results: await ma.checkAlbumAvailability(albums) });
}));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  console.error(`[${req.method} ${req.path}]`, sanitizeError(error));
  const parsedStatus = Number(error.statusCode || error.status || 500);
  const status = Number.isInteger(parsedStatus) && parsedStatus >= 400 && parsedStatus <= 599
    ? parsedStatus
    : 500;
  const message = status >= 500 ? "Internal server error" : error.message;
  res.status(status).json({
    error: message,
    ...(error.code ? { code: String(error.code) } : {})
  });
});

let server;

if (require.main === module) {
  server = app.listen(PORT, () => {
    console.log(`🚀 Dashboard running at http://localhost:${PORT}`);
  });
}

module.exports = { app, server };
