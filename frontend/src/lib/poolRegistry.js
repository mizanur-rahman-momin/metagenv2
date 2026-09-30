// Persisted API-key / model health registry + request scheduler.
//
// Secrets: only a short non-crypto hash and a masked label are ever stored.
// Raw keys stay in `stockmeta:settings` and are passed in per call.
//
// Pure data + storage; no React, no fetch. Safe to unit-test.

import { ErrorKind, COOLDOWN_MS } from "./errorKinds";

export const STORAGE_KEY = "stockmeta:health:v1";
const MODEL_UNAVAILABLE_MS = 6 * 60 * 60 * 1000;

// In-memory fallback when localStorage is unavailable (SSR / unit tests).
const memory = new Map();

export function getStorage() {
  try {
    if (typeof localStorage !== "undefined" && localStorage) return localStorage;
  } catch {
    /* localStorage may throw in some sandboxes */
  }
  return {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => memory.set(k, String(v)),
    removeItem: (k) => memory.delete(k),
  };
}

// FNV-1a 32-bit — short, stable, non-crypto digest. Never reversible.
export function hashKey(key) {
  const s = String(key ?? "");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function maskKey(key) {
  const s = String(key ?? "");
  if (s.length <= 8) return `${s.slice(0, 2)}…${s.slice(-2)}`;
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

let state = { keys: {}, models: {} };
let isLoaded = false;
let version = 0;
const listeners = new Set();

function nowMs() {
  return Date.now();
}

function blankKeyRecord(hash, label) {
  return {
    hash,
    label: label || "",
    status: "unknown",
    successCount: 0,
    failCount: 0,
    consecutiveFails: 0,
    lastErrorKind: null,
    lastError: null,
    lastUsedAt: 0,
    lastSuccessAt: 0,
    avgLatencyMs: 0,
    cooldowns: {},
    inflight: 0,
  };
}

function blankModelRecord(model) {
  return {
    model,
    status: "unknown",
    cooldownsUntil: 0,
    consecutiveFails: 0,
    lastErrorKind: null,
  };
}

export function load() {
  if (isLoaded) return state;
  isLoaded = true;
  const raw = getStorage().getItem(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        state = {
          keys: parsed.keys && typeof parsed.keys === "object" ? parsed.keys : {},
          models: parsed.models && typeof parsed.models === "object" ? parsed.models : {},
        };
        // In-flight counters are session-local, never restored.
        for (const rec of Object.values(state.keys)) rec.inflight = 0;
      }
    } catch {
      state = { keys: {}, models: {} };
    }
  }
  return state;
}

export function save() {
  const persistable = {
    keys: Object.fromEntries(
      Object.entries(state.keys).map(([h, rec]) => [h, { ...rec, inflight: 0 }])
    ),
    models: state.models,
  };
  try {
    getStorage().setItem(STORAGE_KEY, JSON.stringify(persistable));
  } catch {
    /* quota / private mode — keep working in memory */
  }
}

function bump() {
  version += 1;
  for (const fn of listeners) {
    try {
      fn(version);
    } catch {
      /* listener errors are isolated */
    }
  }
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getVersion() {
  return version;
}

export function resetAll() {
  load();
  state = { keys: {}, models: {} };
  save();
  bump();
}

export function resetKey(hash) {
  load();
  delete state.keys[hash];
  save();
  bump();
}

export function ensureKey(hash, label) {
  load();
  if (!state.keys[hash]) state.keys[hash] = blankKeyRecord(hash, label);
  else if (label) state.keys[hash].label = label;
  return state.keys[hash];
}

function ensureModel(model) {
  if (!state.models[model]) state.models[model] = blankModelRecord(model);
  return state.models[model];
}

// Drop health records for keys that are no longer in the pool.
export function pruneToKeys(hashes) {
  load();
  const keep = new Set(hashes);
  let changed = false;
  for (const h of Object.keys(state.keys)) {
    if (!keep.has(h)) {
      delete state.keys[h];
      changed = true;
    }
  }
  if (changed) {
    save();
    bump();
  }
}

function setCooldown(rec, model, until) {
  if (!rec.cooldowns) rec.cooldowns = {};
  rec.cooldowns[model] = until;
}

function clearCooldown(rec, model) {
  if (rec.cooldowns && rec.cooldowns[model]) delete rec.cooldowns[model];
}

export function recordSuccess(hash, model, latencyMs = 0) {
  load();
  const t = nowMs();
  const rec = ensureKey(hash);
  rec.status = "healthy";
  rec.successCount += 1;
  rec.consecutiveFails = 0;
  rec.lastErrorKind = null;
  rec.lastError = null;
  rec.lastUsedAt = t;
  rec.lastSuccessAt = t;
  const lat = Math.max(0, Math.round(latencyMs));
  rec.avgLatencyMs = rec.avgLatencyMs
    ? Math.round(rec.avgLatencyMs * 0.7 + lat * 0.3)
    : lat;
  clearCooldown(rec, model);

  const m = ensureModel(model);
  m.status = "healthy";
  m.cooldownsUntil = 0;
  m.consecutiveFails = 0;
  m.lastErrorKind = null;

  save();
  bump();
  return rec;
}

function overloadBackoff(consecutiveFails) {
  const step = Math.max(0, (consecutiveFails || 1) - 1);
  return Math.min(
    COOLDOWN_MS.OVERLOAD_BASE * Math.pow(2, step),
    COOLDOWN_MS.OVERLOAD_MAX
  );
}

export function recordFailure(hash, model, kind, retryAfterMs = null, message = null) {
  load();
  const t = nowMs();

  // A bad model is not a bad key — cool the model, leave the key alone.
  if (kind === ErrorKind.MODEL_UNAVAILABLE) {
    const m = ensureModel(model);
    m.status = "unavailable";
    m.consecutiveFails += 1;
    m.lastErrorKind = kind;
    m.cooldownsUntil = t + (Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : MODEL_UNAVAILABLE_MS);
    save();
    bump();
    return null;
  }

  const rec = ensureKey(hash);
  rec.failCount += 1;
  rec.consecutiveFails += 1;
  rec.lastErrorKind = kind;
  rec.lastError = message ? String(message).slice(0, 300) : null;
  rec.lastUsedAt = t;

  switch (kind) {
    case ErrorKind.AUTH:
      rec.status = "invalid";
      break;
    case ErrorKind.RATE_LIMIT: {
      rec.status = "cooling";
      const cd = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : COOLDOWN_MS.PER_MINUTE;
      setCooldown(rec, model, t + cd);
      break;
    }
    case ErrorKind.OVERLOADED:
    case ErrorKind.NETWORK: {
      rec.status = "degraded";
      setCooldown(rec, model, t + overloadBackoff(rec.consecutiveFails));
      break;
    }
    case ErrorKind.BAD_RESPONSE:
      rec.status = "degraded";
      break;
    default:
      break;
  }

  save();
  bump();
  return rec;
}

function cooldownUntil(rec, model) {
  if (!rec || !rec.cooldowns) return 0;
  return rec.cooldowns[model] || 0;
}

export function isKeyUsable(hash, model, now = nowMs()) {
  load();
  const rec = state.keys[hash];
  if (!rec) return true; // unknown key — let the caller probe it
  if (rec.status === "invalid" || rec.status === "disabled") return false;
  return cooldownUntil(rec, model) <= now;
}

export function isModelCooling(model, now = nowMs()) {
  load();
  const m = state.models[model];
  if (!m) return false;
  return m.cooldownsUntil > now;
}

// Smallest positive per-(key,model) cooldown still pending across the usable
// keys/models. Returns null when nothing can recover (all invalid / long-term
// model outages) — used to decide whether it is worth waiting to retry.
export function soonestCooldownDelay(hashes, models, now = nowMs()) {
  load();
  let min = null;
  for (const model of models || []) {
    if (isModelCooling(model, now)) continue;
    for (const hash of hashes || []) {
      const rec = state.keys[hash];
      if (!rec) continue;
      if (rec.status === "invalid" || rec.status === "disabled") continue;
      const until = cooldownUntil(rec, model);
      if (until > now) {
        const d = until - now;
        if (min === null || d < min) min = d;
      }
    }
  }
  return min;
}

export function getKey(hash) {
  load();
  return state.keys[hash] || null;
}

export function getModel(model) {
  load();
  return state.models[model] || null;
}

// Round-robin-ish ordering: usable first, least in-flight, fastest, least
// recently used. Unknown keys (no record) sort early so they get probed.
export function orderKeys(hashes, model, now = nowMs()) {
  load();
  return [...hashes]
    .map((h) => ({ h, rec: state.keys[h] }))
    .sort((a, b) => {
      const ca = cooldownUntil(a.rec, model) > now ? 1 : 0;
      const cb = cooldownUntil(b.rec, model) > now ? 1 : 0;
      if (ca !== cb) return ca - cb;

      const ia = a.rec?.inflight || 0;
      const ib = b.rec?.inflight || 0;
      if (ia !== ib) return ia - ib;

      const la = a.rec?.avgLatencyMs || 0;
      const lb = b.rec?.avgLatencyMs || 0;
      if (la !== lb) return la - lb;

      const ta = a.rec?.lastUsedAt || 0;
      const tb = b.rec?.lastUsedAt || 0;
      return ta - tb;
    })
    .map((x) => x.h);
}

// Manual enable/disable from the health panel.
export function setKeyEnabled(hash, enabled) {
  load();
  const rec = ensureKey(hash);
  if (enabled) {
    rec.status = "unknown";
    rec.consecutiveFails = 0;
    rec.cooldowns = {};
    rec.lastErrorKind = null;
    rec.lastError = null;
  } else {
    rec.status = "disabled";
  }
  save();
  bump();
}

export function reserve(hash) {
  load();
  const rec = ensureKey(hash);
  rec.inflight = (rec.inflight || 0) + 1;
  return rec.inflight;
}

export function release(hash) {
  load();
  const rec = state.keys[hash];
  if (rec) rec.inflight = Math.max(0, (rec.inflight || 0) - 1);
  return rec ? rec.inflight : 0;
}

export function snapshot() {
  load();
  return {
    version,
    keys: Object.values(state.keys).map((r) => ({ ...r, cooldowns: { ...r.cooldowns } })),
    models: Object.fromEntries(Object.entries(state.models).map(([k, v]) => [k, { ...v }])),
  };
}

// Test-only: clear the in-memory cache so a fresh storage is re-read.
export function __resetCache() {
  state = { keys: {}, models: {} };
  isLoaded = false;
  version = 0;
}
