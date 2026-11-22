require("dotenv").config();

const db = require("./db");
const { sync } = require("./sync");
const { getListenCount, getUsername } = require("./utils/listenbrainz");
const { sanitizeError } = require("./utils/sanitizeAxios");
const { getDeletedScrobblesCount } = require("./services/scrobbleDeletion");

const MISSING_THRESHOLD = Math.max(
  1,
  Number.parseInt(process.env.INTEGRITY_MISSING_THRESHOLD || "1", 10) || 1
);

const getLocalCount = db.prepare("SELECT COUNT(*) AS count FROM scrobbles");

async function getRemoteListenCount() {
  const count = await getListenCount(getUsername());
  return count;
}

async function verifyIntegrity() {
  try {
    const listenbrainzCount = await getRemoteListenCount();
    const localCount = getLocalCount.get().count;
    const deletedCount = getDeletedScrobblesCount();
    const difference = listenbrainzCount - deletedCount - localCount;
    const missingLocally = Math.max(0, difference);
    const extraLocally = Math.max(0, -difference);

    console.log(
      `[Integrity] ListenBrainz=${listenbrainzCount} Local=${localCount} Missing locally=${missingLocally} Extra locally=${extraLocally}`
    );

    if (missingLocally < MISSING_THRESHOLD) {
      return { checked: true, repaired: false, listenbrainzCount, localCount, missingLocally, extraLocally };
    }

    console.log(
      `[Integrity] Missing history detected (threshold=${MISSING_THRESHOLD}), running full sync`
    );

    const syncResult = await sync({ full: true });
    if (syncResult.started === false) {
      return {
        checked: true,
        repaired: false,
        deferred: true,
        listenbrainzCount,
        localCount,
        missingLocally,
        extraLocally
      };
    }

    const repairedLocalCount = getLocalCount.get().count;
    const remainingMissing = Math.max(0, listenbrainzCount - deletedCount - repairedLocalCount);

    console.log(
      `[Integrity] Repair finished. Local=${repairedLocalCount} Remaining missing=${remainingMissing}`
    );

    return {
      checked: true,
      repaired: true,
      listenbrainzCount,
      localCount: repairedLocalCount,
      missingLocally: remainingMissing,
      extraLocally: Math.max(0, repairedLocalCount - listenbrainzCount)
    };
  } catch (error) {
    console.error("[Integrity check error]", sanitizeError(error));
    return { checked: false, error: error.message };
  }
}

module.exports = { verifyIntegrity };
