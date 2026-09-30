import {
  __resetCache,
  STORAGE_KEY,
  ensureKey,
  getKey,
  hashKey,
  isKeyUsable,
  isModelCooling,
  maskKey,
  orderKeys,
  pruneToKeys,
  recordFailure,
  recordSuccess,
  release,
  reserve,
  resetAll,
  resetKey,
  setKeyEnabled,
  snapshot,
  soonestCooldownDelay,
} from "./poolRegistry";
import { ErrorKind } from "./errorKinds";

const K1 = "AIzaSy-aaaaaaaaaaaaaaaa-1111";
const K2 = "AIzaSy-bbbbbbbbbbbbbbbb-2222";

beforeEach(() => {
  localStorage.clear();
  __resetCache();
});

describe("hashKey / maskKey", () => {
  it("is deterministic, distinct, and never equals the raw key", () => {
    const h1 = hashKey(K1);
    expect(h1).toBe(hashKey(K1));
    expect(h1).not.toBe(hashKey(K2));
    expect(h1).not.toContain(K1);
    expect(h1.length).toBeLessThan(K1.length);
  });

  it("masks the key", () => {
    const masked = maskKey(K1);
    expect(masked).toContain("…");
    expect(masked).not.toBe(K1);
    expect(masked.startsWith(K1.slice(0, 4))).toBe(true);
  });
});

describe("recordSuccess / recordFailure", () => {
  it("marks a key healthy and tracks latency (EMA)", () => {
    const h = hashKey(K1);
    recordSuccess(h, "m1", 200);
    recordSuccess(h, "m1", 400);
    const rec = getKey(h);
    expect(rec.status).toBe("healthy");
    expect(rec.successCount).toBe(2);
    expect(rec.avgLatencyMs).toBeGreaterThan(0);
    expect(rec.avgLatencyMs).toBeLessThan(400);
  });

  it("cools a key per (key, model) on RATE_LIMIT", () => {
    const h = hashKey(K1);
    recordFailure(h, "m1", ErrorKind.RATE_LIMIT, 60000);
    expect(getKey(h).status).toBe("cooling");
    expect(isKeyUsable(h, "m1")).toBe(false);
    expect(isKeyUsable(h, "m2")).toBe(true); // other model unaffected
    expect(isKeyUsable(h, "m1", Date.now() + 61000)).toBe(true);
  });

  it("auto-disables a key on AUTH", () => {
    const h = hashKey(K1);
    recordFailure(h, "m1", ErrorKind.AUTH, null);
    expect(getKey(h).status).toBe("invalid");
    expect(isKeyUsable(h, "m1")).toBe(false);
  });

  it("cools the model (not the key) on MODEL_UNAVAILABLE", () => {
    const h = hashKey(K1);
    ensureKey(h, maskKey(K1));
    recordFailure(h, "m1", ErrorKind.MODEL_UNAVAILABLE, null);
    expect(isModelCooling("m1")).toBe(true);
    const rec = getKey(h);
    expect(rec.failCount).toBe(0);
    expect(rec.status).toBe("unknown");
  });

  it("returns to healthy after a success", () => {
    const h = hashKey(K1);
    recordFailure(h, "m1", ErrorKind.OVERLOADED, 1000);
    expect(getKey(h).status).toBe("degraded");
    recordSuccess(h, "m1", 100);
    expect(getKey(h).status).toBe("healthy");
    expect(isKeyUsable(h, "m1")).toBe(true);
  });
});

describe("setKeyEnabled", () => {
  it("disables and re-enables a key", () => {
    const h = hashKey(K1);
    recordFailure(h, "m1", ErrorKind.AUTH, null);
    setKeyEnabled(h, true);
    expect(getKey(h).status).toBe("unknown");
    expect(isKeyUsable(h, "m1")).toBe(true);
    setKeyEnabled(h, false);
    expect(getKey(h).status).toBe("disabled");
    expect(isKeyUsable(h, "m1")).toBe(false);
  });
});

describe("orderKeys", () => {
  it("prefers lower in-flight, then latency, then least-recently-used", () => {
    const a = hashKey("key-a");
    const b = hashKey("key-b");
    const c = hashKey("key-c");
    ensureKey(a, "a");
    ensureKey(b, "b");
    ensureKey(c, "c");

    recordSuccess(a, "m1", 300);
    recordSuccess(b, "m1", 100);
    recordSuccess(c, "m1", 100);

    reserve(c); // c is busy → should sort last
    const ordered = orderKeys([a, b, c], "m1");
    expect(ordered[ordered.length - 1]).toBe(c);
    expect(ordered[0]).toBe(b); // faster than a
    release(c);
  });

  it("pushes cooling keys after usable ones", () => {
    const a = hashKey("key-a");
    const b = hashKey("key-b");
    ensureKey(a, "a");
    ensureKey(b, "b");
    recordFailure(a, "m1", ErrorKind.RATE_LIMIT, 60000);
    const ordered = orderKeys([a, b], "m1");
    expect(ordered[0]).toBe(b);
    expect(ordered[1]).toBe(a);
  });
});

describe("soonestCooldownDelay", () => {
  it("returns the smallest pending cooldown and ignores unusable keys", () => {
    const a = hashKey("a");
    const b = hashKey("b");
    const c = hashKey("c");
    ensureKey(a, "a");
    ensureKey(b, "b");
    ensureKey(c, "c");
    recordFailure(a, "m1", ErrorKind.RATE_LIMIT, 5000);
    recordFailure(b, "m1", ErrorKind.RATE_LIMIT, 30000);
    recordFailure(c, "m1", ErrorKind.AUTH, null);
    const delay = soonestCooldownDelay([a, b, c], ["m1"]);
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(5000);
  });

  it("returns null when nothing can recover", () => {
    const a = hashKey("a");
    recordFailure(a, "m1", ErrorKind.AUTH, null);
    expect(soonestCooldownDelay([a], ["m1"])).toBeNull();
  });
});

describe("reserve / release", () => {
  it("never leaks a negative in-flight count", () => {
    const h = hashKey(K1);
    reserve(h);
    reserve(h);
    expect(snapshot().keys.find((k) => k.hash === h).inflight).toBe(2);
    release(h);
    release(h);
    release(h);
    expect(snapshot().keys.find((k) => k.hash === h).inflight).toBe(0);
  });
});

describe("persistence", () => {
  it("round-trips through storage", () => {
    const h = hashKey(K1);
    ensureKey(h, maskKey(K1));
    recordSuccess(h, "m1", 123);
    __resetCache();
    const rec = getKey(h);
    expect(rec).not.toBeNull();
    expect(rec.successCount).toBe(1);
    expect(rec.label).toBe(maskKey(K1));
    // Raw key must never be persisted.
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain(K1);
  });

  it("prunes records for keys no longer present", () => {
    const h1 = hashKey(K1);
    const h2 = hashKey(K2);
    recordSuccess(h1, "m1", 100);
    recordSuccess(h2, "m1", 100);
    pruneToKeys([h1]);
    expect(getKey(h1)).not.toBeNull();
    expect(getKey(h2)).toBeNull();
  });

  it("resets a single key and all keys", () => {
    const h = hashKey(K1);
    recordSuccess(h, "m1", 100);
    resetKey(h);
    expect(getKey(h)).toBeNull();
    recordSuccess(h, "m1", 100);
    resetAll();
    expect(getKey(h)).toBeNull();
  });
});
