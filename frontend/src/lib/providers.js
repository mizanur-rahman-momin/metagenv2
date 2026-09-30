// Direct browser calls to Gemini & OpenRouter using the user's own API keys.

import { ErrorKind, classifyError, classifyHttp } from "./errorKinds";
import {
  ensureKey,
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
  soonestCooldownDelay,
} from "./poolRegistry";

const DEFAULT_IMAGE_TIMEOUT_MS = 60_000;
export const PING_TIMEOUT_MS = 15_000;

// Patience: after the normal attempts are exhausted, wait out short
// per-minute cooldowns and try again instead of failing the image. Daily-quota
// cooldowns (longer than MAX_PATIENT_WAIT_MS) are not waited on.
export const MAX_PATIENT_WAIT_MS = 90_000;
export const MAX_PATIENT_TOTAL_MS = 300_000;

const BLOCK_REASONS = new Set([
  "SAFETY",
  "RECITATION",
  "PROHIBITED_CONTENT",
  "BLOCKED",
  "BLOCKLIST",
  "SPII",
  "IMAGE_SAFETY",
]);

// Structured error so status / headers / body survive to the classifier.
export class ProviderError extends Error {
  constructor(message, info = {}) {
    super(message || info.message || "Provider error");
    this.name = "ProviderError";
    this.kind = info.kind || ErrorKind.UNKNOWN;
    this.httpStatus = info.httpStatus ?? null;
    this.bodyText = info.bodyText ?? "";
    this.retryAfterMs = info.retryAfterMs ?? null;
    this.modelUnavailable = !!info.modelUnavailable;
    this.keyInvalid = !!info.keyInvalid;
  }
}

function stopError() {
  const e = new Error("Stopped by user");
  e.name = "StopError";
  e.kind = ErrorKind.STOPPED;
  return e;
}

function providerErrorFromHttp(res, bodyText, provider) {
  const info = classifyHttp(res, bodyText, provider);
  return new ProviderError(`${provider} ${res.status}: ${String(bodyText).slice(0, 300)}`, {
    kind: info.kind,
    httpStatus: res?.status ?? null,
    bodyText,
    retryAfterMs: info.retryAfterMs,
    modelUnavailable: info.modelUnavailable,
    keyInvalid: info.keyInvalid,
  });
}

// Link an external (stop) signal with a per-request timeout into one signal.
function linkSignal(externalSignal, timeoutMs) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (externalSignal) {
    if (externalSignal.aborted) ctrl.abort();
    else externalSignal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = timeoutMs
    ? setTimeout(() => ctrl.abort(), timeoutMs)
    : null;
  return {
    signal: ctrl.signal,
    cleanup() {
      if (timer) clearTimeout(timer);
      externalSignal?.removeEventListener?.("abort", onAbort);
    },
  };
}

async function doFetch(url, init, { signal, timeoutMs }) {
  const link = linkSignal(signal, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: link.signal });
  } catch (e) {
    if (e?.name === "AbortError") {
      if (signal?.aborted) throw stopError();
      const te = new Error("Request timed out");
      te.name = "TimeoutError";
      te.kind = ErrorKind.NETWORK;
      throw te;
    }
    throw e;
  } finally {
    link.cleanup();
  }
}

function parseMeta(text) {
  if (!text) throw new Error("Empty model response");
  let s = text.trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    s = s.slice(first, last + 1);
  }
  const obj = JSON.parse(s);
  let keywords = obj.keywords || [];
  if (typeof keywords === "string") {
    keywords = keywords.split(",").map((k) => k.trim());
  }
  keywords = keywords.map((k) => String(k).trim()).filter(Boolean);
  return {
    title: String(obj.title || "").trim(),
    description: String(obj.description || "").trim(),
    keywords,
  };
}

function parseJsonBody(bodyText, provider) {
  try {
    return JSON.parse(bodyText);
  } catch {
    throw new ProviderError(`${provider} returned invalid JSON`, {
      kind: ErrorKind.BAD_RESPONSE,
      bodyText: String(bodyText).slice(0, 300),
    });
  }
}

export async function geminiCall({
  model,
  apiKey,
  base64,
  mimeType,
  prompt,
  signal,
  timeoutMs = DEFAULT_IMAGE_TIMEOUT_MS,
}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await doFetch(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { inline_data: { mime_type: mimeType, data: base64 } },
              { text: prompt },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.4,
          responseMimeType: "application/json",
        },
      }),
    },
    { signal, timeoutMs }
  );

  const bodyText = await res.text();
  if (!res.ok) throw providerErrorFromHttp(res, bodyText, "Gemini");

  const data = parseJsonBody(bodyText, "Gemini");
  const cand = data?.candidates?.[0];
  const text =
    cand?.content?.parts?.map((p) => p.text || "").join("") || "";
  if (!text) {
    const reason = cand?.finishReason || data?.promptFeedback?.blockReason || "";
    const blocked = BLOCK_REASONS.has(String(reason).toUpperCase());
    throw new ProviderError(
      `Gemini returned no text${reason ? ` (${reason})` : ""}`,
      {
        kind: blocked ? ErrorKind.BLOCKED : ErrorKind.BAD_RESPONSE,
        httpStatus: res.status,
        bodyText: reason,
      }
    );
  }
  try {
    return parseMeta(text);
  } catch (e) {
    throw new ProviderError(`Gemini response not usable: ${e.message}`, {
      kind: ErrorKind.BAD_RESPONSE,
      bodyText: String(text).slice(0, 300),
    });
  }
}

export async function openrouterCall({
  model,
  apiKey,
  dataUrl,
  prompt,
  signal,
  timeoutMs = DEFAULT_IMAGE_TIMEOUT_MS,
}) {
  const referer =
    typeof window !== "undefined" && window.location
      ? window.location.origin
      : "https://stockmeta.app";
  const res = await doFetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": referer,
        "X-Title": "StockMeta",
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    },
    { signal, timeoutMs }
  );

  const bodyText = await res.text();
  if (!res.ok) throw providerErrorFromHttp(res, bodyText, "OpenRouter");

  const data = parseJsonBody(bodyText, "OpenRouter");
  const text = data?.choices?.[0]?.message?.content || "";
  if (!text) {
    throw new ProviderError("OpenRouter returned no content", {
      kind: ErrorKind.BAD_RESPONSE,
      httpStatus: res.status,
      bodyText: String(bodyText).slice(0, 300),
    });
  }
  try {
    return parseMeta(text);
  } catch (e) {
    throw new ProviderError(`OpenRouter response not usable: ${e.message}`, {
      kind: ErrorKind.BAD_RESPONSE,
      bodyText: String(text).slice(0, 300),
    });
  }
}

// Backwards-compatible single-shot dispatcher.
export async function generateMetadata({
  provider,
  model,
  apiKey,
  base64,
  dataUrl,
  mimeType,
  prompt,
  signal,
  timeoutMs,
}) {
  if (provider === "gemini") {
    return geminiCall({ model, apiKey, base64, mimeType, prompt, signal, timeoutMs });
  }
  return openrouterCall({ model, apiKey, dataUrl, prompt, signal, timeoutMs });
}

async function geminiPing({ model, apiKey, signal, timeoutMs }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await doFetch(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: "ping" }] }],
        generationConfig: { maxOutputTokens: 1, temperature: 0 },
      }),
    },
    { signal, timeoutMs }
  );
  const bodyText = await res.text();
  if (!res.ok) throw providerErrorFromHttp(res, bodyText, "Gemini");
  return true;
}

async function openrouterPing({ model, apiKey, signal, timeoutMs }) {
  const referer =
    typeof window !== "undefined" && window.location
      ? window.location.origin
      : "https://stockmeta.app";
  const res = await doFetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": referer,
        "X-Title": "StockMeta",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        temperature: 0,
        messages: [{ role: "user", content: "ping" }],
      }),
    },
    { signal, timeoutMs }
  );
  const bodyText = await res.text();
  if (!res.ok) throw providerErrorFromHttp(res, bodyText, "OpenRouter");
  return true;
}

// Minimal text-only probe — never sends an image. Resolves to a result object.
export async function testKey(
  provider,
  key,
  model,
  { signal, timeoutMs = PING_TIMEOUT_MS } = {}
) {
  const t0 = Date.now();
  try {
    if (provider === "gemini") {
      await geminiPing({ model, apiKey: key, signal, timeoutMs });
    } else {
      await openrouterPing({ model, apiKey: key, signal, timeoutMs });
    }
    return { ok: true, kind: null, latencyMs: Date.now() - t0, message: "" };
  } catch (e) {
    const info = classifyError(e);
    return {
      ok: false,
      kind: info.kind,
      latencyMs: Date.now() - t0,
      message: info.message,
    };
  }
}

function makeThrottledEmitter(onEvent, intervalMs = 250) {
  if (typeof onEvent !== "function") {
    return { push() {}, flush() {} };
  }
  let last = 0;
  let pending = null;
  let timer = null;
  const fire = () => {
    last = Date.now();
    const ev = pending;
    pending = null;
    if (ev) onEvent(ev);
  };
  return {
    push(ev) {
      const t = Date.now();
      if (t - last >= intervalMs) {
        pending = ev;
        fire();
      } else {
        pending = ev;
        if (!timer) timer = setTimeout(() => {
          timer = null;
          fire();
        }, intervalMs - (t - last));
      }
    },
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (pending) fire();
    },
  };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(id);
      signal?.removeEventListener?.("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(stopError());
    };
    const id = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    if (signal) {
      if (signal.aborted) {
        cleanup();
        reject(stopError());
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
  });
}

/**
 * Drive one image through the ordered model chain + key pool until it succeeds.
 *
 * @param {object} opts
 * @param {boolean} [opts.patient] wait out short cooldowns and keep retrying
 * @param {Function} [opts.sleepFn] test seam for the waiter
 * @returns {{meta:{title,description,keywords}, keyHash:string, keyLabel:string, model:string}}
 */
export async function generateWithFailover({
  provider,
  models,
  keys,
  prompt,
  base64,
  dataUrl,
  mimeType,
  stopRef,
  onEvent,
  signal,
  timeoutMs = DEFAULT_IMAGE_TIMEOUT_MS,
  patient = true,
  sleepFn = sleep,
}) {
  const chain = [...new Set((models || []).map((m) => String(m || "").trim()).filter(Boolean))];
  const rawKeys = [...new Set((keys || []).map((k) => String(k || "").trim()).filter(Boolean))];

  if (!chain.length) throw new Error("No model configured.");
  if (!rawKeys.length) throw new Error("No API key configured.");

  const entries = rawKeys.map((key) => {
    const hash = hashKey(key);
    ensureKey(hash, maskKey(key));
    return { hash, key, label: maskKey(key) };
  });
  const byHash = Object.fromEntries(entries.map((e) => [e.hash, e]));
  const hashes = entries.map((e) => e.hash);
  pruneToKeys(hashes);

  const budget = Math.min(Math.max(entries.length * chain.length, chain.length), 40);
  const emit = makeThrottledEmitter(onEvent, 250);
  const stopped = () => !!stopRef?.current || !!signal?.aborted;

  let attempts = 0;
  let lastKind = null;
  let lastModel = null;

  // One pass over the model chain × usable keys. Returns the success result,
  // or { attempted } so the caller can decide whether to wait and retry.
  const runSweep = async () => {
    let attempted = false;
    for (const model of chain) {
      if (stopped()) throw stopError();
      if (isModelCooling(model)) continue;

      const ordered = orderKeys(hashes, model);

      for (const hash of ordered) {
        if (stopped()) throw stopError();
        if (attempts >= budget) return { attempted, done: false };
        if (!isKeyUsable(hash, model)) continue;

        const entry = byHash[hash];
        if (!entry) continue;

        attempts += 1;
        attempted = true;
        reserve(hash);
        const t0 = Date.now();

        try {
          const meta =
            provider === "gemini"
              ? await geminiCall({ model, apiKey: entry.key, base64, mimeType, prompt, signal, timeoutMs })
              : await openrouterCall({ model, apiKey: entry.key, dataUrl, prompt, signal, timeoutMs });

          recordSuccess(hash, model, Date.now() - t0);
          emit.push({ type: "success", keyHash: hash, model, kind: null });
          return { attempted, done: true, result: { meta, keyHash: hash, keyLabel: entry.label, model } };
        } catch (e) {
          if (stopped()) throw stopError();

          const info = classifyError(e, { provider });
          lastKind = info.kind;
          lastModel = model;

          if (info.kind === ErrorKind.STOPPED) throw stopError();

          if (info.kind === ErrorKind.BLOCKED) {
            emit.push({ type: "blocked", keyHash: hash, model, kind: info.kind });
            throw new ProviderError(info.message, {
              kind: ErrorKind.BLOCKED,
              httpStatus: info.httpStatus,
              bodyText: info.message,
            });
          }

          recordFailure(hash, model, info.kind, info.retryAfterMs, info.message);
          emit.push({ type: "failure", keyHash: hash, model, kind: info.kind });

          if (info.kind === ErrorKind.MODEL_UNAVAILABLE) {
            // Model is broken — stop trying it, move to the next model.
            break;
          }
          // AUTH (key disabled), RATE_LIMIT (key cooling) and transient
          // errors all fall through to the next key/model candidate.
        } finally {
          release(hash);
        }
      }
    }
    return { attempted, done: false };
  };

  try {
    // Normal bounded attempts: one pass per sweep, a couple of sweeps.
    for (let sweep = 0; sweep < 2; sweep++) {
      const r = await runSweep();
      if (r.done) return r.result;
      if (!r.attempted) break;
      if (attempts >= budget) break;
      await sleepFn(300 + Math.floor(Math.random() * 200), signal);
    }

    // Patient mode: when every candidate is cooling on a short (per-minute)
    // limit, wait for the soonest slot to reopen and try again.
    if (patient) {
      let waitedMs = 0;
      while (true) {
        if (stopped()) throw stopError();
        const delay = soonestCooldownDelay(hashes, chain);
        if (delay == null) break;
        if (delay > MAX_PATIENT_WAIT_MS) break;
        if (waitedMs + delay > MAX_PATIENT_TOTAL_MS) break;

        emit.push({ type: "waiting", keyHash: null, model: null, kind: lastKind, retryAfterMs: delay });
        await sleepFn(Math.max(250, delay) + Math.floor(Math.random() * 250), signal);
        waitedMs += delay;

        attempts = 0; // fresh budget for this retry round
        const r = await runSweep();
        if (r.done) return r.result;
        if (!r.attempted) break;
      }
    }
  } finally {
    emit.flush();
  }

  throw new ProviderError(
    `All keys/models exhausted for this image (last: ${lastKind || "UNKNOWN"} on ${lastModel || "?"})`,
    { kind: lastKind || ErrorKind.UNKNOWN }
  );
}
