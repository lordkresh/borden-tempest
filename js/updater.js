import { DEFAULT_TIME_ZONE, formatCentralTime, parseUtcTimestampMs } from './weatherApi.js';

export const APP_LOCAL_VERSION = {
  versionCode: 13,
  versionName: '1.7.1',
  platform: 'iOS / Web PWA'
};

const UPDATE_TIMEOUT_MS = 8000;
const UPDATE_MAX_RETRIES = 2;
const UPDATE_RETRY_BASE_MS = 250;
const MAX_RETRY_AFTER_MS = 2500;
const RETRYABLE_UPDATE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function parseRetryAfterMs(headers) {
  if (!headers) return null;
  const raw = typeof headers.get === 'function'
    ? String(headers.get('retry-after') || '').trim()
    : String(headers['retry-after'] || headers['Retry-After'] || '').trim();
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
  return msg.includes('cors') || msg.includes('cross-origin') || msg.includes('opaque');
}

function sleep(ms) {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, label = 'Operation') {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  // Avoid unhandled rejections if the underlying promise settles after timeout
  Promise.resolve(promise).catch(() => {});
  return Promise.race([Promise.resolve(promise), timeoutPromise]).finally(() => clearTimeout(timer));
}

async function fetchManifestWithRetry(url, {
  timeoutMs = UPDATE_TIMEOUT_MS,
  maxRetries = UPDATE_MAX_RETRIES,
  retryBaseDelayMs = UPDATE_RETRY_BASE_MS,
  fetchImpl = null
} = {}) {
  const fetcher = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof fetcher !== 'function') {
    throw new Error('Fetch API unavailable');
  }

  const safeRetries = Math.max(0, Math.min(4, Number.isFinite(maxRetries) ? Math.floor(maxRetries) : UPDATE_MAX_RETRIES));
  const safeTimeout = Math.max(10, Number.isFinite(timeoutMs) ? timeoutMs : UPDATE_TIMEOUT_MS);
  const safeBase = Math.max(0, Number.isFinite(retryBaseDelayMs) ? retryBaseDelayMs : UPDATE_RETRY_BASE_MS);
  let lastErr = null;

  for (let attempt = 0; attempt <= safeRetries; attempt++) {
    const controller = new AbortController();
    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try {
          controller.abort();
        } catch {
          // ignore abort errors
        }
        const err = new Error(`Update check timed out after ${safeTimeout}ms`);
        err.retryable = true;
        err.code = 'TIMEOUT';
        reject(err);
      }, safeTimeout);
    });

    const workPromise = (async () => {
      const resp = await fetcher(url, { cache: 'no-store', signal: controller.signal });
      if (!resp) {
        const err = new Error('Empty response from update server');
        err.retryable = true;
        throw err;
      }
      const status = typeof resp.status === 'number' ? resp.status : (resp.ok ? 200 : 0);
      if (resp.type === 'opaque' || (status === 0 && !resp.ok)) {
        const err = new Error('CORS or opaque response from update server');
        err.retryable = false;
        err.code = 'CORS_OPAQUE';
        throw err;
      }
      if (!resp.ok) {
        const err = new Error(`HTTP ${status}`);
        err.status = status;
        err.code = `HTTP_${status}`;
        err.retryable = RETRYABLE_UPDATE_STATUSES.has(status);
        err.retryAfterMs = parseRetryAfterMs(resp.headers);
        throw err;
      }
      let manifest;
      try {
        manifest = await resp.json();
      } catch {
        const err = new Error('Malformed update manifest JSON');
        err.retryable = false;
        err.code = 'INVALID_JSON';
        throw err;
      }
      if (!manifest || typeof manifest !== 'object' || !Number.isFinite(Number(manifest.versionCode))) {
        const err = new Error('Invalid update manifest payload');
        err.retryable = false;
        err.code = 'INVALID_MANIFEST';
        throw err;
      }
      return manifest;
    })();

    workPromise.catch(() => {});

    try {
      const manifest = await Promise.race([workPromise, timeoutPromise]);
      return { manifest, attempts: attempt + 1 };
    } catch (err) {
      lastErr = err;
      const retryable = err?.retryable === true || (err?.retryable !== false && !isExplicitCorsError(err));
      if (!retryable || attempt >= safeRetries) {
        throw err;
      }
      const expDelay = safeBase * (2 ** attempt);
      const delayMs = err?.retryAfterMs != null ? Math.max(expDelay, err.retryAfterMs) : expDelay;
      await sleep(delayMs);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr || new Error('Unable to reach update server');
}

class TempestUpdater {
  constructor() {
    this.registration = null;
    this.remoteManifest = null;
    this.updateAvailable = false;
    this.onUpdateFound = null;
    this.lastCheckedAtMs = null;
    this._initialized = false;
    this._inFlightCheck = null;
  }

  isIOS() {
    if (typeof navigator === 'undefined') return false;
    return /iPad|iPhone|iPod/.test(navigator.userAgent || '') ||
      (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
  }

  isStandalone() {
    if (typeof window === 'undefined') return false;
    const mediaStandalone = typeof window.matchMedia === 'function'
      ? window.matchMedia('(display-mode: standalone)').matches
      : false;
    return mediaStandalone || window.navigator?.standalone === true;
  }

  _notifyUpdate(manifest) {
    if (typeof this.onUpdateFound !== 'function') return;
    try {
      this.onUpdateFound(manifest);
    } catch {
      // Never allow UI callback errors to cause unhandled rejections
    }
  }

  _quietlyActivateStaleWaiting() {
    const waiting = this.registration?.waiting;
    if (!waiting || typeof waiting.postMessage !== 'function') return;
    try {
      waiting.postMessage({ type: 'SKIP_WAITING' });
    } catch {
      // Ignore postMessage failures on redundant or restricted workers
    }
  }

  _canSurfaceOfflineWaiting() {
    if (!this.registration?.waiting || !navigator.serviceWorker?.controller) return false;
    const knownRemote = Number(this.remoteManifest?.versionCode);
    if (Number.isFinite(knownRemote) && knownRemote <= APP_LOCAL_VERSION.versionCode) {
      return false;
    }
    return true;
  }

  async init(onUpdateFound) {
    this.onUpdateFound = onUpdateFound;
    if (this._initialized) {
      return this.checkForUpdates(true).catch(() => null);
    }
    this._initialized = true;

    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator && navigator.serviceWorker) {
      try {
        this.registration = await withTimeout(
          navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }),
          UPDATE_TIMEOUT_MS,
          'Service worker registration'
        );
        if (this.registration && typeof this.registration.addEventListener === 'function') {
          this.registration.addEventListener('updatefound', () => {
            const nw = this.registration?.installing;
            if (!nw) return;
            nw.addEventListener('statechange', () => {
              if (nw.state === 'installed' && navigator.serviceWorker?.controller) {
                // Verify version.json before notifying so a same-version SW never triggers a false update loop
                void this.checkForUpdates(true, { force: true }).then((res) => {
                  if (res?.status === 'ERROR' && this._canSurfaceOfflineWaiting()) {
                    this.updateAvailable = true;
                    this._notifyUpdate(this.remoteManifest);
                  }
                });
              }
            });
          });
        }
      } catch {
        // Service workers may be disabled on non-HTTPS origins or restricted WebViews
      }
    }

    // Automatic startup check: verify version.json before flagging a waiting SW so same-version builds never loop
    const checkRes = await this.checkForUpdates(true).catch(() => ({ status: 'ERROR' }));
    if (checkRes?.status === 'ERROR' && this._canSurfaceOfflineWaiting()) {
      this.updateAvailable = true;
      this._notifyUpdate(this.remoteManifest);
    }
    return checkRes;
  }

  async checkForUpdates(silent = false, options = {}) {
    if (this._inFlightCheck && !options.force) {
      return this._inFlightCheck;
    }

    const run = (async () => {
      try {
        if (this.registration && typeof this.registration.update === 'function') {
          await withTimeout(this.registration.update(), Math.min(options.timeoutMs ?? UPDATE_TIMEOUT_MS, 5000), 'SW update')
            .catch(() => {});
        }

        const { manifest: rawManifest, attempts } = await fetchManifestWithRetry(
          `./version.json?t=${Date.now()}`,
          options
        );

        const publishedAtMs = parseUtcTimestampMs(rawManifest.publishedAt);
        const checkedAtMs = Date.now();
        const manifest = {
          ...rawManifest,
          publishedAtMs,
          publishedAtCentral: formatCentralTime(publishedAtMs, options.timeZone || DEFAULT_TIME_ZONE)
        };

        this.remoteManifest = manifest;
        this.lastCheckedAtMs = checkedAtMs;

        const remoteCode = Number(manifest.versionCode);
        const hasNewVersion = Number.isFinite(remoteCode) && remoteCode > APP_LOCAL_VERSION.versionCode;

        if (!hasNewVersion && this.registration?.waiting) {
          // Quietly activate any stale/same-version waiting SW so the user never sees a false update loop
          this._quietlyActivateStaleWaiting();
        }

        this.updateAvailable = hasNewVersion;
        if (hasNewVersion) {
          this._notifyUpdate(manifest);
        }

        return {
          status: hasNewVersion ? 'UPDATE_AVAILABLE' : 'UP_TO_DATE',
          manifest,
          attempts,
          checkedAtMs,
          checkedAtCentral: formatCentralTime(checkedAtMs, options.timeZone || DEFAULT_TIME_ZONE),
          silent
        };
      } catch (err) {
        return {
          status: 'ERROR',
          error: err?.message || 'Unable to reach update server',
          errorCode: err?.code || 'UPDATE_CHECK_FAILED',
          silent
        };
      } finally {
        if (this._inFlightCheck === run) {
          this._inFlightCheck = null;
        }
      }
    })();

    this._inFlightCheck = run;
    return run;
  }

  async applyUpdateNow(options = {}) {
    const installWaitMs = Number.isFinite(options.installWaitMs) ? Math.max(0, options.installWaitMs) : 2000;
    const claimWaitMs = Number.isFinite(options.claimWaitMs) ? Math.max(0, options.claimWaitMs) : 1500;

    try {
      // If no SW is currently installing or waiting, nudge registration.update() first
      if (
        this.registration &&
        !this.registration.waiting &&
        !this.registration.installing &&
        typeof this.registration.update === 'function'
      ) {
        await withTimeout(this.registration.update(), 2500, 'SW apply update').catch(() => {});
      }

      // If an SW install is in progress, wait briefly (up to 2000ms) for 'installed'
      const installing = this.registration?.installing;
      if (
        installing &&
        installing.state !== 'installed' &&
        installing.state !== 'activated' &&
        installing.state !== 'redundant'
      ) {
        await new Promise((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try {
              installing.removeEventListener?.('statechange', onState);
            } catch {
              // ignore
            }
            resolve();
          };
          const onState = () => {
            if (
              installing.state === 'installed' ||
              installing.state === 'activated' ||
              installing.state === 'redundant'
            ) {
              finish();
            }
          };
          const timer = setTimeout(finish, installWaitMs);
          try {
            if (typeof installing.addEventListener === 'function') {
              installing.addEventListener('statechange', onState);
            } else {
              finish();
            }
          } catch {
            finish();
          }
        });
      }

      // Send SKIP_WAITING to waiting worker and wait for controllerchange
      const waitingWorker =
        this.registration?.waiting ||
        (installing && installing.state === 'installed' ? installing : null);
      if (waitingWorker && typeof waitingWorker.postMessage === 'function') {
        const waitForClaim = (
          typeof navigator !== 'undefined' &&
          navigator.serviceWorker &&
          typeof navigator.serviceWorker.addEventListener === 'function'
        )
          ? new Promise((resolve) => {
              let done = false;
              const finish = () => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                try {
                  navigator.serviceWorker.removeEventListener('controllerchange', finish);
                } catch {
                  // ignore
                }
                resolve();
              };
              const timer = setTimeout(finish, claimWaitMs);
              navigator.serviceWorker.addEventListener('controllerchange', finish, { once: true });
            })
          : Promise.resolve();
        waitingWorker.postMessage({ type: 'SKIP_WAITING' });
        await waitForClaim;
      }

      // Clear all CacheStorage entries so the post-update boot fetches fresh app-shell files
      if (typeof window !== 'undefined' && 'caches' in window && window.caches) {
        const keys = await window.caches.keys();
        await Promise.allSettled(keys.map((k) => window.caches.delete(k)));
      }
    } catch {
      // Degrade cleanly if CacheStorage or SW update is unavailable
    } finally {
      this.updateAvailable = false;
      let nextUrlStr = null;
      if (typeof window !== 'undefined' && window.location && typeof window.location.href === 'string') {
        try {
          if (/^https?:/i.test(window.location.href)) {
            const nextUrl = new URL(window.location.href);
            // Replace (never stack) a single transient _upd cache-bust param; app.js strips it via history.replaceState on boot
            nextUrl.searchParams.set('_upd', String(Date.now()));
            nextUrlStr = nextUrl.toString();
          }
        } catch {
          nextUrlStr = null;
        }
      }

      if (typeof options.onReload === 'function') {
        options.onReload(nextUrlStr);
      } else if (typeof window !== 'undefined' && window.location) {
        if (nextUrlStr && typeof window.location.replace === 'function') {
          window.location.replace(nextUrlStr);
        } else if (typeof window.location.reload === 'function') {
          window.location.reload();
        }
      }
    }
  }
}

export const updater = new TempestUpdater();
