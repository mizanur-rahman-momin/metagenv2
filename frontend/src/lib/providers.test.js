import { generateWithFailover } from "./providers";
import { ErrorKind } from "./errorKinds";
import { __resetCache, getKey, hashKey, maskKey } from "./poolRegistry";

const KEY1 = "AAAA-key-one";
const KEY2 = "BBBB-key-two";

function res(status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    text: async () => text,
  };
}

function geminiOk(meta) {
  return {
    candidates: [
      {
        content: { parts: [{ text: JSON.stringify(meta) }] },
        finishReason: "STOP",
      },
    ],
  };
}

let calls = [];

function installFetch(handler) {
  calls = [];
  global.fetch = jest.fn(async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  });
}

function failover(overrides = {}) {
  return generateWithFailover({
    provider: "gemini",
    models: ["m1"],
    keys: [KEY1, KEY2],
    prompt: "p",
    base64: "x",
    mimeType: "image/jpeg",
    stopRef: { current: false },
    patient: false,
    ...overrides,
  });
}

beforeEach(() => {
  localStorage.clear();
  __resetCache();
});

afterEach(() => {
  delete global.fetch;
});

describe("generateWithFailover", () => {
  it("retries the next key when the first is rate-limited", async () => {
    installFetch((url) =>
      url.includes(`key=${KEY1}`)
        ? res(429, "RESOURCE_EXHAUSTED quota", { "retry-after": "30" })
        : res(200, geminiOk({ title: "T", description: "D", keywords: ["a"] }))
    );

    const out = await failover();
    expect(out.model).toBe("m1");
    expect(out.keyLabel).toBe(maskKey(KEY2));
    expect(out.meta.title).toBe("T");
    expect(getKey(hashKey(KEY1)).status).toBe("cooling");
  });

  it("moves to the next model when every key is rate-limited for the primary", async () => {
    installFetch((url) =>
      url.includes("/models/mA:")
        ? res(429, "RESOURCE_EXHAUSTED")
        : res(200, geminiOk({ title: "B", description: "D", keywords: [] }))
    );

    const out = await failover({ models: ["mA", "mB"] });
    expect(out.model).toBe("mB");
  });

  it("skips unavailable models without penalizing the key", async () => {
    installFetch((url) =>
      url.includes("/models/mDead:")
        ? res(404, '{"error":{"message":"model not found"}}')
        : res(200, geminiOk({ title: "Live", description: "D", keywords: [] }))
    );

    const out = await failover({ models: ["mDead", "mLive"] });
    expect(out.model).toBe("mLive");
    const k1 = getKey(hashKey(KEY1));
    expect(k1.failCount).toBe(0);
  });

  it("marks an AUTH key invalid and skips it on the next run", async () => {
    const handler = (url) =>
      url.includes(`key=${KEY1}`)
        ? res(401, "API key not valid. Please pass a valid API key.")
        : res(200, geminiOk({ title: "OK", description: "D", keywords: [] }));

    installFetch(handler);
    const first = await failover();
    expect(first.keyLabel).toBe(maskKey(KEY2));
    expect(getKey(hashKey(KEY1)).status).toBe("invalid");

    installFetch(handler);
    await failover();
    expect(calls.some((c) => c.url.includes(`key=${KEY1}`))).toBe(false);
  });

  it("treats SAFETY blocks as non-retryable with zero retries", async () => {
    installFetch(() =>
      res(200, { candidates: [], promptFeedback: { blockReason: "SAFETY" } })
    );

    await expect(failover()).rejects.toMatchObject({ kind: ErrorKind.BLOCKED });
    expect(calls.length).toBe(1);
  });

  it("honors stopRef before making any request", async () => {
    installFetch(() => res(200, geminiOk({ title: "x", description: "y", keywords: [] })));

    await expect(
      failover({ stopRef: { current: true } })
    ).rejects.toThrow(/Stopped/);
    expect(calls.length).toBe(0);
  });

  it("waits out a short cooldown in patient mode and then succeeds", async () => {
    let k1Calls = 0;
    installFetch((url) => {
      if (url.includes(`key=${KEY1}`)) {
        k1Calls += 1;
        if (k1Calls === 1) {
          return res(
            429,
            '{"error":{"status":"RESOURCE_EXHAUSTED","details":[{"retryDelay":"0.05s"}]}}'
          );
        }
      }
      return res(200, geminiOk({ title: "P", description: "D", keywords: [] }));
    });

    const out = await failover({ keys: [KEY1], patient: true });
    expect(out.keyLabel).toBe(maskKey(KEY1));
    expect(k1Calls).toBeGreaterThanOrEqual(2);
  });

  it("throws an aggregated error when everything is exhausted", async () => {
    installFetch(() => res(429, "RESOURCE_EXHAUSTED"));

    await expect(failover({ keys: [KEY1] })).rejects.toThrow(/exhausted/i);
  });
});
