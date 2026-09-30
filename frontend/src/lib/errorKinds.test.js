import {
  ErrorKind,
  COOLDOWN_MS,
  classifyError,
  classifyHttp,
  isRetryable,
} from "./errorKinds";

function fakeRes(status, headers = {}) {
  return {
    status,
    headers: {
      get: (name) => headers[String(name).toLowerCase()] ?? null,
    },
  };
}

describe("classifyHttp / classifyError", () => {
  it("classifies 429 with Retry-After seconds", () => {
    const info = classifyHttp(fakeRes(429, { "retry-after": "37" }), "RATE_LIMIT", "Gemini");
    expect(info.kind).toBe(ErrorKind.RATE_LIMIT);
    expect(info.retryAfterMs).toBe(37000);
    expect(info.keyInvalid).toBe(false);
    expect(info.modelUnavailable).toBe(false);
  });

  it("extracts retryDelay from the body", () => {
    const info = classifyHttp(
      fakeRes(429),
      '{"error":{"status":"RESOURCE_EXHAUSTED","details":[{"retryDelay":"12s"}]}}',
      "Gemini"
    );
    expect(info.kind).toBe(ErrorKind.RATE_LIMIT);
    expect(info.retryAfterMs).toBe(12000);
  });

  it("uses a long cooldown for daily quota", () => {
    const info = classifyHttp(fakeRes(429), "Quota exceeded: PerDay per day", "Gemini");
    expect(info.kind).toBe(ErrorKind.RATE_LIMIT);
    expect(info.retryAfterMs).toBe(COOLDOWN_MS.DAILY);
  });

  it("falls back to a per-minute cooldown for 429 without hints", () => {
    const info = classifyHttp(fakeRes(429), "slow down", "Gemini");
    expect(info.retryAfterMs).toBe(COOLDOWN_MS.PER_MINUTE);
  });

  it("classifies 401 / API_KEY_INVALID as AUTH and flags the key", () => {
    const a = classifyHttp(fakeRes(401), "API_KEY_INVALID", "Gemini");
    expect(a.kind).toBe(ErrorKind.AUTH);
    expect(a.keyInvalid).toBe(true);

    const b = classifyHttp(fakeRes(400), "API key not valid. Please pass a valid API key.", "Gemini");
    expect(b.kind).toBe(ErrorKind.AUTH);
    expect(b.keyInvalid).toBe(true);
  });

  it("classifies 403 PERMISSION_DENIED as AUTH", () => {
    const info = classifyHttp(fakeRes(403), "PERMISSION_DENIED", "Gemini");
    expect(info.kind).toBe(ErrorKind.AUTH);
  });

  it("classifies 402 (OpenRouter credits) as AUTH", () => {
    const info = classifyHttp(fakeRes(402), "Insufficient credits", "OpenRouter");
    expect(info.kind).toBe(ErrorKind.AUTH);
  });

  it("classifies 404 and model-body errors as MODEL_UNAVAILABLE", () => {
    const a = classifyHttp(fakeRes(404), "not found", "Gemini");
    expect(a.kind).toBe(ErrorKind.MODEL_UNAVAILABLE);
    expect(a.modelUnavailable).toBe(true);

    const b = classifyHttp(
      fakeRes(400),
      "models/gemini-9.9 is not found for API version v1beta",
      "Gemini"
    );
    expect(b.kind).toBe(ErrorKind.MODEL_UNAVAILABLE);
  });

  it("classifies 5xx and UNAVAILABLE as OVERLOADED", () => {
    expect(classifyHttp(fakeRes(503), "", "Gemini").kind).toBe(ErrorKind.OVERLOADED);
    expect(classifyHttp(fakeRes(500), "internal error", "Gemini").kind).toBe(ErrorKind.OVERLOADED);
    expect(classifyHttp(fakeRes(200), "The model is overloaded", "Gemini").kind).toBe(
      ErrorKind.OVERLOADED
    );
  });

  it("classifies safety blocks as BLOCKED before BAD_RESPONSE", () => {
    const info = classifyError(null, { body: "Gemini returned no text (SAFETY)" });
    expect(info.kind).toBe(ErrorKind.BLOCKED);
    expect(isRetryable(info.kind)).toBe(false);
  });

  it("classifies no-text as BAD_RESPONSE", () => {
    const info = classifyError(new Error("Gemini returned no text"));
    expect(info.kind).toBe(ErrorKind.BAD_RESPONSE);
    expect(isRetryable(info.kind)).toBe(true);
  });

  it("classifies transport failures as NETWORK", () => {
    expect(classifyError(new TypeError("Failed to fetch")).kind).toBe(ErrorKind.NETWORK);
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(classifyError(abort).kind).toBe(ErrorKind.NETWORK);
  });

  it("classifies explicit stop as STOPPED and never retries it", () => {
    const stop = new Error("Stopped by user");
    stop.name = "StopError";
    stop.kind = ErrorKind.STOPPED;
    expect(classifyError(stop).kind).toBe(ErrorKind.STOPPED);
    expect(isRetryable(ErrorKind.STOPPED)).toBe(false);
  });

  it("falls back to UNKNOWN", () => {
    expect(classifyError(new Error("weird")).kind).toBe(ErrorKind.UNKNOWN);
  });

  it("passes through already-classified structured errors", () => {
    const info = classifyError({
      kind: ErrorKind.RATE_LIMIT,
      message: "already classified",
      retryAfterMs: 5000,
    });
    expect(info.kind).toBe(ErrorKind.RATE_LIMIT);
    expect(info.retryAfterMs).toBe(5000);
  });
});
