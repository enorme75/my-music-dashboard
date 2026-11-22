// Minimal in-memory TTL cache with single-flight loading: concurrent callers
// asking for the same key while a load is in flight share the same promise.
// Failures are cached for a short negative TTL so a struggling upstream is
// not hammered on every request.
function createTtlCache() {
  const entries = new Map();

  async function get(key, ttlMs, loader) {
    const entry = entries.get(key);
    if (entry) {
      if (entry.pending) return entry.pending;
      if (entry.expiresAt > Date.now()) {
        if (entry.error) throw entry.error;
        return entry.value;
      }
    }

    const pending = (async () => {
      try {
        const value = await loader();
        entries.set(key, { value, expiresAt: Date.now() + ttlMs });
        return value;
      } catch (error) {
        entries.set(key, {
          error,
          expiresAt: Date.now() + Math.min(ttlMs, 15000)
        });
        throw error;
      }
    })();

    entries.set(key, { pending });
    return pending;
  }

  function invalidate(key) {
    entries.delete(key);
  }

  function clear() {
    entries.clear();
  }

  return { get, invalidate, clear };
}

module.exports = { createTtlCache };
