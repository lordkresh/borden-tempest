const CACHE_NAME = 'borden-tempest-v1.6.1-b8';

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

const LIVE_WEATHER_HOST_PATTERNS = [
  /(^|\.)weather\.gov$/i,
  /(^|\.)noaa\.gov$/i,
  /(^|\.)open-meteo\.com$/i,
  /(^|\.)mesonet\.agron\.iastate\.edu$/i,
  /(^|\.)agron\.iastate\.edu$/i,
  /(^|\.)amazonaws\.com$/i,
  /(^|\.)rainviewer\.com$/i,
  /(^|\.)tilecache\./i
];

const LIVE_WEATHER_PATH_PATTERNS = [
  /(^|\/)version\.json$/i,
  /(^|\/)api(\/|$)/i,
  /\.geojson$/i,
  /\.json$/i,
  /\/(cache|c)\/tile\.py\//i,
  /\/tilecache(\/|$)/i,
  /\/radar(\/|$)/i,
  /\/ridge(\/|$)/i,
  /\/wms(\/|$)/i,
  /\/tiles?(\/|$)/i,
  /\/nexrad(\/|$|[-_])/i,
  /\/(alerts|observations|forecasts?)(\/|$)/i,
  /ridge::|unidata-nexrad|rainviewer/i,
  /\/\d+\/\d+\/\d+\.(png|jpe?g|webp|pbf|mvt)$/i
];

const LIVE_WEATHER_QUERY_PATTERNS = [
  /[?&](f|format)=(geo|p)?json(&|$)/i,
  /[?&]service=wms(&|$)/i,
  /unidata-nexrad|ridge::|rainviewer|tilecache/i
];

const STATIC_APP_SHELL_EXT_RE = /\.(html|css|js|webmanifest|png|svg|ico|wav|mp3|woff2?)$/i;
const STATIC_MEDIA_EXT_RE = /\.(png|svg|ico|wav|mp3|woff2?)$/i;

function isLiveWeatherRequest(url) {
  const host = (url.hostname || '').toLowerCase();
  const path = url.pathname || '';
  const search = url.search || '';
  const href = url.href || '';

  if (host.includes('rainviewer')) return true;
  if (LIVE_WEATHER_HOST_PATTERNS.some((re) => re.test(host))) return true;
  if (LIVE_WEATHER_PATH_PATTERNS.some((re) => re.test(path))) return true;
  if (search && LIVE_WEATHER_QUERY_PATTERNS.some((re) => re.test(search))) return true;
  if (/unidata-nexrad-level3|rainviewer/i.test(href)) return true;

  return false;
}

function isStaticAppShellAsset(url) {
  if (url.origin !== self.location.origin) return false;
  if (isLiveWeatherRequest(url)) return false;
  const path = url.pathname || '/';
  if (/(^|\/)sw\.js$/i.test(path)) return false;
  if (path === '/' || path.endsWith('/')) return true;
  return STATIC_APP_SHELL_EXT_RE.test(path);
}

function fetchNetworkOnly(request) {
  const init = { cache: 'no-store' };
  if (request.mode === 'navigate') {
    return fetch(request.url, init);
  }
  return fetch(request, init);
}

function buildOfflineResponse(request, url) {
  const isImageTile =
    request.destination === 'image' ||
    /\.(png|jpe?g|webp|gif)$/i.test(url.pathname) ||
    /tile\.py|\/tilecache(\/|$)/i.test(url.pathname);

  if (isImageTile) {
    return new Response('', {
      status: 503,
      statusText: 'Service Unavailable',
      headers: {
        'Cache-Control': 'no-store',
        'X-Tempest-Offline': '1'
      }
    });
  }

  return new Response(
    JSON.stringify({
      offline: true,
      status: 503,
      error: 'Network unavailable — live weather, radar, and alert feeds are strictly network-only.',
      url: url.href
    }),
    {
      status: 503,
      statusText: 'Service Unavailable',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Tempest-Offline': '1'
      }
    }
  );
}

async function safeCachePut(request, response) {
  try {
    if (!response || !response.ok || response.status !== 200) return;
    if (response.type === 'opaque' || response.type === 'error') return;
    const reqUrl = new URL(request.url);
    if (!isStaticAppShellAsset(reqUrl)) return;
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response);
  } catch {
    // Ignore CacheStorage quota/eviction errors without throwing
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await Promise.allSettled(
        SHELL_ASSETS.map(async (assetUrl) => {
          try {
            const req = new Request(assetUrl, { cache: 'reload' });
            const resp = await fetch(req);
            if (resp && resp.ok && resp.status === 200 && resp.type !== 'opaque') {
              await cache.put(assetUrl, resp);
            }
          } catch {
            // Do not fail SW install if a single optional asset is unreachable
          }
        })
      );
    }).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE_NAME)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
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
  const { request } = event;

  // Guard against Chrome DevTools only-if-cached bug
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') {
    return;
  }

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // Only handle http(s) requests
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return;
  }

  // 1. STRICT NETWORK-ONLY for ALL live weather, radar, alert, GeoJSON, S3, and version.json endpoints.
  // Never read from or write to CacheStorage; return clean 503 Response on network failure.
  if (isLiveWeatherRequest(url)) {
    event.respondWith(
      Promise.resolve()
        .then(() => fetchNetworkOnly(request))
        .catch(() => buildOfflineResponse(request, url))
    );
    return;
  }

  // Non-GET requests and third-party non-weather origins (e.g. CDN/fonts/basemap) bypass SW cache
  if (request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  // 2. Same-origin non-app-shell URLs: default-deny caching (strict network-only)
  if (!isStaticAppShellAsset(url)) {
    event.respondWith(
      Promise.resolve()
        .then(() => fetchNetworkOnly(request))
        .catch(() => buildOfflineResponse(request, url))
    );
    return;
  }

  // 3. Static app-shell HTML, JS, CSS, and Web Manifest: Network-first with clean offline cache fallback
  if (
    request.mode === 'navigate' ||
    url.pathname === '/' ||
    url.pathname.endsWith('/') ||
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.webmanifest')
  ) {
    event.respondWith(
      fetch(request)
        .then((resp) => {
          if (resp && resp.ok && resp.status === 200) {
            const clone = resp.clone();
            event.waitUntil(safeCachePut(request, clone));
          }
          return resp;
        })
        .catch(async () => {
          const cached =
            (await caches.match(request)) ||
            (await caches.match(request, { ignoreSearch: true })) ||
            (request.mode === 'navigate'
              ? (await caches.match('./index.html')) || (await caches.match('./'))
              : null);
          if (cached) return cached;
          return new Response('Offline — app shell asset unavailable', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: {
              'Content-Type': 'text/plain; charset=utf-8',
              'Cache-Control': 'no-store'
            }
          });
        })
    );
    return;
  }

  // 4. Static icons & audio WAVs: Cache-first with background/miss fill and clean offline 503 fallback
  if (STATIC_MEDIA_EXT_RE.test(url.pathname)) {
    event.respondWith(
      caches.match(request)
        .then((cached) => cached || caches.match(request, { ignoreSearch: true }))
        .then((cached) => {
          if (cached) return cached;
          return fetch(request)
            .then((resp) => {
              if (resp && resp.ok && resp.status === 200) {
                const clone = resp.clone();
                event.waitUntil(safeCachePut(request, clone));
              }
              return resp;
            })
            .catch(() => new Response('', {
              status: 503,
              statusText: 'Service Unavailable',
              headers: { 'Cache-Control': 'no-store' }
            }));
        })
    );
  }
});
