const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Isolate the database AND the lock file before requiring the modules.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ylfm-sync-status-"));
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, "test.db");

const db = require("../src/db");
const { getSyncStatus } = require("../src/sync");

const LOCK_FILE = path.join(tmpDir, "sync.lock");
const setStatus = db.prepare(`
  INSERT INTO metadata (key, value) VALUES ('sync_status', ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

function writeRunningStatus() {
  setStatus.run(JSON.stringify({
    running: true,
    mode: "incremental",
    page: 0,
    totalPages: 1,
    inserted: 0,
    skipped: 0,
    message: "Connexion à ListenBrainz...",
    messageKey: "sync.connecting",
    updatedAt: Date.now()
  }));
}

test("getSyncStatus reports notStarted when no status was ever saved", () => {
  const status = getSyncStatus();
  assert.equal(status.running, false);
  assert.equal(status.messageKey, "sync.notStarted");
});

test("a persisted running status without a lock is reset as interrupted", () => {
  writeRunningStatus();
  const status = getSyncStatus();
  assert.equal(status.running, false);
  assert.equal(status.interrupted, true);
  assert.equal(status.messageKey, "sync.interrupted");

  // the reset is persisted, not recomputed on every read
  const again = getSyncStatus();
  assert.equal(again.running, false);
  assert.equal(again.messageKey, "sync.interrupted");
});

test("a persisted running status with a fresh lock is kept as running", () => {
  writeRunningStatus();
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ token: "t", pid: 1, startedAt: Date.now() }));

  const status = getSyncStatus();
  assert.equal(status.running, true);
  assert.equal(status.messageKey, "sync.connecting");
});

test("a persisted running status with a stale lock is reset and the lock removed", () => {
  writeRunningStatus();
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ token: "t", pid: 1, startedAt: Date.now() }));
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  fs.utimesSync(LOCK_FILE, old, old);

  const status = getSyncStatus();
  assert.equal(status.running, false);
  assert.equal(status.interrupted, true);
  assert.equal(fs.existsSync(LOCK_FILE), false, "stale lock file is removed");
});
