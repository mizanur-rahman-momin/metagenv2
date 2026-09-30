// Pure error classification for provider calls.
// No DOM, no network, no React — safe to unit-test in isolation.

export const ErrorKind = Object.freeze({
  RATE_LIMIT: "RATE_LIMIT",
  AUTH: "AUTH",
  MODEL_UNAVAILABLE: "MODEL_UNAVAILABLE",
  OVERLOADED: "OVERLOADED",
  NETWORK: "NETWORK",
  BLOCKED: "BLOCKED",
  BAD_RESPONSE: "BAD_RESPONSE",
  STOPPED: "STOPPED",
  UNKNOWN: "UNKNOWN",
});

const KNOWN_KINDS = new Set(Object.values(ErrorKind));

// Retryable = worth spending another attempt/key on the SAME image.
// BLOCKED (content policy) and STOPPED (user) never are.
export const RETRYABLE_KINDS = new Set([
  ErrorKind.RATE_LIMIT,
  ErrorKind.OVERLOADED,
  ErrorKind.NETWORK,
  ErrorKind.BAD_RESPONSE,
]);

export const COOLDOWN_MS = {
  PER_MINUTE: 60 * 1000,
  DAILY: 30 * 60 * 1000,
  OVERLOAD_BASE: 5 * 1000,
  OVERLOAD_MAX: 5 * 60 * 1000,
};

const MAX_MESSAGE = 300;

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function has(lower, ...tokens) {
  return tokens.some((t) => lower.includes(t));
}

// "37s" / "37.5s" / `"retryDelay": "37s"` inside a JSON error body.
function parseRetryDelayBody(text) {
  if (!text) return null;
  const m = /"?retry[_-]?delay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)\s*s"?/i.exec(text);
  if (!m) return null;
  const secs = Number(m[1]);
  return Number.isFinite(secs) ? Math.round(secs * 1000) : null;
}

// Retry-After header: integer seconds or an HTTP-date.
export function parseRetryAfter(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const when = Date.parse(s);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return null;
}

function headerRetryAfter(err, options) {
  const direct = num(options.retryAfterMs) ?? num(err?.retryAfterMs);
  if (direct != null) return direct;
  const header =
    options.retryAfter ??
    err?.retryAfter ??
    err?.headers?.get?.("retry-after") ??
    err?.response?.headers?.get?.("retry-after");
  return parseRetryAfter(header);
}

function isStop(err) {
  if (!err) return false;
  if (err.kind === ErrorKind.STOPPED) return true;
  if (err.name === "StopError") return true;
  if (err.stopped === true) return true;
  return false;
}

function isAbort(err) {
  return err?.name === "AbortError" || err?.name === "TimeoutError";
}

function isTypeError(err) {
  return err instanceof TypeError || err?.name === "TypeError";
}

export function isKnownKind(kind) {
  return KNOWN_KINDS.has(kind);
}

export function isRetryable(kind) {
  return RETRYABLE_KINDS.has(kind);
}

function buildResult(kind, { retryAfterMs = null, httpStatus = null, message = "", body = "" } = {}) {
  return {
    kind,
    retryAfterMs: retryAfterMs == null ? null : Math.max(0, Math.round(retryAfterMs)),
    modelUnavailable: kind === ErrorKind.MODEL_UNAVAILABLE,
    keyInvalid: kind === ErrorKind.AUTH,
    httpStatus,
    message: String(message || body || kind).slice(0, MAX_MESSAGE),
  };
}

/**
 * Classify any thrown value (or raw status/body) into a structured error result.
 *
 * @param {any} err thrown error (may be null when using explicit httpStatus/body)
 * @param {{httpStatus?:number, body?:string, provider?:string, retryAfterMs?:number, retryAfter?:string}} [options]
 * @returns {{kind:string, retryAfterMs:number|null, modelUnavailable:boolean, keyInvalid:boolean, httpStatus:number|null, message:string}}
 */
export function classifyError(err, options = {}) {
  // Already classified (e.g. a ProviderError from providers.js) — pass through.
  const explicit = err?.kind;
  if (KNOWN_KINDS.has(explicit) && explicit !== ErrorKind.UNKNOWN) {
    return buildResult(explicit, {
      retryAfterMs: headerRetryAfter(err, options),
      httpStatus: num(err?.httpStatus) ?? num(options.httpStatus),
      message: err?.message,
    });
  }

  if (isStop(err)) {
    return buildResult(ErrorKind.STOPPED, { message: err?.message || "Stopped by user" });
  }

  const httpStatus = num(err?.httpStatus) ?? num(options.httpStatus) ?? num(err?.status);
  const body = String(options.body ?? err?.bodyText ?? err?.message ?? "");
  const lower = body.toLowerCase();
  const provider = options.provider ?? err?.provider;
  const retryAfterMs = headerRetryAfter(err, options);
  const bodyRetryDelay = parseRetryDelayBody(body);
  const effectiveRetry = retryAfterMs ?? bodyRetryDelay;

  // --- Definitive body tokens (override ambiguous statuses like 400) ---
  if (has(lower, "api_key_invalid", "api key not valid", "invalid api key", "invalid_api_key", "permission_denied", "permission denied")) {
    return buildResult(ErrorKind.AUTH, { httpStatus, message: body });
  }
  if (has(lower, "resource_exhausted", "resource exhausted", "rate limit", "rate_limit", "too many requests", "quota")) {
    return buildResult(ErrorKind.RATE_LIMIT, {
      httpStatus,
      retryAfterMs: rateLimitCooldown(lower, effectiveRetry),
      message: body,
    });
  }
  if (has(lower, "blockreason", "block_reason", "promptfeedback", "prohibited_content", "prohibited content", "recitation", "safety", "content policy", "content_policy")) {
    return buildResult(ErrorKind.BLOCKED, { httpStatus, message: body });
  }

  // --- Status-based classification ---
  if (httpStatus === 401 || httpStatus === 403) {
    return buildResult(ErrorKind.AUTH, { httpStatus, message: body });
  }
  if (httpStatus === 402) {
    // OpenRouter insufficient credits — key-level auth-like failure.
    return buildResult(ErrorKind.AUTH, { httpStatus, message: body || "Insufficient credits" });
  }
  if (httpStatus === 429) {
    return buildResult(ErrorKind.RATE_LIMIT, {
      httpStatus,
      retryAfterMs: rateLimitCooldown(lower, effectiveRetry),
      message: body,
    });
  }
  if (httpStatus === 404) {
    return buildResult(ErrorKind.MODEL_UNAVAILABLE, { httpStatus, message: body });
  }
  if (httpStatus === 500 || httpStatus === 502 || httpStatus === 503 || httpStatus === 504) {
    return buildResult(ErrorKind.OVERLOADED, { httpStatus, retryAfterMs: effectiveRetry, message: body });
  }

  // --- Remaining body tokens ---
  if (has(lower, "is not found for api version", "not supported for", "does not support", "unsupported model", "model not found", "no such model")) {
    return buildResult(ErrorKind.MODEL_UNAVAILABLE, { httpStatus, message: body });
  }
  if (has(lower, "overloaded", "over capacity", "try again later", "deadline exceeded", "unavailable")) {
    return buildResult(ErrorKind.OVERLOADED, { httpStatus, retryAfterMs: effectiveRetry, message: body });
  }
  if (has(lower, "returned no text", "returned no content", "empty model response", "invalid json", "unexpected token", "json parse")) {
    return buildResult(ErrorKind.BAD_RESPONSE, { httpStatus, message: body });
  }

  // --- Transport-level ---
  if (isAbort(err)) {
    return buildResult(ErrorKind.NETWORK, { httpStatus, message: err?.message || "Request timed out" });
  }
  if (isTypeError(err)) {
    return buildResult(ErrorKind.NETWORK, { httpStatus, message: err?.message || "Network request failed" });
  }
  if (has(lower, "failed to fetch", "network", "networkerror", "timed out", "timeout", "econnreset", "socket")) {
    return buildResult(ErrorKind.NETWORK, { httpStatus, message: body });
  }

  if (body || provider) {
    return buildResult(ErrorKind.UNKNOWN, { httpStatus, message: body || `Unknown ${provider} error` });
  }
  return buildResult(ErrorKind.UNKNOWN, { httpStatus, message: body });
}

function rateLimitCooldown(lower, effectiveRetry) {
  if (effectiveRetry != null) return effectiveRetry;
  if (has(lower, "perday", "per day", "free_tier", "free tier", "daily")) {
    return COOLDOWN_MS.DAILY;
  }
  return COOLDOWN_MS.PER_MINUTE;
}

/**
 * Classify a non-OK Response using its status, Retry-After header and body text.
 * Called from providers.js where the raw response is still available.
 */
export function classifyHttp(res, bodyText, provider) {
  const retryAfterMs = parseRetryAfter(res?.headers?.get?.("retry-after"));
  return classifyError(null, {
    httpStatus: res?.status,
    body: bodyText,
    provider,
    retryAfterMs,
  });
}
