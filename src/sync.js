require("dotenv").config();

const fs = require("fs");
const path = require("path");

const db = require("./db");
const { fetchWithRetry } = require("./utils/fetchRetry");
const {
  MAX_LISTENS_PER_REQUEST,
  REQUEST_TIMEOUT,
  USER_AGENT,
  getListens,
  getUsername,
  normalizeListen,
  validateConfiguration
} = require("./utils/listenbrainz");
const { sanitizeError } = require("./utils/sanitizeAxios");
const { parseSyncCheckpoint, resolveSyncWindow } = require("./utils/syncWindow");
const { invalidateDashboardCache } = require("./services/dashboardCache");
const { isDeletedScrobble } = require("./services/scrobbleDeletion");
const { prewarmMetadata } = require("./services/prewarm");

const CONFIG = {
  REQUEST_DELAY: Math.max(0, Number(process.env.LISTENBRAINZ_REQUEST_DELAY_MS || 1000)),
  REQUEST_TIMEOUT,
  PER_PAGE: MAX_LISTENS_PER_REQUEST,
  OVERLAP_SECONDS: Number(process.env.SYNC_OVERLAP_SECONDS || 86400),
  STALE_LOCK_MS: Number(process.env.SYNC_STALE_LOCK_MS || 2 * 60 * 60 * 1000)
};

const LOCK_FILE = path.join(db.dataDir, "sync.lock");
const STATUS_KEY = "sync_status";
const CHECKPOINT_KEY = "sync_checkpoint";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const { extractMainArtist } = require("./utils/artistName");

const insertScrobble = db.prepare(`
  INSERT OR IGNORE INTO scrobbles (
    artist, track, album, played_at, track_duration,
    artist_mbid, release_mbid, recording_mbid, artist_main, artist_key
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// A listen already known locally (e.g. imported from the previous Last.fm
// source) still benefits from the MBIDs/duration carried by ListenBrainz.
const backfillScrobbleMetadata = db.prepare(`
  UPDATE scrobbles
  SET
    track_duration = COALESCE(?, track_duration),
    artist_mbid = COALESCE(?, artist_mbid),
    release_mbid = COALESCE(?, release_mbid),
    recording_mbid = COALESCE(?, recording_mbid),
    artist_main = COALESCE(?, artist_main),
    artist_key = COALESCE(?, artist_key)
  WHERE artist = ? AND track = ? AND played_at = ?
`);

const getLastPlayedAt = db.prepare(`
  SELECT MAX(played_at) AS last
  FROM scrobbles
`);

const setMetadata = db.prepare(`
  INSERT INTO metadata (key, value)
  VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

const getMetadata = db.prepare(`
  SELECT value
  FROM metadata
  WHERE key = ?
`);

const deleteMetadata = db.prepare(`
  DELETE FROM metadata
  WHERE key = ?
`);

const runSyncTransaction = db.transaction((listens, added) => {
  let inserted = 0;
  let skipped = 0;

  for (const raw of listens) {
    const listen = normalizeListen(raw);
    const { artist, track, album, playedAt, duration, artistMbid, releaseMbid, recordingMbid } = listen;

    if (!artist || !track || !Number.isInteger(playedAt) || playedAt <= 0) {
      skipped++;
      continue;
    }

    if (isDeletedScrobble(artist, track, playedAt)) {
      skipped++;
      continue;
    }

    const artistMain = extractMainArtist(artist);
    // Hybrid key: reuse the group's existing key, or key by MBID when the
    // listen carries one (rekeying the group if it was text-keyed), else text.
    const artistKey = db.assignArtistKey(artistMain, artistMbid);

    const result = insertScrobble.run(
      artist, track, album, playedAt, duration,
      artistMbid, releaseMbid, recordingMbid, artistMain, artistKey
    );

    if (result.changes > 0) {
      inserted++;
      if (Array.isArray(added)) added.push(listen);
    } else {
      backfillScrobbleMetadata.run(duration, artistMbid, releaseMbid, recordingMbid, artistMain, artistKey, artist, track, playedAt);
      skipped++;
    }
  }

  return { inserted, skipped };
});

let localSyncPromise = null;

function saveSyncStatus(status) {
  setMetadata.run(STATUS_KEY, JSON.stringify({
    ...status,
    updatedAt: Date.now()
  }));
}

function parseSyncStatus(row) {
  if (!row?.value) {
    return {
      running: false,
      mode: null,
      page: 0,
      totalPages: 0,
      inserted: 0,
      skipped: 0,
      message: "Pas commencé",
      messageKey: "sync.notStarted"
    };
  }

  try {
    return JSON.parse(row.value);
  } catch {
    return {
      running: false,
      mode: null,
      page: 0,
      totalPages: 0,
      inserted: 0,
      skipped: 0,
      message: "Statut inconnu",
      messageKey: "sync.unknown"
    };
  }
}

// A sync refreshes the lock file on every page, so a missing or stale lock
// means no sync is actually running (the writer process was killed or the
// server restarted) even though the persisted status still says "running".
function isSyncLockFresh() {
  try {
    return Date.now() - fs.statSync(LOCK_FILE).mtimeMs <= CONFIG.STALE_LOCK_MS;
  } catch {
    return false;
  }
}

function getSyncStatus() {
  let status = parseSyncStatus(getMetadata.get(STATUS_KEY));

  if (status.running && !isSyncLockFresh()) {
    removeStaleLock();
    status = {
      ...status,
      running: false,
      interrupted: true,
      message: "Synchronisation interrompue (processus arrêté)",
      messageKey: "sync.interrupted"
    };
    saveSyncStatus(status);
  }

  return status;
}

function removeStaleLock() {
  try {
    const stat = fs.statSync(LOCK_FILE);
    if (Date.now() - stat.mtimeMs <= CONFIG.STALE_LOCK_MS) return false;

    fs.unlinkSync(LOCK_FILE);
    console.warn("⚠️ Removed stale sync lock");
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function tryAcquireSyncLock() {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(LOCK_FILE, "wx");
      const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, startedAt: Date.now() }));
      return { fd, token };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (attempt === 0 && removeStaleLock()) continue;
      return null;
    }
  }

  return null;
}

function releaseSyncLock(lock) {
  try {
    if (lock?.fd !== null && lock?.fd !== undefined) fs.closeSync(lock.fd);
  } catch {}

  try {
    const currentLock = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
    if (currentLock.token === lock?.token) fs.unlinkSync(LOCK_FILE);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn("Could not remove sync lock:", error.message);
    }
  }
}

function refreshSyncLock(lock) {
  if (lock?.fd === null || lock?.fd === undefined) return;

  try {
    const now = new Date();
    fs.futimesSync(lock.fd, now, now);
  } catch (error) {
    console.warn("Could not refresh sync lock:", error.message);
  }
}

// One ListenBrainz "page": up to PER_PAGE listens inside [from, maxTs].
async function fetchListensPage({ from, maxTs }) {
  try {
    return await fetchWithRetry(async () => {
      const payload = await getListens({
        user: getUsername(),
        minTs: from,
        maxTs,
        count: CONFIG.PER_PAGE
      });
      return payload;
    });
  } catch (error) {
    console.error("[ListenBrainz sync error]", sanitizeError(error));
    throw error;
  }
}

async function runSync(options, lock) {
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const lastPlayedAt = Number(getLastPlayedAt.get()?.last || 0);
  const savedCheckpoint = parseSyncCheckpoint(getMetadata.get(CHECKPOINT_KEY)?.value);
  const window = resolveSyncWindow({
    full: options.full === true,
    currentTimestamp,
    lastPlayedAt,
    overlapSeconds: CONFIG.OVERLAP_SECONDS,
    checkpoint: savedCheckpoint
  });
  const isFullSync = window.mode === "full";
  const { mode, from, to, resumed } = window;

  setMetadata.run(CHECKPOINT_KEY, JSON.stringify({ mode, from, to }));

  console.log(
    resumed
      ? `↩️ Resuming ${mode} sync window from ${from} to ${to}...`
      : isFullSync
        ? "🔄 Starting FULL sync with ListenBrainz..."
        : `🔄 Starting incremental sync from ${from || "the beginning"}...`
  );

  let totalInserted = 0;
  let totalSkipped = 0;
  let currentPage = 0;
  let cursorMax = to;
  const startedAt = Date.now();
  const addedListens = [];

  saveSyncStatus({
    running: true,
    mode,
    page: 0,
    totalPages: 0,
    inserted: 0,
    skipped: 0,
    startedAt,
    resumed,
    from,
    to,
    message: resumed ? "Reprise de la synchronisation interrompue..." : "Connexion à ListenBrainz...",
    messageKey: resumed ? "sync.resuming" : "sync.connecting"
  });

  try {
    // ListenBrainz has no total page count: we walk the [from, to] window
    // backwards, one batch of PER_PAGE listens per request, until a batch
    // comes back short (or empty).
    for (;;) {
      currentPage += 1;
      const payload = await fetchListensPage({ from, maxTs: cursorMax });
      const batch = Array.isArray(payload?.listens) ? payload.listens : [];

      if (batch.length) {
        const result = runSyncTransaction(batch, addedListens);
        totalInserted += result.inserted;
        totalSkipped += result.skipped;
      }

      refreshSyncLock(lock);

      saveSyncStatus({
        running: true,
        mode,
        page: currentPage,
        totalPages: 0,
        inserted: totalInserted,
        skipped: totalSkipped,
        startedAt,
        resumed,
        from,
        to,
        message: `Synchronisation : ${totalInserted + totalSkipped} écoutes récupérées (batch ${currentPage})`,
        messageKey: "sync.batch",
        messageParams: { count: totalInserted + totalSkipped, page: currentPage }
      });

      if (currentPage === 1 || currentPage % 10 === 0) {
        console.log(`[batch ${currentPage}] ${totalInserted} new, ${totalSkipped} skipped`);
      }

      if (batch.length < CONFIG.PER_PAGE) break;

      const oldest = Math.min(...batch.map(listen => Number(listen?.listened_at) || 0));
      cursorMax = oldest - 1;
      if (cursorMax < from) break;

      if (CONFIG.REQUEST_DELAY > 0) {
        await sleep(CONFIG.REQUEST_DELAY);
      }
    }

    const finishedAt = Date.now();
    deleteMetadata.run(CHECKPOINT_KEY);
    setMetadata.run("last_sync", String(finishedAt));
    if (totalInserted > 0) {
      // Only new listens can change dashboard results; avoid invalidating the
      // cache on every scheduled run (which forced a full rebuild on the
      // next request). New items are warmed in the background so the rebuild
      // finds their metadata already cached.
      invalidateDashboardCache();
      prewarmMetadata(addedListens).catch(error => {
        console.warn("⚠️ Metadata prewarm failed:", error.message || error);
      });
    }
    saveSyncStatus({
      running: false,
      mode,
      page: currentPage,
      totalPages: 0,
      inserted: totalInserted,
      skipped: totalSkipped,
      startedAt,
      finishedAt,
      resumed,
      from,
      to,
      message: `Synchronisation terminée : ${totalInserted} nouveaux scrobbles`,
      messageKey: "sync.completed",
      messageParams: { count: totalInserted }
    });

    console.log(`✨ Sync finished - Total new scrobbles: ${totalInserted}`);

    return {
      started: true,
      running: false,
      mode,
      totalPages: currentPage,
      inserted: totalInserted,
      skipped: totalSkipped,
      resumed,
      from,
      to
    };
  } catch (error) {
    saveSyncStatus({
      running: false,
      mode,
      page: currentPage,
      totalPages: 0,
      inserted: totalInserted,
      skipped: totalSkipped,
      startedAt,
      failedAt: Date.now(),
      resumed,
      from,
      to,
      message: `${error.message || "Échec de la synchronisation"}. La même fenêtre sera retentée.`,
      messageKey: "sync.failedRetry",
      messageParams: { detail: error.message || "Sync failed" },
      error: true
    });
    throw error;
  } finally {
    releaseSyncLock(lock);
  }
}

function startSync(options = {}) {
  if (localSyncPromise) {
    return { started: false, promise: localSyncPromise, status: getSyncStatus() };
  }

  validateConfiguration();
  const lock = tryAcquireSyncLock();

  if (lock === null) {
    return {
      started: false,
      promise: null,
      status: {
        ...getSyncStatus(),
        running: true,
        message: "A synchronization is already running"
      }
    };
  }

  localSyncPromise = runSync(options, lock)
    .finally(() => {
      localSyncPromise = null;
    });

  return { started: true, promise: localSyncPromise, status: getSyncStatus() };
}

async function sync(options = {}) {
  const task = startSync(options);

  if (!task.started) {
    return {
      ...task.status,
      started: false,
      running: true
    };
  }

  return task.promise;
}

module.exports = { sync, startSync, getSyncStatus };
