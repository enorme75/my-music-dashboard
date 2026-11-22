const test = require("node:test");
const assert = require("node:assert/strict");

const { createTtlCache } = require("../src/utils/ttlCache");

test("caches the loaded value until the TTL expires", async () => {
  const cache = createTtlCache();
  let loads = 0;

  const value = await cache.get("k", 60000, async () => {
    loads += 1;
    return "v";
  });
  const again = await cache.get("k", 60000, async () => {
    loads += 1;
    return "other";
  });

  assert.equal(value, "v");
  assert.equal(again, "v");
  assert.equal(loads, 1);
});

test("shares a single load between concurrent callers", async () => {
  const cache = createTtlCache();
  let loads = 0;

  const loader = async () => {
    loads += 1;
    await new Promise(resolve => setTimeout(resolve, 10));
    return loads;
  };

  const [a, b] = await Promise.all([
    cache.get("k", 60000, loader),
    cache.get("k", 60000, loader)
  ]);

  assert.equal(a, 1);
  assert.equal(b, 1);
  assert.equal(loads, 1);
});

test("reloads after the TTL and caches failures briefly", async () => {
  const cache = createTtlCache();
  let loads = 0;

  await assert.rejects(
    cache.get("k", 30, async () => {
      loads += 1;
      throw new Error("boom");
    })
  );
  // failure is cached: the loader is not called again immediately
  await assert.rejects(cache.get("k", 30, async () => "never"), /boom/);
  assert.equal(loads, 1);

  // after expiry the loader runs again
  await new Promise(resolve => setTimeout(resolve, 40));
  const value = await cache.get("k", 60000, async () => {
    loads += 1;
    return "ok";
  });
  assert.equal(value, "ok");
  assert.equal(loads, 2);
});

test("invalidate drops the entry", async () => {
  const cache = createTtlCache();
  let loads = 0;
  const loader = async () => {
    loads += 1;
    return loads;
  };

  assert.equal(await cache.get("k", 60000, loader), 1);
  cache.invalidate("k");
  assert.equal(await cache.get("k", 60000, loader), 2);
});
