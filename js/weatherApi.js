const NWS_BASE = 'https://api.weather.gov';
const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE_BASE = 'https://geocoding-api.open-meteo.com/v1/search';
const IEM_BASE = 'https://mesonet.agron.iastate.edu';
const SPC_MAPSERVER_BASE = 'https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/SPC_wx_outlks/MapServer';
const WPC_ERO_URL = 'https://mapservices.weather.noaa.gov/vector/rest/services/hazards/wpc_precip_hazards/MapServer/0/query?where=1%3D1&outFields=*&f=geojson';
const WPC_WSSI_BASE = 'https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/wpc_wssi/MapServer';
const SPC_DAY1_FALLBACK_URL = 'https://www.spc.noaa.gov/products/outlook/day1otlk_cat.nolyr.geojson';

export const DEFAULT_TIME_ZONE = 'America/Chicago';
export const STALE_THRESHOLD_MS = 15 * 60 * 1000;

const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const FAIL_FAST_HTTP_STATUSES = new Set([400, 401, 403, 404, 405, 410, 422]);
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 250;
const MAX_RETRY_AFTER_MS = 2500;

export const SPC_OVERLAY_MODES = [
  { id: 1, label: 'Day 1 Cat' },
  { id: 3, label: 'Tor %' },
  { id: 5, label: 'Hail %' },
  { id: 7, label: 'Wind %' },
  { id: 9, label: 'Day 2' },
  { id: 17, label: 'Day 3' }
];

export const WPC_WSSI_MODES = [
  { id: 4, label: 'Days 1–3' },
  { id: 1, label: 'Day 1' },
  { id: 2, label: 'Day 2' },
  { id: 3, label: 'Day 3' },
  { id: 19, label: 'Ice' },
  { id: 9, label: 'Snow' }
];

export const RADAR_PRODUCTS = [
  { code: 'CONUS_MOSAIC', shortLabel: 'CONUS', name: 'CONUS High-Res Composite Reflectivity', singleSite: false },
  { code: 'N0B', shortLabel: 'Refl N0B', name: 'Super-Res Base Reflectivity (0.5°)', singleSite: true },
  { code: 'N0G', shortLabel: 'Vel N0G', name: 'Super-Res Base Velocity (0.5°)', singleSite: true },
  { code: 'N0C', shortLabel: 'CC ρhv', name: 'Correlation Coefficient (Debris)', singleSite: true },
  { code: 'N0X', shortLabel: 'ZDR N0X', name: 'Differential Reflectivity (ZDR)', singleSite: true },
  { code: 'EET', shortLabel: 'Tops EET', name: 'Enhanced Echo Tops', singleSite: true }
];

const RESPONSE_CACHE = new Map();
const IN_FLIGHT = new Map();

export function clearWeatherApiCache() {
  RESPONSE_CACHE.clear();
  IN_FLIGHT.clear();
}

/* ==================== ERROR & RETRY PRIMITIVES ==================== */

class WeatherApiError extends Error {
  constructor(message, { code = 'FETCH_ERROR', status = 0, retryable = false, attempts = 1, url = '' } = {}) {
    super(message);
    this.name = 'WeatherApiError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.attempts = attempts;
    this.url = url;
  }
}

function getHeader(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') {
    return headers.get(name) || '';
  }
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return String(v ?? '');
  }
  return '';
}

function parseRetryAfterMs(headers) {
  const raw = getHeader(headers, 'retry-after').trim();
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.round(secs * 1000));
  }
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, dateMs - Date.now()));
  }
  return null;
}

function isExplicitCorsError(err) {
  const msg = String(err?.message || '').toLowerCase();
  return (
    msg.includes('cors') ||
    msg.includes('cross-origin') ||
    msg.includes('access-control-allow-origin') ||
    msg.includes('opaque') ||
    msg.includes('blocked by cors')
  );
}

function isAbortError(err) {
  if (!err) return false;
  if (err.name === 'AbortError' || err.code === 'TIMEOUT' || err.code === 'ABORTED') return true;
  const msg = String(err.message || '').toLowerCase();
  return msg.includes('aborted') || msg.includes('timeout');
}

function computeBackoffMs(attemptIndex, baseDelayMs = DEFAULT_RETRY_BASE_MS, retryAfterMs = null) {
  const safeBase = Math.max(0, Number.isFinite(baseDelayMs) ? baseDelayMs : DEFAULT_RETRY_BASE_MS);
  const exp = safeBase * (2 ** attemptIndex);
  // Bounded deterministic-ordered jitter within [0, 0.2 * safeBase] so delay(n+1) > delay(n)
  const jitter = safeBase > 0 ? Math.floor(Math.random() * Math.max(1, Math.round(safeBase * 0.2))) : 0;
  const computed = exp + jitter;
  if (retryAfterMs != null && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(computed, retryAfterMs));
  }
  return computed;
}

function sleepWithSignal(ms, externalSignal = null) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (externalSignal?.aborted) {
      reject(new WeatherApiError('Request aborted by caller', { code: 'ABORTED', retryable: false }));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new WeatherApiError('Request aborted by caller', { code: 'ABORTED', retryable: false }));
    };
    const timer = setTimeout(() => {
      if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (externalSignal) {
      externalSignal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Executes a single fetch + body read guarded by a hard AbortController timeout race,
 * ensuring even mock/stalled fetches that ignore AbortSignal cannot hang or leak rejections.
 */
async function fetchAttemptWithTimeout(url, {
  headers = {},
  timeoutMs = 12000,
  externalSignal = null,
  fetchImpl = null,
  responseType = 'json',
  cache = 'no-store'
} = {}) {
  const fetcher = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof fetcher !== 'function') {
    throw new WeatherApiError('Fetch API unavailable', { code: 'NO_FETCH', retryable: false, url });
  }
  if (externalSignal?.aborted) {
    throw new WeatherApiError('Request aborted by caller', { code: 'ABORTED', retryable: false, url });
  }

  const safeTimeout = Math.max(10, Number.isFinite(timeoutMs) ? timeoutMs : 12000);
  const controller = new AbortController();
  let timer = null;
  let timedOut = false;

  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        controller.abort();
      } catch {
        // ignore secondary abort errors
      }
      reject(new WeatherApiError(`Request timed out after ${safeTimeout}ms`, {
        code: 'TIMEOUT',
        retryable: true,
        url
      }));
    }, safeTimeout);
  });

  const workPromise = (async () => {
    const resp = await fetcher(url, {
      headers,
      cache,
      signal: controller.signal
    });

    if (!resp) {
      throw new WeatherApiError('Empty response object from fetch', {
        code: 'NETWORK_ERROR',
        retryable: true,
        url
      });
    }

    const status = typeof resp.status === 'number' ? resp.status : (resp.ok ? 200 : 0);
    if (resp.type === 'opaque' || (status === 0 && !resp.ok)) {
      throw new WeatherApiError('Opaque or CORS-blocked response', {
        code: 'CORS_OPAQUE',
        status: 0,
        retryable: false,
        url
      });
    }

    if (!resp.ok) {
      const retryable = RETRYABLE_HTTP_STATUSES.has(status);
      const err = new WeatherApiError(`HTTP ${status}`, {
        code: `HTTP_${status}`,
        status,
        retryable: retryable && !FAIL_FAST_HTTP_STATUSES.has(status),
        url
      });
      err.retryAfterMs = parseRetryAfterMs(resp.headers);
      throw err;
    }

    const contentType = getHeader(resp.headers, 'content-type');
    const contentLengthHeader = getHeader(resp.headers, 'content-length');
    const declaredLength = contentLengthHeader !== '' && /^\d+$/.test(contentLengthHeader.trim())
      ? Number(contentLengthHeader.trim())
      : null;

    if (responseType === 'arrayBuffer') {
      const buffer = await resp.arrayBuffer();
      return { status, contentType, declaredLength, body: buffer };
    }

    let data;
    try {
      data = await resp.json();
    } catch (parseErr) {
      throw new WeatherApiError(`Malformed JSON response: ${parseErr?.message || 'parse error'}`, {
        code: 'INVALID_JSON',
        status,
        retryable: true,
        url
      });
    }
    return { status, contentType, declaredLength, body: data };
  })();

  // Prevent unhandled rejection if workPromise settles after timeoutPromise wins the race
  workPromise.catch(() => {});

  try {
    return await Promise.race([workPromise, timeoutPromise]);
  } catch (err) {
    if (err instanceof WeatherApiError) throw err;
    if (externalSignal?.aborted) {
      throw new WeatherApiError('Request aborted by caller', { code: 'ABORTED', retryable: false, url });
    }
    if (timedOut || isAbortError(err)) {
      throw new WeatherApiError(`Request timed out after ${safeTimeout}ms`, {
        code: 'TIMEOUT',
        retryable: true,
        url
      });
    }
    if (isExplicitCorsError(err)) {
      throw new WeatherApiError(err?.message || 'CORS request blocked', {
        code: 'CORS_ERROR',
        retryable: false,
        url
      });
    }
    throw new WeatherApiError(err?.message || 'Network request failed', {
      code: 'NETWORK_ERROR',
      retryable: true,
      url
    });
  } finally {
    clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

async function fetchWithRetry(url, {
  headers = {},
  timeoutMs = 12000,
  maxRetries = DEFAULT_MAX_RETRIES,
  retryBaseDelayMs = DEFAULT_RETRY_BASE_MS,
  externalSignal = null,
  fetchImpl = null,
  responseType = 'json',
  cache = 'no-store'
} = {}) {
  const safeMaxRetries = Math.max(0, Math.min(5, Number.isFinite(maxRetries) ? Math.floor(maxRetries) : DEFAULT_MAX_RETRIES));
  let lastErr = null;

  for (let attempt = 0; attempt <= safeMaxRetries; attempt++) {
    try {
      const res = await fetchAttemptWithTimeout(url, {
        headers,
        timeoutMs,
        externalSignal,
        fetchImpl,
        responseType,
        cache
      });
      return { ...res, attempts: attempt + 1 };
    } catch (err) {
      const wrapped = err instanceof WeatherApiError
        ? err
        : new WeatherApiError(err?.message || 'Fetch failed', { code: 'NETWORK_ERROR', retryable: true, url });
      wrapped.attempts = attempt + 1;
      lastErr = wrapped;

      if (!wrapped.retryable || attempt >= safeMaxRetries || externalSignal?.aborted) {
        throw wrapped;
      }
      const delayMs = computeBackoffMs(attempt, retryBaseDelayMs, wrapped.retryAfterMs ?? null);
      await sleepWithSignal(delayMs, externalSignal);
    }
  }

  throw lastErr || new WeatherApiError('Request failed after retries', { code: 'FETCH_ERROR', url });
}

async function fetchJson(url, headers = {}, timeoutMs = 12000, options = {}) {
  const res = await fetchWithRetry(url, {
    headers,
    timeoutMs,
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    retryBaseDelayMs: options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_MS,
    externalSignal: options.signal ?? null,
    fetchImpl: options.fetchImpl ?? null,
    responseType: 'json',
    cache: 'no-store'
  });
  return res.body;
}

function isValidFeatureCollection(data) {
  return Boolean(data && typeof data === 'object' && data.type === 'FeatureCollection' && Array.isArray(data.features));
}

function setCacheEntry(cacheKey, data, ttlMs, fetchedAtMs = Date.now()) {
  if (RESPONSE_CACHE.size >= 64 && !RESPONSE_CACHE.has(cacheKey)) {
    const oldestKey = RESPONSE_CACHE.keys().next().value;
    if (oldestKey !== undefined) RESPONSE_CACHE.delete(oldestKey);
  }
  RESPONSE_CACHE.set(cacheKey, {
    data,
    fetchedAtMs,
    expiresAt: fetchedAtMs + ttlMs
  });
}

async function ttlFetchJsonWithMeta(cacheKey, url, ttlMs, {
  headers = {},
  timeoutMs = 12000,
  force = false,
  validate = null,
  maxRetries = DEFAULT_MAX_RETRIES,
  retryBaseDelayMs = DEFAULT_RETRY_BASE_MS,
  fetchImpl = null,
  signal = null
} = {}) {
  const now = Date.now();
  if (!force) {
    const cached = RESPONSE_CACHE.get(cacheKey);
    if (cached && now < cached.expiresAt) {
      return { data: cached.data, fetchedAtMs: cached.fetchedAtMs, fromCache: true };
    }
    const existing = IN_FLIGHT.get(cacheKey);
    if (existing) return existing;
  }

  const req = (async () => {
    try {
      const data = await fetchJson(url, headers, timeoutMs, {
        maxRetries,
        retryBaseDelayMs,
        fetchImpl,
        signal
      });
      const valid = typeof validate === 'function'
        ? Boolean(validate(data))
        : (data != null && typeof data === 'object');
      if (!valid) {
        throw new WeatherApiError('Response payload failed validation', {
          code: 'INVALID_PAYLOAD',
          retryable: false,
          url
        });
      }
      const fetchedAtMs = Date.now();
      setCacheEntry(cacheKey, data, ttlMs, fetchedAtMs);
      return { data, fetchedAtMs, fromCache: false };
    } finally {
      if (IN_FLIGHT.get(cacheKey) === req) {
        IN_FLIGHT.delete(cacheKey);
      }
    }
  })();

  IN_FLIGHT.set(cacheKey, req);
  return req;
}

async function ttlFetchJson(cacheKey, url, ttlMs, opts = {}) {
  const res = await ttlFetchJsonWithMeta(cacheKey, url, ttlMs, opts);
  return res.data;
}

/* ==================== STRICT UTC & CENTRAL TIME HELPERS ==================== */

/**
 * Parses timestamps strictly into UTC epoch milliseconds without browser local-TZ drift.
 * - Accepts epoch ms, epoch seconds, Date instances, ISO-8601 strings (with or without Z/offset),
 *   SQL-style UTC strings ("YYYY-MM-DD HH:MM:SS"), and compact 12/14-digit UTC strings ("YYYYMMDDHHMM[SS]").
 * - Naive ISO strings without an explicit offset are treated strictly as UTC unless a finite
 *   non-zero `options.utcOffsetSeconds` is supplied (e.g. Open-Meteo `timezone=auto` responses).
 */
export function parseUtcTimestampMs(raw, options = {}) {
  if (raw == null || raw === '') return null;

  if (raw instanceof Date) {
    const ms = raw.getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) return null;
    return raw > 0 && raw < 1e11 ? Math.round(raw * 1000) : Math.round(raw);
  }

  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;

  // Compact 12-digit (YYYYMMDDHHMM) or 14-digit (YYYYMMDDHHMMSS) UTC strings (IEM RIDGE)
  const compactMatch = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?$/);
  if (compactMatch) {
    const year = Number(compactMatch[1]);
    const month = Number(compactMatch[2]);
    const day = Number(compactMatch[3]);
    const hour = Number(compactMatch[4]);
    const minute = Number(compactMatch[5]);
    const second = compactMatch[6] ? Number(compactMatch[6]) : 0;
    if (
      year >= 1970 && year <= 2100 &&
      month >= 1 && month <= 12 &&
      day >= 1 && day <= 31 &&
      hour <= 23 && minute <= 59 && second <= 59
    ) {
      return Date.UTC(year, month - 1, day, hour, minute, second);
    }
  }

  // Pure numeric epoch string
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return null;
    return n > 0 && n < 1e11 ? Math.round(n * 1000) : Math.round(n);
  }

  // ISO-8601 or space-separated YYYY-MM-DD[T ]HH:MM[:SS[.sss]][Z|±HH[:]MM]
  const isoMatch = s.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?(Z|[+-]\d{2}:?\d{2})?$/i
  );
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    const hour = isoMatch[4] != null ? Number(isoMatch[4]) : 0;
    const minute = isoMatch[5] != null ? Number(isoMatch[5]) : 0;
    const second = isoMatch[6] != null ? Number(isoMatch[6]) : 0;
    const fracStr = isoMatch[7] || '';
    const msPart = fracStr ? Number(fracStr.slice(0, 3).padEnd(3, '0')) : 0;
    const tzPart = isoMatch[8] || '';

    if (
      month < 1 || month > 12 ||
      day < 1 || day > 31 ||
      hour > 23 || minute > 59 || second > 60
    ) {
      return null;
    }

    const baseUtcMs = Date.UTC(year, month - 1, day, hour, minute, second, msPart);
    if (!Number.isFinite(baseUtcMs)) return null;

    if (tzPart) {
      if (tzPart.toUpperCase() === 'Z') return baseUtcMs;
      const sign = tzPart[0] === '-' ? -1 : 1;
      const clean = tzPart.slice(1).replace(':', '');
      const offH = Number(clean.slice(0, 2));
      const offM = Number(clean.slice(2, 4));
      if (!Number.isFinite(offH) || !Number.isFinite(offM)) return null;
      const offsetMs = sign * (offH * 60 + offM) * 60000;
      return baseUtcMs - offsetMs;
    }

    // Naive ISO timestamp: strictly UTC unless explicit utcOffsetSeconds is passed
    const utcOffsetSec = Number(options?.utcOffsetSeconds);
    if (Number.isFinite(utcOffsetSec) && utcOffsetSec !== 0) {
      return baseUtcMs - utcOffsetSec * 1000;
    }
    return baseUtcMs;
  }

  // Fallback for RFC-2822 / HTTP-Date strings (which include explicit GMT/offset)
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Formats a UTC epoch ms / ISO timestamp cleanly in `America/Chicago` (or configurable IANA timeZone).
 * Normalizes ICU narrow non-breaking spaces to standard ASCII spaces.
 */
export function formatCentralTime(msOrIso, timeZone = DEFAULT_TIME_ZONE, options = {}) {
  const ms = parseUtcTimestampMs(msOrIso);
  if (ms == null) return '--';

  const date = new Date(ms);
  const tz = (typeof timeZone === 'string' && timeZone.trim()) ? timeZone.trim() : DEFAULT_TIME_ZONE;
  const fmtOpts = {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit'
  };
  if (options.includeDate) {
    fmtOpts.month = 'short';
    fmtOpts.day = 'numeric';
  }
  if (options.includeSeconds) {
    fmtOpts.second = '2-digit';
  }
  if (options.includeTimeZoneName !== false) {
    fmtOpts.timeZoneName = 'short';
  }

  try {
    return new Intl.DateTimeFormat('en-US', fmtOpts)
      .format(date)
      .replace(/[\u202f\u00a0]+/g, ' ')
      .trim();
  } catch {
    try {
      return new Intl.DateTimeFormat('en-US', { ...fmtOpts, timeZone: DEFAULT_TIME_ZONE })
        .format(date)
        .replace(/[\u202f\u00a0]+/g, ' ')
        .trim();
    } catch {
      return date.toISOString();
    }
  }
}

export function formatCentralHour(msOrIso, timeZone = DEFAULT_TIME_ZONE) {
  const ms = parseUtcTimestampMs(msOrIso);
  if (ms == null) return '--';
  const date = new Date(ms);
  const tz = (typeof timeZone === 'string' && timeZone.trim()) ? timeZone.trim() : DEFAULT_TIME_ZONE;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric' })
      .format(date)
      .replace(/[\u202f\u00a0]+/g, ' ')
      .trim();
  } catch {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: DEFAULT_TIME_ZONE, hour: 'numeric' })
        .format(date)
        .replace(/[\u202f\u00a0]+/g, ' ')
        .trim();
    } catch {
      return `${date.getUTCHours()}:00Z`;
    }
  }
}

export function getCentralHour24(msOrIso, timeZone = DEFAULT_TIME_ZONE) {
  const ms = parseUtcTimestampMs(msOrIso);
  if (ms == null) return null;
  const date = new Date(ms);
  const tz = (typeof timeZone === 'string' && timeZone.trim()) ? timeZone.trim() : DEFAULT_TIME_ZONE;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      hourCycle: 'h23'
    }).formatToParts(date);
    const hPart = parts.find((p) => p.type === 'hour')?.value;
    const h = Number(hPart);
    if (Number.isFinite(h)) return ((h % 24) + 24) % 24;
  } catch {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: DEFAULT_TIME_ZONE,
        hour: 'numeric',
        hourCycle: 'h23'
      }).formatToParts(date);
      const hPart = parts.find((p) => p.type === 'hour')?.value;
      const h = Number(hPart);
      if (Number.isFinite(h)) return ((h % 24) + 24) % 24;
    } catch {
      // fall through
    }
  }
  return date.getUTCHours();
}

function formatUtcCompact12(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    String(d.getUTCFullYear()) +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes())
  );
}

/* ==================== HARD 15-MINUTE STALENESS ENGINE ==================== */

function resolveRadarLatestMs(radarFrames) {
  if (!radarFrames) return null;
  const arr = Array.isArray(radarFrames)
    ? radarFrames
    : (Array.isArray(radarFrames.frames) ? radarFrames.frames : null);

  let latest = null;
  if (arr && arr.length) {
    for (const fr of arr) {
      if (!fr) continue;
      const ms = parseUtcTimestampMs(fr.timestampMs ?? fr.timestampUtc ?? fr.timestamp);
      if (ms != null && (latest == null || ms > latest)) {
        latest = ms;
      }
    }
  }
  if (latest == null && radarFrames._meta) {
    latest = parseUtcTimestampMs(radarFrames._meta.latestFrameMs ?? radarFrames._meta.fetchedAtMs);
  }
  return latest;
}

function resolveOpenMeteoTimestamps(openMeteo) {
  if (!openMeteo || typeof openMeteo !== 'object') {
    return { fetchedAtMs: null, latestModelTimeMs: null, effectiveMs: null };
  }
  const utcOffsetSeconds = Number.isFinite(openMeteo.utc_offset_seconds)
    ? openMeteo.utc_offset_seconds
    : 0;
  const fetchedAtMs = parseUtcTimestampMs(
    openMeteo._meta?.fetchedAtMs ?? openMeteo._meta?.fetchedAtUtc ?? openMeteo.fetchedAtMs
  );
  let latestModelTimeMs = parseUtcTimestampMs(
    openMeteo._meta?.latestModelTimeMs ?? openMeteo._meta?.latestModelTimeUtc
  );
  if (latestModelTimeMs == null && openMeteo.current?.time != null) {
    latestModelTimeMs = parseUtcTimestampMs(openMeteo.current.time, { utcOffsetSeconds });
  }

  // Flag staleness if EITHER the upstream model timestamp OR the fetch timestamp is > 15m old
  const candidates = [fetchedAtMs, latestModelTimeMs].filter((v) => v != null);
  const effectiveMs = candidates.length ? Math.min(...candidates) : null;
  return { fetchedAtMs, latestModelTimeMs, effectiveMs };
}

function resolveNwsBundleTimestamps(nwsBundle) {
  if (!nwsBundle || typeof nwsBundle !== 'object') {
    return { fetchedAtMs: null, latestObservationMs: null, effectiveMs: null };
  }
  const fetchedAtMs = parseUtcTimestampMs(
    nwsBundle._meta?.fetchedAtMs ?? nwsBundle._meta?.fetchedAtUtc ?? nwsBundle.fetchedAtMs
  );
  let latestObservationMs = parseUtcTimestampMs(nwsBundle._meta?.latestObservationMs);
  if (latestObservationMs == null && Array.isArray(nwsBundle.observations)) {
    for (const obs of nwsBundle.observations) {
      const ms = parseUtcTimestampMs(obs?.timestampMs ?? obs?.props?.timestamp);
      if (ms != null && (latestObservationMs == null || ms > latestObservationMs)) {
        latestObservationMs = ms;
      }
    }
  }
  // Hourly ASOS METARs normally update every ~55-60 min, so NWS bundle staleness is governed by fetch time
  return { fetchedAtMs, latestObservationMs, effectiveMs: fetchedAtMs };
}

function resolveStormCellsTimestamp(stormCells) {
  if (!stormCells) return null;
  if (Array.isArray(stormCells)) {
    if (!stormCells.length) return null;
    let latest = null;
    for (const cell of stormCells) {
      const ms = parseUtcTimestampMs(cell?.validMs ?? cell?.valid ?? cell?.properties?.valid);
      if (ms != null && (latest == null || ms > latest)) latest = ms;
    }
    return latest;
  }
  if (typeof stormCells === 'object') {
    const metaMs = parseUtcTimestampMs(stormCells._meta?.latestCellMs ?? stormCells._meta?.fetchedAtMs);
    if (Array.isArray(stormCells.features) && stormCells.features.length) {
      let latest = null;
      for (const f of stormCells.features) {
        const ms = parseUtcTimestampMs(f?.properties?.validMs ?? f?.properties?.valid);
        if (ms != null && (latest == null || ms > latest)) latest = ms;
      }
      if (latest != null && metaMs != null) return Math.min(latest, metaMs);
      return latest ?? metaMs;
    }
    return metaMs;
  }
  return null;
}

function buildSourceStatus(label, tsMs, nowMs, thresholdMs, timeZone, extra = {}) {
  if (tsMs == null) {
    return {
      present: false,
      label,
      timestampMs: null,
      timestampUtc: null,
      timeCentral: '--',
      ageMs: 0,
      ageMinutes: 0,
      isStale: false,
      ...extra
    };
  }
  const ageMs = Math.max(0, nowMs - tsMs);
  const ageMinutes = Number((ageMs / 60000).toFixed(1));
  const isStale = ageMs > thresholdMs;
  return {
    present: true,
    label,
    timestampMs: tsMs,
    timestampUtc: new Date(tsMs).toISOString(),
    timeCentral: formatCentralTime(tsMs, timeZone),
    ageMs,
    ageMinutes,
    isStale,
    ...extra
  };
}

/**
 * Evaluates hard 15-minute staleness contract across radar frames, Open-Meteo model payload,
 * NWS bundle, and storm cells.
 * Flags `isStale: true` with explicit `staleSources` & `summary` whenever the newest radar
 * frame OR Open-Meteo payload timestamp (or NWS fetch / active storm cell feed) is > 15 min old.
 */
export function evaluateDataStaleness({
  radarFrames = null,
  openMeteo = null,
  nwsBundle = null,
  stormCells = null,
  nowMs = Date.now(),
  thresholdMs = STALE_THRESHOLD_MS,
  timeZone = DEFAULT_TIME_ZONE
} = {}) {
  const evalNowMs = parseUtcTimestampMs(nowMs) ?? Date.now();
  const safeThresholdMs = Number.isFinite(thresholdMs) && thresholdMs > 0
    ? thresholdMs
    : STALE_THRESHOLD_MS;

  const radarLatestMs = resolveRadarLatestMs(radarFrames);
  const omTimes = resolveOpenMeteoTimestamps(openMeteo);
  const nwsTimes = resolveNwsBundleTimestamps(nwsBundle);
  const cellsLatestMs = resolveStormCellsTimestamp(stormCells);

  const sources = {
    radar: buildSourceStatus('Radar', radarLatestMs, evalNowMs, safeThresholdMs, timeZone),
    openMeteo: buildSourceStatus('Open-Meteo', omTimes.effectiveMs, evalNowMs, safeThresholdMs, timeZone, {
      fetchedAtMs: omTimes.fetchedAtMs,
      latestModelTimeMs: omTimes.latestModelTimeMs
    }),
    nwsBundle: buildSourceStatus('NWS Feed', nwsTimes.effectiveMs, evalNowMs, safeThresholdMs, timeZone, {
      fetchedAtMs: nwsTimes.fetchedAtMs,
      latestObservationMs: nwsTimes.latestObservationMs
    }),
    stormCells: buildSourceStatus('Storm Cells', cellsLatestMs, evalNowMs, safeThresholdMs, timeZone)
  };

  const staleSources = [];
  const staleDetails = [];
  let maxAgeMs = 0;
  let oldestStaleAgeMs = 0;

  for (const [key, info] of Object.entries(sources)) {
    if (info.present && info.ageMs > maxAgeMs) {
      maxAgeMs = info.ageMs;
    }
    if (info.isStale) {
      staleSources.push(key);
      staleDetails.push({
        source: key,
        label: info.label,
        timestampMs: info.timestampMs,
        timestampUtc: info.timestampUtc,
        timeCentral: info.timeCentral,
        ageMs: info.ageMs,
        ageMinutes: info.ageMinutes
      });
      if (info.ageMs > oldestStaleAgeMs) {
        oldestStaleAgeMs = info.ageMs;
      }
    }
  }

  const isStale = staleSources.length > 0;
  const thresholdMinutes = Math.round(safeThresholdMs / 60000);
  const summary = isStale
    ? `Stale weather data (>${thresholdMinutes} min): ${staleDetails
        .map((d) => `${d.label} (${Math.round(d.ageMinutes)}m old, ${d.timeCentral})`)
        .join(', ')} — verify live radar before acting.`
    : '';

  return {
    isStale,
    thresholdMs: safeThresholdMs,
    thresholdMinutes,
    evaluatedAtMs: evalNowMs,
    evaluatedAtUtc: new Date(evalNowMs).toISOString(),
    evaluatedAtCentral: formatCentralTime(evalNowMs, timeZone),
    maxAgeMs,
    maxAgeMinutes: Number((maxAgeMs / 60000).toFixed(1)),
    oldestStaleAgeMs,
    staleSources,
    staleDetails,
    sources,
    summary
  };
}

/* ==================== BINARY RADAR FRAME VALIDATION & FETCHER ==================== */

const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

function toUint8Array(buffer) {
  if (buffer == null) return null;
  if (buffer instanceof Uint8Array) return buffer;
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
  if (ArrayBuffer.isView(buffer)) {
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  return null;
}

function readAsciiPrefix(bytes, maxLen = 64) {
  const len = Math.min(bytes.byteLength, maxLen);
  let out = '';
  for (let i = 0; i < len; i++) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

function looksLikeTextErrorPayload(bytes, ctLower) {
  const prefix = readAsciiPrefix(bytes, 96).trimStart().toLowerCase();
  if (
    prefix.startsWith('<!doctype') ||
    prefix.startsWith('<html') ||
    prefix.startsWith('<?xml') ||
    prefix.startsWith('<error') ||
    prefix.startsWith('{"error') ||
    prefix.startsWith('{"status') ||
    prefix.startsWith('{"message') ||
    prefix.startsWith('not found') ||
    prefix.startsWith('404 ') ||
    prefix.startsWith('503 ')
  ) {
    return true;
  }
  if (
    ctLower.includes('text/html') ||
    ctLower.includes('application/xml') ||
    ctLower.includes('text/xml') ||
    ctLower.includes('application/json')
  ) {
    return true;
  }
  return false;
}

function validatePngBytes(bytes) {
  const len = bytes.byteLength;
  if (len < 45) {
    return { valid: false, format: 'png', byteLength: len, reason: `Truncated PNG frame (${len} bytes)` };
  }
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) {
      return { valid: false, format: 'png', byteLength: len, reason: 'Invalid PNG magic signature' };
    }
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, len);
  const ihdrLen = view.getUint32(8, false);
  const ihdrType = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (ihdrLen !== 13 || ihdrType !== 'IHDR') {
    return { valid: false, format: 'png', byteLength: len, reason: 'Corrupted PNG header (missing valid IHDR chunk)' };
  }

  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (width === 0 || height === 0 || width > 32768 || height > 32768) {
    return { valid: false, format: 'png', byteLength: len, reason: `Invalid PNG dimensions (${width}x${height})` };
  }

  let offset = 8;
  let foundIdat = false;
  let foundIend = false;
  while (offset + 12 <= len) {
    const chunkLen = view.getUint32(offset, false);
    const chunkType = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7]
    );
    const nextOffset = offset + 12 + chunkLen;
    if (chunkLen > 0x7fffffff || nextOffset > len) {
      return {
        valid: false,
        format: 'png',
        byteLength: len,
        reason: `Truncated PNG chunk "${chunkType}" (declared ${chunkLen} bytes beyond buffer)`
      };
    }
    if (chunkType === 'IDAT') {
      foundIdat = true;
    }
    if (chunkType === 'IEND') {
      if (chunkLen !== 0) {
        return { valid: false, format: 'png', byteLength: len, reason: 'Corrupted PNG IEND chunk' };
      }
      foundIend = true;
      break;
    }
    offset = nextOffset;
  }

  if (!foundIdat) {
    return { valid: false, format: 'png', byteLength: len, reason: 'Corrupted PNG frame (missing IDAT image data)' };
  }
  if (!foundIend) {
    return { valid: false, format: 'png', byteLength: len, reason: 'Truncated PNG frame (missing IEND terminator)' };
  }

  return { valid: true, format: 'png', byteLength: len, width, height, reason: null };
}

function validateGzipBytes(bytes) {
  const len = bytes.byteLength;
  if (len < 18) {
    return { valid: false, format: 'gzip', byteLength: len, reason: `Truncated GZIP frame (${len} bytes, minimum 18)` };
  }
  if (bytes[0] !== 0x1F || bytes[1] !== 0x8B) {
    return { valid: false, format: 'gzip', byteLength: len, reason: 'Invalid GZIP magic header' };
  }
  if (bytes[2] !== 0x08) {
    return { valid: false, format: 'gzip', byteLength: len, reason: `Unsupported GZIP compression method (${bytes[2]})` };
  }
  const flg = bytes[3];
  if ((flg & 0xE0) !== 0) {
    return { valid: false, format: 'gzip', byteLength: len, reason: 'Corrupted GZIP header (reserved flags set)' };
  }

  let pos = 10;
  const trailerStart = len - 8;
  // FEXTRA
  if (flg & 0x04) {
    if (pos + 2 > trailerStart) {
      return { valid: false, format: 'gzip', byteLength: len, reason: 'Truncated GZIP FEXTRA header' };
    }
    const xlen = bytes[pos] | (bytes[pos + 1] << 8);
    pos += 2 + xlen;
  }
  // FNAME
  if (flg & 0x08) {
    while (pos < trailerStart && bytes[pos] !== 0) pos++;
    pos++;
  }
  // FCOMMENT
  if (flg & 0x10) {
    while (pos < trailerStart && bytes[pos] !== 0) pos++;
    pos++;
  }
  // FHCRC
  if (flg & 0x02) {
    pos += 2;
  }

  if (pos > trailerStart) {
    return { valid: false, format: 'gzip', byteLength: len, reason: 'Truncated GZIP stream header' };
  }

  return { valid: true, format: 'gzip', byteLength: len, reason: null };
}

function validateNexradLevel3Bytes(bytes) {
  const len = bytes.byteLength;
  const prefix = readAsciiPrefix(bytes, 64);
  const view = new DataView(bytes.buffer, bytes.byteOffset, len);

  // Variant A: WMO/AWIPS header (e.g. "SDUS54 KGWX 231845\r\r\nN0BGWX\r\r\n" + binary MHB/PDB)
  if (/^SDUS\d{2}\s+[A-Z0-9]{4}\s+\d{6}/i.test(prefix)) {
    let newlines = 0;
    let wmoEnd = -1;
    const scanLimit = Math.min(len, 64);
    for (let i = 0; i < scanLimit; i++) {
      if (bytes[i] === 0x0A) {
        newlines++;
        if (newlines === 2) {
          wmoEnd = i + 1;
          break;
        }
      }
    }
    if (wmoEnd < 0 || len < wmoEnd + 18) {
      return {
        valid: false,
        format: 'nexrad-level3',
        byteLength: len,
        reason: `Truncated NEXRAD Level-III frame (${len} bytes after WMO header)`
      };
    }

    const msgCode = view.getUint16(wmoEnd, false);
    const msgLen = view.getUint32(wmoEnd + 8, false);
    if (msgCode < 16 || msgCode > 500) {
      return {
        valid: false,
        format: 'nexrad-level3',
        byteLength: len,
        reason: `Invalid NEXRAD Level-III message code (${msgCode})`
      };
    }
    if (msgLen < 18 || wmoEnd + msgLen > len) {
      return {
        valid: false,
        format: 'nexrad-level3',
        byteLength: len,
        reason: `Truncated NEXRAD Level-III frame (declared ${msgLen} bytes after ${wmoEnd}-byte WMO header, received ${len})`
      };
    }
    if (len >= wmoEnd + 20) {
      const pdbDivider = view.getInt16(wmoEnd + 18, false);
      if (pdbDivider !== -1) {
        return {
          valid: false,
          format: 'nexrad-level3',
          byteLength: len,
          reason: 'Corrupted NEXRAD Level-III Product Description Block divider'
        };
      }
    }
    return { valid: true, format: 'nexrad-level3', byteLength: len, messageCode: msgCode, reason: null };
  }

  // Variant B: NEXRAD Level-II Archive header ("AR2V" or "ARCHIVE2.")
  if (prefix.startsWith('AR2V') || prefix.startsWith('ARCHIVE2.')) {
    if (len < 24) {
      return { valid: false, format: 'nexrad-level2', byteLength: len, reason: 'Truncated NEXRAD Level-II header' };
    }
    return { valid: true, format: 'nexrad-level2', byteLength: len, reason: null };
  }

  // Variant C: Raw NEXRAD Level-III binary without WMO header (18-byte MHB + 102-byte PDB)
  if (len >= 120) {
    const msgCode = view.getUint16(0, false);
    const msgLen = view.getUint32(8, false);
    const pdbDivider = view.getInt16(18, false);
    if (msgCode >= 16 && msgCode <= 299 && pdbDivider === -1) {
      if (msgLen < 120 || msgLen > len) {
        return {
          valid: false,
          format: 'nexrad-level3',
          byteLength: len,
          reason: `Truncated raw NEXRAD Level-III frame (declared ${msgLen} bytes, received ${len})`
        };
      }
      return { valid: true, format: 'nexrad-level3', byteLength: len, messageCode: msgCode, reason: null };
    }
  }

  return { valid: false, format: 'nexrad-level3', byteLength: len, reason: 'Unrecognized or corrupted NEXRAD Level-III header' };
}

/**
 * Pure validator for binary/image radar frames (PNG, WebP, JPEG, GZIP, BZIP2, NEXRAD Level-III/II).
 * Rejects empty, truncated, text/HTML/XML error documents, and bad-header buffers cleanly without throwing.
 */
export function validateRadarBinaryFrame(buffer, contentType = '') {
  const bytes = toUint8Array(buffer);
  if (!bytes) {
    return { valid: false, format: 'unknown', byteLength: 0, reason: 'Missing or unsupported binary buffer' };
  }
  const len = bytes.byteLength;
  if (len === 0) {
    return { valid: false, format: 'unknown', byteLength: 0, reason: 'Empty binary radar frame (0 bytes)' };
  }

  const ctLower = String(contentType || '').toLowerCase();
  if (looksLikeTextErrorPayload(bytes, ctLower)) {
    return {
      valid: false,
      format: 'error-document',
      byteLength: len,
      reason: 'Received HTML/XML/JSON error payload instead of binary radar frame'
    };
  }

  // Explicit content-type enforcement
  if (ctLower.includes('image/png')) {
    return validatePngBytes(bytes);
  }
  if (ctLower.includes('gzip')) {
    return validateGzipBytes(bytes);
  }
  if (ctLower.includes('image/webp')) {
    if (len < 12) return { valid: false, format: 'webp', byteLength: len, reason: 'Truncated WebP frame' };
    const riff = readAsciiPrefix(bytes, 4);
    const webp = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (riff !== 'RIFF' || webp !== 'WEBP') {
      return { valid: false, format: 'webp', byteLength: len, reason: 'Invalid WebP header' };
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, len);
    const riffSize = view.getUint32(4, true);
    if (riffSize + 8 > len) {
      return { valid: false, format: 'webp', byteLength: len, reason: 'Truncated WebP payload' };
    }
    return { valid: true, format: 'webp', byteLength: len, reason: null };
  }
  if (ctLower.includes('image/jpeg') || ctLower.includes('image/jpg')) {
    if (len < 16 || bytes[0] !== 0xFF || bytes[1] !== 0xD8 || bytes[2] !== 0xFF) {
      return { valid: false, format: 'jpeg', byteLength: len, reason: 'Invalid JPEG header' };
    }
    if (bytes[len - 2] !== 0xFF || bytes[len - 1] !== 0xD9) {
      return { valid: false, format: 'jpeg', byteLength: len, reason: 'Truncated JPEG frame (missing EOI marker)' };
    }
    return { valid: true, format: 'jpeg', byteLength: len, reason: null };
  }

  // Auto-detect by magic bytes (generic application/octet-stream or omitted content-type)
  if (len >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    return validatePngBytes(bytes);
  }
  if (len >= 2 && bytes[0] === 0x1F && bytes[1] === 0x8B) {
    return validateGzipBytes(bytes);
  }
  if (len >= 4 && bytes[0] === 0x42 && bytes[1] === 0x5A && bytes[2] === 0x68 && bytes[3] >= 0x31 && bytes[3] <= 0x39) {
    if (len < 14) {
      return { valid: false, format: 'bzip2', byteLength: len, reason: 'Truncated BZIP2 frame' };
    }
    return { valid: true, format: 'bzip2', byteLength: len, reason: null };
  }
  if (len >= 12 && readAsciiPrefix(bytes, 4) === 'RIFF' && String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === 'WEBP') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, len);
    if (view.getUint32(4, true) + 8 > len) {
      return { valid: false, format: 'webp', byteLength: len, reason: 'Truncated WebP payload' };
    }
    return { valid: true, format: 'webp', byteLength: len, reason: null };
  }
  if (len >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    if (len < 16 || bytes[len - 2] !== 0xFF || bytes[len - 1] !== 0xD9) {
      return { valid: false, format: 'jpeg', byteLength: len, reason: 'Truncated JPEG frame (missing EOI marker)' };
    }
    return { valid: true, format: 'jpeg', byteLength: len, reason: null };
  }

  // NEXRAD Level-III / Level-II check
  const prefix = readAsciiPrefix(bytes, 16);
  if (prefix.startsWith('SDUS') || prefix.startsWith('AR2V') || prefix.startsWith('ARCHIVE2.') || ctLower.includes('octet-stream') || ctLower.includes('nexrad') || ctLower === '') {
    const nexradCheck = validateNexradLevel3Bytes(bytes);
    if (nexradCheck.valid) return nexradCheck;
    if (prefix.startsWith('SDUS') || prefix.startsWith('AR2V') || prefix.startsWith('ARCHIVE2.') || ctLower.includes('nexrad')) {
      return nexradCheck;
    }
  }

  return {
    valid: false,
    format: 'unknown',
    byteLength: len,
    reason: 'Unrecognized or corrupted binary radar frame header'
  };
}

async function fetchSingleRadarBinaryCandidate(url, {
  timeoutMs = 10000,
  maxRetries = DEFAULT_MAX_RETRIES,
  retryBaseDelayMs = DEFAULT_RETRY_BASE_MS,
  headers = {},
  expectedContentType = '',
  signal = null,
  fetchImpl = null
} = {}) {
  const safeMaxRetries = Math.max(0, Math.min(5, Number.isFinite(maxRetries) ? Math.floor(maxRetries) : DEFAULT_MAX_RETRIES));
  let totalAttempts = 0;
  let lastError = null;
  let lastValidation = null;
  let lastStatus = 0;
  let lastContentType = '';

  for (let attempt = 0; attempt <= safeMaxRetries; attempt++) {
    totalAttempts = attempt + 1;
    try {
      const res = await fetchAttemptWithTimeout(url, {
        headers,
        timeoutMs,
        externalSignal: signal,
        fetchImpl,
        responseType: 'arrayBuffer',
        cache: 'no-store'
      });

      lastStatus = res.status;
      lastContentType = res.contentType || expectedContentType || '';
      const buffer = res.body;
      const byteLength = buffer?.byteLength ?? 0;

      // Detect mid-stream cell truncation via Content-Length mismatch
      if (res.declaredLength != null && byteLength < res.declaredLength) {
        lastValidation = {
          valid: false,
          format: 'unknown',
          byteLength,
          reason: `Truncated binary frame: Content-Length ${res.declaredLength} bytes, received ${byteLength}`
        };
        lastError = new WeatherApiError(lastValidation.reason, {
          code: 'TRUNCATED_FRAME',
          status: res.status,
          retryable: true,
          attempts: totalAttempts,
          url
        });
        if (attempt < safeMaxRetries && !signal?.aborted) {
          await sleepWithSignal(computeBackoffMs(attempt, retryBaseDelayMs), signal);
          continue;
        }
        break;
      }

      const validation = validateRadarBinaryFrame(buffer, lastContentType);
      lastValidation = validation;
      if (validation.valid) {
        const fetchedAtMs = Date.now();
        return {
          ok: true,
          url,
          status: res.status,
          contentType: lastContentType,
          format: validation.format,
          byteLength: validation.byteLength,
          buffer,
          attempts: totalAttempts,
          fetchedAtMs,
          fetchedAtUtc: new Date(fetchedAtMs).toISOString(),
          fetchedAtCentral: formatCentralTime(fetchedAtMs),
          errorCode: null,
          error: null,
          validation
        };
      }

      const isTruncated = String(validation.reason || '').toLowerCase().includes('truncated') || validation.byteLength === 0;
      lastError = new WeatherApiError(validation.reason || 'Corrupted binary radar frame', {
        code: isTruncated ? 'TRUNCATED_FRAME' : 'CORRUPTED_FRAME',
        status: res.status,
        retryable: isTruncated,
        attempts: totalAttempts,
        url
      });
      if (isTruncated && attempt < safeMaxRetries && !signal?.aborted) {
        await sleepWithSignal(computeBackoffMs(attempt, retryBaseDelayMs), signal);
        continue;
      }
      break;
    } catch (err) {
      const wrapped = err instanceof WeatherApiError
        ? err
        : new WeatherApiError(err?.message || 'Radar frame fetch failed', {
            code: 'NETWORK_ERROR',
            retryable: true,
            url
          });
      lastStatus = wrapped.status || 0;
      lastError = wrapped;

      if (!wrapped.retryable || attempt >= safeMaxRetries || signal?.aborted) {
        break;
      }
      const delayMs = computeBackoffMs(attempt, retryBaseDelayMs, wrapped.retryAfterMs ?? null);
      try {
        await sleepWithSignal(delayMs, signal);
      } catch (abortErr) {
        lastError = abortErr;
        break;
      }
    }
  }

  const fetchedAtMs = Date.now();
  return {
    ok: false,
    url,
    status: lastStatus,
    contentType: lastContentType,
    format: lastValidation?.format || 'unknown',
    byteLength: lastValidation?.byteLength || 0,
    buffer: null,
    attempts: totalAttempts,
    fetchedAtMs,
    fetchedAtUtc: new Date(fetchedAtMs).toISOString(),
    fetchedAtCentral: formatCentralTime(fetchedAtMs),
    errorCode: lastError?.code || 'FETCH_ERROR',
    error: lastError?.message || 'Unable to fetch valid binary radar frame',
    validation: lastValidation
  };
}

/**
 * Hardened binary/image radar frame fetcher with strict AbortController timeout,
 * bounded retries + exponential backoff, fail-fast on 404/CORS/opaque,
 * binary header/truncation validation, optional fallback URL(s), and ZERO unhandled rejections.
 */
export async function fetchRadarBinaryFrame(url, options = {}) {
  const fetchedAtMs = Date.now();
  if (!url || typeof url !== 'string') {
    return {
      ok: false,
      url: String(url || ''),
      status: 0,
      contentType: '',
      format: 'unknown',
      byteLength: 0,
      buffer: null,
      attempts: 0,
      usedFallback: false,
      fallback: true,
      fetchedAtMs,
      fetchedAtUtc: new Date(fetchedAtMs).toISOString(),
      fetchedAtCentral: formatCentralTime(fetchedAtMs),
      errorCode: 'INVALID_URL',
      error: 'Missing or invalid radar frame URL',
      validation: null
    };
  }

  const candidates = [url];
  if (typeof options.fallbackUrl === 'string' && options.fallbackUrl) {
    candidates.push(options.fallbackUrl);
  }
  if (Array.isArray(options.fallbackUrls)) {
    for (const fb of options.fallbackUrls) {
      if (typeof fb === 'string' && fb && !candidates.includes(fb)) {
        candidates.push(fb);
      }
    }
  }

  let totalAttempts = 0;
  let lastResult = null;
  for (let i = 0; i < candidates.length; i++) {
    const res = await fetchSingleRadarBinaryCandidate(candidates[i], options);
    totalAttempts += res.attempts;
    lastResult = res;
    if (res.ok) {
      return {
        ...res,
        attempts: totalAttempts,
        usedFallback: i > 0,
        fallback: i > 0
      };
    }
  }

  return {
    ...(lastResult || {
      ok: false,
      url,
      status: 0,
      contentType: '',
      format: 'unknown',
      byteLength: 0,
      buffer: null,
      fetchedAtMs,
      fetchedAtUtc: new Date(fetchedAtMs).toISOString(),
      fetchedAtCentral: formatCentralTime(fetchedAtMs),
      errorCode: 'FETCH_ERROR',
      error: 'All radar frame candidates failed',
      validation: null
    }),
    attempts: totalAttempts,
    usedFallback: candidates.length > 1,
    fallback: true
  };
}

/* ==================== PUBLIC WEATHER & RADAR FETCHERS ==================== */

function normalizeAlertFeatureTimestamps(feature, timeZone = DEFAULT_TIME_ZONE) {
  if (!feature || typeof feature !== 'object') return feature;
  const p = feature.properties || {};
  const sentMs = parseUtcTimestampMs(p.sent);
  const effectiveMs = parseUtcTimestampMs(p.effective ?? p.onset);
  const expiresMs = parseUtcTimestampMs(p.expires);
  const endsMs = parseUtcTimestampMs(p.ends);

  const normalizedTimestamps = {
    sentMs,
    effectiveMs,
    expiresMs,
    endsMs,
    sentCentral: formatCentralTime(sentMs, timeZone),
    effectiveCentral: formatCentralTime(effectiveMs, timeZone),
    expiresCentral: formatCentralTime(expiresMs, timeZone),
    endsCentral: formatCentralTime(endsMs, timeZone)
  };

  return {
    ...feature,
    ...normalizedTimestamps,
    properties: {
      ...p,
      ...normalizedTimestamps
    }
  };
}

function normalizeStormCellsGeoJson(fc, timeZone = DEFAULT_TIME_ZONE) {
  if (!isValidFeatureCollection(fc)) {
    return { type: 'FeatureCollection', features: [] };
  }
  return {
    ...fc,
    features: fc.features.map((f) => {
      if (!f || typeof f !== 'object') return f;
      const p = f.properties || {};
      const validMs = parseUtcTimestampMs(p.valid);
      if (validMs == null) return f;
      return {
        ...f,
        properties: {
          ...p,
          validMs,
          validUtc: new Date(validMs).toISOString(),
          validCentral: formatCentralTime(validMs, timeZone)
        }
      };
    })
  };
}

function assertValidCoords(lat, lon, context = 'lookup') {
  const numLat = Number(lat);
  const numLon = Number(lon);
  if (
    !Number.isFinite(numLat) ||
    !Number.isFinite(numLon) ||
    Math.abs(numLat) > 90 ||
    Math.abs(numLon) > 180
  ) {
    throw new WeatherApiError(`Invalid coordinates for ${context}`, {
      code: 'INVALID_COORDS',
      retryable: false
    });
  }
  return { lat: numLat, lon: numLon };
}

export function trimNwsGridData(gridPayload) {
  const props = gridPayload?.properties;
  if (!props || typeof props !== 'object') return null;
  const pickSeries = (key) => {
    const s = props[key];
    if (!s || typeof s !== 'object' || !Array.isArray(s.values)) return null;
    return { uom: s.uom || '', values: s.values.slice(0, 120) };
  };
  return {
    snowfallAmount: pickSeries('snowfallAmount'),
    iceAccumulation: pickSeries('iceAccumulation'),
    windChill: pickSeries('windChill'),
    weather: pickSeries('weather'),
    snowLevel: pickSeries('snowLevel'),
    quantitativePrecipitation: pickSeries('quantitativePrecipitation')
  };
}

export async function fetchNwsPointBundle(lat, lon, force = false, options = {}) {
  if (typeof force === 'object' && force !== null) {
    options = force;
    force = Boolean(options.force);
  }
  const { lat: numLat, lon: numLon } = assertValidCoords(lat, lon, 'NWS point lookup');

  const rLat = numLat.toFixed(4);
  const rLon = numLon.toFixed(4);
  const timeZone = options.timeZone || DEFAULT_TIME_ZONE;
  const fetchOpts = {
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    retryBaseDelayMs: options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_MS,
    fetchImpl: options.fetchImpl ?? null,
    signal: options.signal ?? null
  };

  const pointRes = await ttlFetchJsonWithMeta(
    `nws_pt:${rLat},${rLon}`,
    `${NWS_BASE}/points/${rLat},${rLon}`,
    6 * 3600 * 1000,
    {
      headers: { Accept: 'application/geo+json' },
      force,
      validate: (d) => Boolean(d && typeof d === 'object' && d.properties),
      ...fetchOpts
    }
  );
  const pointData = pointRes.data;
  const props = pointData?.properties || {};

  const [forecastRes, hourlyRes, stationsRes, gridRes] = await Promise.allSettled([
    props.forecast
      ? fetchJson(props.forecast, { Accept: 'application/geo+json' }, options.timeoutMs ?? 12000, fetchOpts)
      : Promise.resolve(null),
    props.forecastHourly
      ? fetchJson(props.forecastHourly, { Accept: 'application/geo+json' }, options.timeoutMs ?? 12000, fetchOpts)
      : Promise.resolve(null),
    props.observationStations
      ? ttlFetchJsonWithMeta(
          `nws_stn:${rLat},${rLon}`,
          props.observationStations,
          3600 * 1000,
          {
            headers: { Accept: 'application/geo+json' },
            force,
            validate: (d) => Boolean(d && typeof d === 'object' && Array.isArray(d.features)),
            ...fetchOpts
          }
        )
      : Promise.resolve(null),
    props.forecastGridData
      ? fetchJson(props.forecastGridData, { Accept: 'application/geo+json' }, options.timeoutMs ?? 12000, fetchOpts)
      : Promise.resolve(null)
  ]);

  // Multi-station consensus: query up to 4 closest ASOS/AWOS stations in parallel
  const stationsPayload = stationsRes.status === 'fulfilled' ? stationsRes.value?.data : null;
  const stationsFromCache = stationsRes.status === 'fulfilled' ? Boolean(stationsRes.value?.fromCache) : true;
  const stationFeatures = Array.isArray(stationsPayload?.features)
    ? stationsPayload.features.slice(0, 4)
    : [];

  const obsResults = await Promise.allSettled(
    stationFeatures.map(async (sf) => {
      const sid = sf?.properties?.stationIdentifier;
      if (!sid) return null;
      const obs = await fetchJson(
        `${NWS_BASE}/stations/${encodeURIComponent(sid)}/observations/latest`,
        { Accept: 'application/geo+json' },
        options.obsTimeoutMs ?? 8000,
        fetchOpts
      );
      const obsProps = obs?.properties || null;
      const obsMs = parseUtcTimestampMs(obsProps?.timestamp);
      return {
        stationId: sid,
        stationName: sf.properties?.name || sid,
        coords: sf.geometry?.coordinates || null,
        timestampMs: obsMs,
        timestampUtc: obsMs != null ? new Date(obsMs).toISOString() : null,
        timeCentral: formatCentralTime(obsMs, timeZone),
        props: obsProps
      };
    })
  );

  const observations = obsResults
    .filter((r) => r.status === 'fulfilled' && r.value && r.value.props)
    .map((r) => r.value);

  // Never report a fresh online NWS bundle when point/station metadata came solely from TTL cache
  // and EVERY live forecast/hourly/observation network call failed (e.g. silent offline background poll).
  const hasAnyLiveNwsData =
    !pointRes.fromCache ||
    (props.forecast && forecastRes.status === 'fulfilled') ||
    (props.forecastHourly && hourlyRes.status === 'fulfilled') ||
    (props.forecastGridData && gridRes.status === 'fulfilled' && gridRes.value != null) ||
    (!stationsFromCache && stationsPayload != null) ||
    observations.length > 0;
  if (!hasAnyLiveNwsData) {
    throw new WeatherApiError('All live NWS forecast and observation feeds unavailable', {
      code: 'NWS_OFFLINE',
      retryable: true,
      url: `${NWS_BASE}/points/${rLat},${rLon}`
    });
  }

  let latestObservationMs = null;
  for (const obs of observations) {
    if (obs.timestampMs != null && (latestObservationMs == null || obs.timestampMs > latestObservationMs)) {
      latestObservationMs = obs.timestampMs;
    }
  }

  const fetchedAtMs = Date.now();
  const ageMs = 0;
  const relLoc = props.relativeLocation?.properties;
  const cityLabel = relLoc ? `${relLoc.city}, ${relLoc.state}` : null;

  return {
    cityLabel,
    stateCode: relLoc?.state || null,
    cwa: props.cwa || null,
    radarStation: props.radarStation || null,
    forecastPeriods: forecastRes.status === 'fulfilled' ? (forecastRes.value?.properties?.periods || []) : [],
    hourlyPeriods: hourlyRes.status === 'fulfilled' ? (hourlyRes.value?.properties?.periods || []) : [],
    gridData: gridRes.status === 'fulfilled' ? trimNwsGridData(gridRes.value) : null,
    observations,
    _meta: {
      source: 'nws-point-bundle',
      fetchedAtMs,
      fetchedAtUtc: new Date(fetchedAtMs).toISOString(),
      fetchedAtCentral: formatCentralTime(fetchedAtMs, timeZone),
      pointFetchedAtMs: pointRes.fetchedAtMs,
      latestObservationMs,
      latestObservationUtc: latestObservationMs != null ? new Date(latestObservationMs).toISOString() : null,
      latestObservationCentral: formatCentralTime(latestObservationMs, timeZone),
      ageMs,
      ageMinutes: 0,
      isStale: false,
      degraded: {
        forecast: forecastRes.status !== 'fulfilled',
        hourly: hourlyRes.status !== 'fulfilled',
        stations: stationsRes.status !== 'fulfilled',
        gridData: Boolean(props.forecastGridData) && gridRes.status !== 'fulfilled'
      }
    }
  };
}

export async function fetchNwsAlerts(lat, lon, stateCode = null, options = {}) {
  const numLat = Number(lat);
  const numLon = Number(lon);
  const timeZone = options.timeZone || DEFAULT_TIME_ZONE;
  const nowMs = Date.now();

  if (!Number.isFinite(numLat) || !Number.isFinite(numLon)) {
    return {
      localFeatures: [],
      regionalFeatures: [],
      _meta: {
        source: 'nws-alerts',
        fetchedAtMs: nowMs,
        fetchedAtUtc: new Date(nowMs).toISOString(),
        fetchedAtCentral: formatCentralTime(nowMs, timeZone),
        ageMs: 0,
        ageMinutes: 0,
        isStale: false,
        degraded: true,
        pointOk: false,
        areaOk: false,
        error: 'Invalid coordinates for NWS alerts'
      }
    };
  }

  const rLat = numLat.toFixed(4);
  const rLon = numLon.toFixed(4);
  const fetchOpts = {
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    retryBaseDelayMs: options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_MS,
    fetchImpl: options.fetchImpl ?? null,
    signal: options.signal ?? null
  };
  const timeoutMs = options.timeoutMs ?? 12000;

  const [pointAlertsRes, areaAlertsRes] = await Promise.allSettled([
    fetchJson(`${NWS_BASE}/alerts/active?point=${rLat},${rLon}`, { Accept: 'application/geo+json' }, timeoutMs, fetchOpts),
    stateCode
      ? fetchJson(`${NWS_BASE}/alerts/active?area=${encodeURIComponent(stateCode)}`, { Accept: 'application/geo+json' }, timeoutMs, fetchOpts)
      : Promise.resolve({ features: [] })
  ]);

  const rawLocal = (pointAlertsRes.status === 'fulfilled' && Array.isArray(pointAlertsRes.value?.features))
    ? pointAlertsRes.value.features
    : [];
  const rawRegional = (areaAlertsRes.status === 'fulfilled' && Array.isArray(areaAlertsRes.value?.features))
    ? areaAlertsRes.value.features
    : [];

  const localFeatures = [];
  const seenLocal = new Set();
  for (const lf of rawLocal) {
    const norm = normalizeAlertFeatureTimestamps(lf, timeZone);
    const id = norm?.id || norm?.properties?.id || norm?.properties?.['@id'] || null;
    if (id != null) {
      if (seenLocal.has(id)) continue;
      seenLocal.add(id);
    }
    localFeatures.push(norm);
  }

  const combined = [...localFeatures];
  const seenCombined = new Set(seenLocal);
  for (const rf of rawRegional) {
    const norm = normalizeAlertFeatureTimestamps(rf, timeZone);
    const id = norm?.id || norm?.properties?.id || norm?.properties?.['@id'] || null;
    if (id != null) {
      if (seenCombined.has(id)) continue;
      seenCombined.add(id);
    }
    combined.push(norm);
  }

  const fetchedAtMs = Date.now();
  const pointOk = pointAlertsRes.status === 'fulfilled';
  const areaOk = !stateCode || areaAlertsRes.status === 'fulfilled';
  const errors = [];
  if (!pointOk) errors.push(`point: ${pointAlertsRes.reason?.message || 'failed'}`);
  if (!areaOk) errors.push(`area: ${areaAlertsRes.reason?.message || 'failed'}`);

  return {
    localFeatures,
    regionalFeatures: combined,
    _meta: {
      source: 'nws-alerts',
      fetchedAtMs,
      fetchedAtUtc: new Date(fetchedAtMs).toISOString(),
      fetchedAtCentral: formatCentralTime(fetchedAtMs, timeZone),
      ageMs: 0,
      ageMinutes: 0,
      isStale: false,
      degraded: !pointOk || !areaOk,
      pointOk,
      areaOk,
      error: errors.length ? errors.join('; ') : null
    }
  };
}

export async function fetchOpenMeteo(lat, lon, options = {}) {
  const { lat: numLat, lon: numLon } = assertValidCoords(lat, lon, 'Open-Meteo lookup');

  const params = new URLSearchParams({
    latitude: numLat.toFixed(4),
    longitude: numLon.toFixed(4),
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    precipitation_unit: 'inch',
    timezone: 'auto',
    past_hours: '6',
    forecast_days: '4',
    current: [
      'temperature_2m',
      'relative_humidity_2m',
      'apparent_temperature',
      'dew_point_2m',
      'precipitation',
      'rain',
      'snowfall',
      'weather_code',
      'cloud_cover',
      'pressure_msl',
      'surface_pressure',
      'wind_speed_10m',
      'wind_direction_10m',
      'wind_gusts_10m'
    ].join(','),
    hourly: [
      'temperature_2m',
      'dew_point_2m',
      'wet_bulb_temperature_2m',
      'relative_humidity_2m',
      'apparent_temperature',
      'precipitation_probability',
      'precipitation',
      'rain',
      'showers',
      'snowfall',
      'snow_depth',
      'weather_code',
      'pressure_msl',
      'surface_pressure',
      'visibility',
      'wind_speed_10m',
      'wind_direction_10m',
      'temperature_925hPa',
      'wind_speed_925hPa',
      'wind_direction_925hPa',
      'temperature_850hPa',
      'wind_speed_850hPa',
      'wind_direction_850hPa',
      'wind_speed_700hPa',
      'wind_direction_700hPa',
      'wind_speed_500hPa',
      'wind_direction_500hPa',
      'temperature_700hPa',
      'temperature_500hPa',
      'geopotential_height_700hPa',
      'geopotential_height_500hPa',
      'wind_gusts_10m',
      'cape',
      'convective_inhibition',
      'freezing_level_height',
      'soil_temperature_0cm',
      'soil_temperature_6cm'
    ].join(',')
  });

  const data = await fetchJson(
    `${OPEN_METEO_BASE}?${params.toString()}`,
    {},
    options.timeoutMs ?? 12000,
    {
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      retryBaseDelayMs: options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_MS,
      fetchImpl: options.fetchImpl ?? null,
      signal: options.signal ?? null
    }
  );

  if (!data || typeof data !== 'object' || (!data.current && !data.hourly)) {
    throw new WeatherApiError('Malformed Open-Meteo response payload', {
      code: 'INVALID_PAYLOAD',
      retryable: false,
      url: OPEN_METEO_BASE
    });
  }

  const timeZone = options.timeZone || DEFAULT_TIME_ZONE;
  const fetchedAtMs = parseUtcTimestampMs(options.nowMs) ?? Date.now();
  const utcOffsetSeconds = Number.isFinite(data.utc_offset_seconds) ? data.utc_offset_seconds : 0;

  let latestModelTimeMs = null;
  let normalizedCurrent = data.current;
  if (data.current && typeof data.current === 'object') {
    const curMs = parseUtcTimestampMs(data.current.time, { utcOffsetSeconds });
    if (curMs != null) {
      latestModelTimeMs = curMs;
      normalizedCurrent = {
        ...data.current,
        time: new Date(curMs).toISOString(),
        timeMs: curMs,
        timeCentral: formatCentralTime(curMs, timeZone)
      };
    }
  }

  let normalizedHourly = data.hourly;
  if (data.hourly && Array.isArray(data.hourly.time)) {
    const timeMs = [];
    const normalizedTimes = data.hourly.time.map((t) => {
      const ms = parseUtcTimestampMs(t, { utcOffsetSeconds });
      timeMs.push(ms);
      return ms != null ? new Date(ms).toISOString() : t;
    });
    normalizedHourly = {
      ...data.hourly,
      time: normalizedTimes,
      timeMs
    };
    if (latestModelTimeMs == null) {
      // Closest non-future hourly slot as model timestamp fallback
      for (const ms of timeMs) {
        if (ms != null && ms <= fetchedAtMs && (latestModelTimeMs == null || ms > latestModelTimeMs)) {
          latestModelTimeMs = ms;
        }
      }
    }
  }

  const effectiveMs = latestModelTimeMs != null ? Math.min(fetchedAtMs, latestModelTimeMs) : fetchedAtMs;
  const ageMs = Math.max(0, fetchedAtMs - effectiveMs);
  const ageMinutes = Number((ageMs / 60000).toFixed(1));
  const isStale = ageMs > STALE_THRESHOLD_MS;

  return {
    ...data,
    current: normalizedCurrent,
    hourly: normalizedHourly,
    _meta: {
      source: 'open-meteo',
      fetchedAtMs,
      fetchedAtUtc: new Date(fetchedAtMs).toISOString(),
      fetchedAtCentral: formatCentralTime(fetchedAtMs, timeZone),
      latestModelTimeMs,
      latestModelTimeUtc: latestModelTimeMs != null ? new Date(latestModelTimeMs).toISOString() : null,
      latestModelTimeCentral: formatCentralTime(latestModelTimeMs, timeZone),
      ageMs,
      ageMinutes,
      isStale
    }
  };
}

export async function fetchSpcOverlayLayer(layerId = 1, force = false, options = {}) {
  const url = `${SPC_MAPSERVER_BASE}/${layerId}/query?where=1%3D1&outFields=*&f=geojson`;
  const commonOpts = {
    timeoutMs: options.timeoutMs ?? 10000,
    force,
    validate: isValidFeatureCollection,
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    retryBaseDelayMs: options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_MS,
    fetchImpl: options.fetchImpl ?? null,
    signal: options.signal ?? null
  };
  try {
    return await ttlFetchJson(`spc_lyr:${layerId}`, url, 15 * 60 * 1000, commonOpts);
  } catch {
    if (layerId === 1) {
      return ttlFetchJson('spc_lyr:1_fb', SPC_DAY1_FALLBACK_URL, 15 * 60 * 1000, commonOpts)
        .catch(() => ({ type: 'FeatureCollection', features: [] }));
    }
    return { type: 'FeatureCollection', features: [] };
  }
}

export async function fetchWpcFloodOutlook(force = false, options = {}) {
  try {
    return await ttlFetchJson('wpc_ero', WPC_ERO_URL, 15 * 60 * 1000, {
      timeoutMs: options.timeoutMs ?? 10000,
      force,
      validate: isValidFeatureCollection,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      retryBaseDelayMs: options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_MS,
      fetchImpl: options.fetchImpl ?? null,
      signal: options.signal ?? null
    });
  } catch {
    return { type: 'FeatureCollection', features: [] };
  }
}

export async function fetchOpenMeteoWinterModels(lat, lon, force = false, options = {}) {
  if (typeof force === 'object' && force !== null) {
    options = force;
    force = Boolean(options.force);
  } else {
    force = Boolean(force || options?.force);
  }
  const { lat: rLat, lon: rLon } = assertValidCoords(lat, lon, 'Open-Meteo winter models lookup');
  const qLat = rLat.toFixed(4);
  const qLon = rLon.toFixed(4);
  const params = new URLSearchParams({
    latitude: qLat,
    longitude: qLon,
    models: 'gfs_hrrr,gfs_seamless,ecmwf_ifs025',
    temperature_unit: 'fahrenheit',
    precipitation_unit: 'inch',
    timezone: 'UTC',
    forecast_days: '3',
    hourly: [
      'temperature_2m',
      'wet_bulb_temperature_2m',
      'precipitation',
      'rain',
      'snowfall',
      'snow_depth',
      'weather_code',
      'temperature_925hPa',
      'temperature_850hPa'
    ].join(',')
  });
  const url = `${OPEN_METEO_BASE}?${params.toString()}`;
  return ttlFetchJson(`om_wint_models:${qLat},${qLon}`, url, 10 * 60 * 1000, {
    timeoutMs: options.timeoutMs ?? 12000,
    force,
    validate: (d) => Boolean(d && typeof d === 'object' && d.hourly && typeof d.hourly === 'object'),
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    retryBaseDelayMs: options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_MS,
    fetchImpl: options.fetchImpl ?? null,
    signal: options.signal ?? null
  });
}

async function fetchWpcWssiLayerWithStatus(layerId = 4, force = false, options = {}) {
  if (typeof force === 'object' && force !== null) {
    options = force;
    force = Boolean(options.force);
  }
  const numId = Number(layerId);
  const safeId = Number.isFinite(numId) && numId >= 0 ? Math.trunc(numId) : 4;
  const url = `${WPC_WSSI_BASE}/${safeId}/query?where=1%3D1&outFields=*&f=geojson`;
  try {
    const data = await ttlFetchJson(`wpc_wssi:${safeId}`, url, 15 * 60 * 1000, {
      timeoutMs: options.timeoutMs ?? 10000,
      force,
      validate: isValidFeatureCollection,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      retryBaseDelayMs: options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_MS,
      fetchImpl: options.fetchImpl ?? null,
      signal: options.signal ?? null
    });
    return { ok: true, data };
  } catch {
    return { ok: false, data: { type: 'FeatureCollection', features: [] } };
  }
}

export async function fetchWpcWssiLayer(layerId = 4, force = false, options = {}) {
  const res = await fetchWpcWssiLayerWithStatus(layerId, force, options);
  return res.data;
}

export async function fetchWpcWssiBundle(overlayLayerId = 4, force = false, options = {}) {
  if (typeof overlayLayerId === 'object' && overlayLayerId !== null) {
    options = overlayLayerId;
    force = Boolean(options.force);
    overlayLayerId = options.overlayLayerId ?? 4;
  } else if (typeof force === 'object' && force !== null) {
    options = force;
    force = Boolean(options.force);
  }
  const layerIds = [4, 1, 2, 3, 19, 9];
  const results = await Promise.all(
    layerIds.map((id) => fetchWpcWssiLayerWithStatus(id, force, options))
  );
  const layers = {};
  const failedLayerIds = [];
  let succeededCount = 0;
  layerIds.forEach((id, i) => {
    const entry = results[i];
    if (entry?.ok && entry.data) {
      layers[id] = entry.data;
      succeededCount += 1;
    } else {
      layers[id] = { type: 'FeatureCollection', features: [] };
      failedLayerIds.push(id);
    }
  });
  const reqId = Number(overlayLayerId);
  const activeId = layers[reqId] ? reqId : 4;
  const nowMs = Date.now();
  return {
    overlayLayerId: activeId,
    layers,
    overlayGeoJson: layers[activeId] || { type: 'FeatureCollection', features: [] },
    fetchedAtMs: nowMs,
    _meta: {
      degraded: failedLayerIds.length > 0,
      allFailed: succeededCount === 0,
      succeededCount,
      failedLayerIds,
      fetchedAtMs: succeededCount > 0 ? nowMs : null
    }
  };
}

export async function fetchNwsAfd(cwa, force = false, options = {}) {
  if (!cwa) return null;
  const cacheKey = `afd:${cwa}`;
  const timeZone = options.timeZone || DEFAULT_TIME_ZONE;
  if (!force) {
    const cached = RESPONSE_CACHE.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) return cached.data;
  }
  const fetchOpts = {
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    retryBaseDelayMs: options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_MS,
    fetchImpl: options.fetchImpl ?? null,
    signal: options.signal ?? null
  };
  try {
    const list = await fetchJson(
      `${NWS_BASE}/products/types/AFD/locations/${encodeURIComponent(cwa)}`,
      { Accept: 'application/ld+json' },
      options.timeoutMs ?? 8000,
      fetchOpts
    );
    const first = list?.['@graph']?.[0];
    if (!first?.id) return null;
    const detail = await fetchJson(
      `${NWS_BASE}/products/${encodeURIComponent(first.id)}`,
      { Accept: 'application/ld+json' },
      options.timeoutMs ?? 9000,
      fetchOpts
    );
    const fullText = (detail?.productText || '').trim();
    if (!fullText) return null;

    // Extract Synopsis / Key Messages / Short Term excerpt
    const lines = fullText.split('\n').map((l) => l.trim()).filter(Boolean);
    const keyIdx = lines.findIndex((l) => l.includes('.KEY MESSAGES') || l.includes('.SYNOPSIS') || l.includes('.SHORT TERM'));
    const excerptLines = keyIdx >= 0 ? lines.slice(keyIdx, keyIdx + 8) : lines.slice(0, 7);
    const issuedMs = parseUtcTimestampMs(detail?.issuanceTime);
    const issuedLabel = issuedMs != null ? formatCentralTime(issuedMs, timeZone) : 'Latest';
    const rawOffice = detail?.issuingOffice || `NWS ${cwa}`;
    const office = rawOffice.toUpperCase().startsWith('NWS') ? rawOffice : `NWS ${rawOffice}`;
    const fetchedAtMs = Date.now();

    const result = {
      office,
      issuedLabel,
      issuedMs,
      issuedUtc: issuedMs != null ? new Date(issuedMs).toISOString() : null,
      issuedCentral: issuedLabel,
      synopsisExcerpt: excerptLines.join('\n'),
      fullText,
      _meta: {
        source: 'nws-afd',
        fetchedAtMs,
        fetchedAtUtc: new Date(fetchedAtMs).toISOString(),
        fetchedAtCentral: formatCentralTime(fetchedAtMs, timeZone)
      }
    };
    setCacheEntry(cacheKey, result, 10 * 60 * 1000, fetchedAtMs);
    return result;
  } catch {
    return null;
  }
}

export async function fetchIemStormIntel(spcOverlayLayerId = 1, options = {}) {
  const includeFlood = typeof options === 'boolean' ? options : Boolean(options?.includeFlood);
  const force = typeof options === 'object' ? Boolean(options?.force) : false;
  const timeZone = (typeof options === 'object' && options?.timeZone) ? options.timeZone : DEFAULT_TIME_ZONE;
  const empty = { type: 'FeatureCollection', features: [] };

  const sharedOpts = {
    timeoutMs: (typeof options === 'object' && options?.timeoutMs) ? options.timeoutMs : 10000,
    force,
    validate: isValidFeatureCollection,
    maxRetries: (typeof options === 'object' && options?.maxRetries != null) ? options.maxRetries : DEFAULT_MAX_RETRIES,
    retryBaseDelayMs: (typeof options === 'object' && options?.retryBaseDelayMs != null) ? options.retryBaseDelayMs : DEFAULT_RETRY_BASE_MS,
    fetchImpl: (typeof options === 'object' && options?.fetchImpl) ? options.fetchImpl : null,
    signal: (typeof options === 'object' && options?.signal) ? options.signal : null
  };

  const cachedWpc = RESPONSE_CACHE.get('wpc_ero');
  const validCachedWpc = (cachedWpc && Date.now() < cachedWpc.expiresAt) ? cachedWpc.data : empty;

  const [
    cellsRes, lsrRes, mcdRes, watchRes, wpcRes,
    spcOverlayRes, spcDay1Res, spcTorRes, spcHailRes, spcWindRes, spcDay2Res, spcDay3Res
  ] = await Promise.allSettled([
    ttlFetchJsonWithMeta('iem_cells', `${IEM_BASE}/geojson/nexrad_attr.geojson`, 40000, sharedOpts),
    ttlFetchJson('iem_lsr', `${IEM_BASE}/geojson/lsr.geojson?hours=6`, 40000, sharedOpts),
    ttlFetchJson('iem_mcd', `${IEM_BASE}/geojson/mcd.geojson`, 40000, sharedOpts),
    ttlFetchJson('iem_watch', `${IEM_BASE}/geojson/spc_watch.geojson`, 40000, sharedOpts),
    includeFlood ? fetchWpcFloodOutlook(force, sharedOpts) : Promise.resolve(validCachedWpc),
    fetchSpcOverlayLayer(spcOverlayLayerId, force, sharedOpts),
    spcOverlayLayerId === 1 ? Promise.resolve(null) : fetchSpcOverlayLayer(1, force, sharedOpts),
    fetchSpcOverlayLayer(3, force, sharedOpts),
    fetchSpcOverlayLayer(5, force, sharedOpts),
    fetchSpcOverlayLayer(7, force, sharedOpts),
    fetchSpcOverlayLayer(9, force, sharedOpts),
    fetchSpcOverlayLayer(17, force, sharedOpts)
  ]);

  const overlayGeo = spcOverlayRes.status === 'fulfilled' ? spcOverlayRes.value : empty;
  const day1CatGeo = spcOverlayLayerId === 1
    ? overlayGeo
    : (spcDay1Res.status === 'fulfilled' && spcDay1Res.value ? spcDay1Res.value : empty);

  const cellsFetchedAtMs = cellsRes.status === 'fulfilled' ? cellsRes.value.fetchedAtMs : null;
  const stormCellsGeoJson = cellsRes.status === 'fulfilled'
    ? normalizeStormCellsGeoJson(cellsRes.value.data, timeZone)
    : empty;

  let latestCellMs = null;
  for (const f of stormCellsGeoJson.features) {
    const ms = f?.properties?.validMs;
    if (ms != null && (latestCellMs == null || ms > latestCellMs)) {
      latestCellMs = ms;
    }
  }

  const nowMs = Date.now();
  const effectiveMs = latestCellMs != null && cellsFetchedAtMs != null
    ? Math.min(cellsFetchedAtMs, latestCellMs)
    : (latestCellMs ?? cellsFetchedAtMs);
  const ageMs = effectiveMs != null ? Math.max(0, nowMs - effectiveMs) : 0;
  const ageMinutes = Number((ageMs / 60000).toFixed(1));

  const degradedFeeds = [];
  if (cellsRes.status !== 'fulfilled') degradedFeeds.push('stormCells');
  if (lsrRes.status !== 'fulfilled') degradedFeeds.push('lsr');
  if (mcdRes.status !== 'fulfilled') degradedFeeds.push('mcd');
  if (watchRes.status !== 'fulfilled') degradedFeeds.push('spcWatches');
  if (wpcRes.status !== 'fulfilled') degradedFeeds.push('wpcFlood');
  if (spcOverlayRes.status !== 'fulfilled') degradedFeeds.push('spcOverlay');

  const succeededFeeds = [];
  if (cellsRes.status === 'fulfilled') succeededFeeds.push('stormCells');
  if (lsrRes.status === 'fulfilled') succeededFeeds.push('lsr');
  if (mcdRes.status === 'fulfilled') succeededFeeds.push('mcd');
  if (watchRes.status === 'fulfilled') succeededFeeds.push('spcWatches');
  if (includeFlood && wpcRes.status === 'fulfilled' && wpcRes.value?.features?.length) succeededFeeds.push('wpcFlood');
  if (spcOverlayRes.status === 'fulfilled' && overlayGeo?.features?.length) succeededFeeds.push('spcOverlay');

  return {
    stormCellsGeoJson,
    lsrGeoJson: lsrRes.status === 'fulfilled' ? lsrRes.value : empty,
    mcdGeoJson: mcdRes.status === 'fulfilled' ? mcdRes.value : empty,
    spcWatchesGeoJson: watchRes.status === 'fulfilled' ? watchRes.value : empty,
    wpcFloodGeoJson: wpcRes.status === 'fulfilled' ? wpcRes.value : empty,
    spcOverlayGeoJson: overlayGeo,
    spcDay1GeoJson: day1CatGeo,
    spcDay1TorGeoJson: spcTorRes.status === 'fulfilled' ? spcTorRes.value : empty,
    spcDay1HailGeoJson: spcHailRes.status === 'fulfilled' ? spcHailRes.value : empty,
    spcDay1WindGeoJson: spcWindRes.status === 'fulfilled' ? spcWindRes.value : empty,
    spcDay2GeoJson: spcDay2Res.status === 'fulfilled' ? spcDay2Res.value : empty,
    spcDay3GeoJson: spcDay3Res.status === 'fulfilled' ? spcDay3Res.value : empty,
    _meta: {
      source: 'iem-storm-intel',
      fetchedAtMs: cellsFetchedAtMs,
      fetchedAtUtc: cellsFetchedAtMs != null ? new Date(cellsFetchedAtMs).toISOString() : null,
      fetchedAtCentral: cellsFetchedAtMs != null ? formatCentralTime(cellsFetchedAtMs, timeZone) : '--',
      latestCellMs,
      latestCellUtc: latestCellMs != null ? new Date(latestCellMs).toISOString() : null,
      latestCellCentral: formatCentralTime(latestCellMs, timeZone),
      ageMs,
      ageMinutes,
      isStale: effectiveMs != null && ageMs > STALE_THRESHOLD_MS,
      degraded: degradedFeeds.length > 0,
      degradedFeeds,
      succeededFeeds,
      anyCoreFeedSucceeded: cellsRes.status === 'fulfilled' || lsrRes.status === 'fulfilled' || mcdRes.status === 'fulfilled' || watchRes.status === 'fulfilled'
    }
  };
}

function attachFramesMeta(frames, meta) {
  Object.defineProperty(frames, '_meta', {
    value: meta,
    enumerable: false,
    configurable: true,
    writable: true
  });
  return frames;
}

export async function buildRadarFrames(productCode = 'CONUS_MOSAIC', siteId = 'KGWX', options = {}) {
  const prod = productCode || 'CONUS_MOSAIC';
  const timeZone = options.timeZone || DEFAULT_TIME_ZONE;
  const nowMs = parseUtcTimestampMs(options.nowMs) ?? Date.now();
  const now = new Date(nowMs);

  if (prod === 'CONUS_MOSAIC') {
    const offsets = [45, 40, 35, 30, 25, 20, 15, 10, 5, 0];
    const frames = offsets.map((minsAgo) => {
      const tsMs = nowMs - minsAgo * 60000;
      const t = new Date(tsMs);
      const timeCentral = formatCentralTime(tsMs, timeZone);
      const suffix = minsAgo === 0 ? '' : `-m${String(minsAgo).padStart(2, '0')}m`;
      return {
        id: `conus_${minsAgo}`,
        tileUrl: `${IEM_BASE}/cache/tile.py/1.0.0/nexrad-n0q-900913${suffix}/{z}/{x}/{y}.png`,
        timestamp: t,
        timestampMs: tsMs,
        timestampUtc: t.toISOString(),
        timeCentral,
        ageMinutes: minsAgo,
        isStale: minsAgo * 60000 > STALE_THRESHOLD_MS,
        isFallback: false,
        label: minsAgo === 0 ? `LIVE (CONUS) · ${timeCentral}` : `-${minsAgo}m · ${timeCentral}`,
        feedLabel: 'IEM CONUS High-Res'
      };
    });

    const latestFrameMs = frames[frames.length - 1]?.timestampMs ?? nowMs;
    const ageMs = Math.max(0, nowMs - latestFrameMs);
    return attachFramesMeta(frames, {
      source: 'iem-conus',
      productCode: prod,
      siteId: null,
      fetchedAtMs: nowMs,
      fetchedAtUtc: now.toISOString(),
      fetchedAtCentral: formatCentralTime(nowMs, timeZone),
      latestFrameMs,
      latestFrameUtc: new Date(latestFrameMs).toISOString(),
      latestFrameCentral: formatCentralTime(latestFrameMs, timeZone),
      ageMs,
      ageMinutes: Number((ageMs / 60000).toFixed(1)),
      isStale: ageMs > STALE_THRESHOLD_MS,
      fallback: false,
      error: null
    });
  }

  // Single-site NEXRAD RIDGE via IEM (strip leading K/P/T/R for 3-char IEM radar code)
  const rawSite = String(siteId || 'KGWX').trim().toUpperCase() || 'KGWX';
  const site3 = rawSite.length === 4 ? rawSite.slice(1) : rawSite;
  const startIso = new Date(nowMs - 75 * 60000).toISOString().slice(0, 16) + 'Z';
  const endIso = now.toISOString().slice(0, 16) + 'Z';

  let fallbackError = null;
  try {
    const res = await fetchJson(
      `${IEM_BASE}/json/radar.py?operation=list&radar=${encodeURIComponent(site3)}&product=${encodeURIComponent(prod)}&start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`,
      {},
      options.timeoutMs ?? 8000,
      {
        maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
        retryBaseDelayMs: options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_MS,
        fetchImpl: options.fetchImpl ?? null,
        signal: options.signal ?? null
      }
    );
    const rawScans = Array.isArray(res?.scans) ? res.scans : [];
    const parsedScans = rawScans
      .map((sc) => ({ sc, tsMs: parseUtcTimestampMs(sc?.ts) }))
      .filter((item) => item.tsMs != null)
      .sort((a, b) => a.tsMs - b.tsMs)
      .slice(-10);

    if (parsedScans.length > 0) {
      const frames = parsedScans.map(({ tsMs }, idx) => {
        const d = new Date(tsMs);
        const ridgeTs = formatUtcCompact12(tsMs);
        const isLast = idx === parsedScans.length - 1;
        const ageMs = Math.max(0, nowMs - tsMs);
        const ageMinutes = Number((ageMs / 60000).toFixed(1));
        const isStale = ageMs > STALE_THRESHOLD_MS;
        const timeCentral = formatCentralTime(tsMs, timeZone);
        const suffixTag = isLast ? (isStale ? ' (Stale)' : ' (Latest)') : '';
        return {
          id: `ridge_${site3}_${prod}_${ridgeTs}`,
          tileUrl: `${IEM_BASE}/cache/tile.py/1.0.0/ridge::${site3}-${prod}-${ridgeTs}/{z}/{x}/{y}.png`,
          timestamp: d,
          timestampMs: tsMs,
          timestampUtc: d.toISOString(),
          timeCentral,
          ageMinutes,
          isStale,
          isFallback: false,
          label: `${rawSite} ${prod} · ${timeCentral}${suffixTag}`,
          feedLabel: `IEM RIDGE ${rawSite}`
        };
      });

      const latestFrameMs = frames[frames.length - 1].timestampMs;
      const latestAgeMs = Math.max(0, nowMs - latestFrameMs);
      return attachFramesMeta(frames, {
        source: `iem-ridge-${site3}`,
        productCode: prod,
        siteId: rawSite,
        fetchedAtMs: nowMs,
        fetchedAtUtc: now.toISOString(),
        fetchedAtCentral: formatCentralTime(nowMs, timeZone),
        latestFrameMs,
        latestFrameUtc: new Date(latestFrameMs).toISOString(),
        latestFrameCentral: formatCentralTime(latestFrameMs, timeZone),
        ageMs: latestAgeMs,
        ageMinutes: Number((latestAgeMs / 60000).toFixed(1)),
        isStale: latestAgeMs > STALE_THRESHOLD_MS,
        fallback: false,
        error: null
      });
    }
    fallbackError = 'No valid NEXRAD scans returned';
  } catch (err) {
    fallbackError = err?.message || 'Radar scan list unavailable';
  }

  const timeCentral = formatCentralTime(nowMs, timeZone);
  const fallbackFrames = [
    {
      id: `ridge_${site3}_${prod}_0`,
      tileUrl: `${IEM_BASE}/c/tile.py/1.0.0/ridge::${site3}-${prod}-0/{z}/{x}/{y}.png`,
      timestamp: now,
      timestampMs: nowMs,
      timestampUtc: now.toISOString(),
      timeCentral,
      ageMinutes: 0,
      isStale: false,
      isFallback: true,
      label: `${rawSite} ${prod} · LIVE (${timeCentral})`,
      feedLabel: `IEM RIDGE ${rawSite} (Fallback)`
    }
  ];

  return attachFramesMeta(fallbackFrames, {
    source: `iem-ridge-${site3}`,
    productCode: prod,
    siteId: rawSite,
    fetchedAtMs: nowMs,
    fetchedAtUtc: now.toISOString(),
    fetchedAtCentral: timeCentral,
    latestFrameMs: nowMs,
    latestFrameUtc: now.toISOString(),
    latestFrameCentral: timeCentral,
    ageMs: 0,
    ageMinutes: 0,
    isStale: false,
    fallback: true,
    error: fallbackError
  });
}

export async function searchLocations(query, options = {}) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const url = `${GEOCODE_BASE}?name=${encodeURIComponent(q)}&count=8&language=en&format=json`;
  const data = await fetchJson(url, {}, options.timeoutMs ?? 8000, {
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    retryBaseDelayMs: options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_MS,
    fetchImpl: options.fetchImpl ?? null,
    signal: options.signal ?? null
  });
  const results = Array.isArray(data?.results) ? data.results : [];
  return results
    .filter((r) => r && Number.isFinite(Number(r.latitude)) && Number.isFinite(Number(r.longitude)))
    .filter((r) => r.country_code === 'US' || results.length <= 3)
    .map((r) => ({
      name: r.admin1 ? `${r.name}, ${r.admin1}` : r.name,
      sub: [r.admin2, r.country].filter(Boolean).join(' • '),
      lat: Number(r.latitude),
      lon: Number(r.longitude)
    }));
}
