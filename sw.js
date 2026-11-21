const CACHE_NAME = 'borden-tempest-v1.1.0-b2';

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/weatherApi.js',
  './js/analyzers.js',
  './js/geoMath.js',
  './js/nexradStations.js',
  './js/radarMap.js',
  './js/audio.js',
  './js/updater.js',
  './assets/icons/icon.svg',
  './assets/icons/apple-touch-icon.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/favicon.png',
  './assets/audio/tornado_siren_wail.wav',
  './assets/audio/tornado_siren_eas.wav',
  './assets/audio/noaa_eas_tone.wav',
  './assets/audio/supercell_alert_alarm.wav',
  './assets/audio/svr_tstorm_alarm.wav',
  './assets/audio/convective_chime.wav',
  './assets/audio/storm_tot_ping.wav',
  './assets/audio/winter_alert_chime.wav'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('borden-tempest-') && k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'CLEAR_CACHES') {
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
    );
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Always fetch live weather APIs, radar tiles, and version.json from network
  if (
    url.origin !== self.location.origin ||
    url.pathname.endsWith('version.json')
  ) {
    return;
  }

  // Network-first for HTML & JS so OTA updates take effect immediately when online
  if (event.request.mode === 'navigate' || url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) {
    event.respondWith(
      fetch(event.request)
        .then((resp) => {
          if (resp && resp.status === 200) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then((c) => c.put(event.request, clone));
          }
          return resp;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for static icons and WAV audio files
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((resp) => {
        if (resp && resp.status === 200) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((c) => c.put(event.request, clone));
        }
        return resp;
      });
    })
  );
});
