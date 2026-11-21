export const APP_LOCAL_VERSION = {
  versionCode: 3,
  versionName: '1.2.0',
  platform: 'iOS / Web PWA'
};

class TempestUpdater {
  constructor() {
    this.registration = null;
    this.remoteManifest = null;
    this.updateAvailable = false;
    this.onUpdateFound = null;
  }

  isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true;
  }

  async init(onUpdateFound) {
    this.onUpdateFound = onUpdateFound;
    if ('serviceWorker' in navigator) {
      try {
        this.registration = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
        this.registration.addEventListener('updatefound', () => {
          const nw = this.registration.installing;
          if (!nw) return;
          nw.addEventListener('statechange', () => {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) {
              this.updateAvailable = true;
              if (this.onUpdateFound) this.onUpdateFound(this.remoteManifest);
            }
          });
        });
      } catch {
        // Service workers may be disabled on non-HTTPS origins other than localhost
      }
    }

    // Automatic background check on startup
    this.checkForUpdates(true);
  }

  async checkForUpdates(silent = false) {
    try {
      if (this.registration) {
        await this.registration.update().catch(() => {});
      }
      const resp = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const manifest = await resp.json();
      this.remoteManifest = manifest;

      const hasNewVersion = Number(manifest.versionCode) > APP_LOCAL_VERSION.versionCode ||
        Boolean(this.registration?.waiting);

      this.updateAvailable = hasNewVersion;
      if (hasNewVersion && this.onUpdateFound) {
        this.onUpdateFound(manifest);
      }

      return {
        status: hasNewVersion ? 'UPDATE_AVAILABLE' : 'UP_TO_DATE',
        manifest,
        silent
      };
    } catch (err) {
      return {
        status: 'ERROR',
        error: err.message || 'Unable to reach update server',
        silent
      };
    }
  }

  async applyUpdateNow() {
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      if (this.registration?.waiting) {
        this.registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      }
      if (this.registration) {
        await this.registration.update().catch(() => {});
      }
    } finally {
      window.location.reload();
    }
  }
}

export const updater = new TempestUpdater();
