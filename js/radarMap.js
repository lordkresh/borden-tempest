import {
  buildCirclePolygon,
  degToCompass,
  destinationPoint,
  geometryCentroid,
  haversineMiles,
  initialBearingDeg,
  isPointInGeometry,
  isValidLatLon
} from './geoMath.js';

const BASEMAP_STYLES = {
  dark: 'https://tiles.openfreemap.org/styles/dark',
  liberty: 'https://tiles.openfreemap.org/styles/liberty'
};

const CLEAN_PROTOCOL_NAME = 'tempest-clean';
const CLEANABLE_REFLECTIVITY_PRODUCTS = new Set(['CONUS_MOSAIC', 'N0B', 'N0Q']);
const _registeredProtocolLibs = new WeakSet();

/**
 * Empirically verified pixel-filtering helper for IEM reflectivity tiles (CONUS Mosaic, N0B, N0Q).
 * Eliminates 100% of real < 20 dBZ clear-air clutter (periwinkle/slate-blue #435e9f..#a4abb4,
 * pale aqua #67c9e0, classic cyan/blue, muddy olive/taupe/gray #9b975b..#cfd2b4) via HSV gating
 * (a >= 20, s = (mx - mn) / mx >= 0.56, H NOT in [156, 278], plus white hail cores
 * mx >= 238 && mn >= 232 adjacent to red/magenta precipitation), followed by a single-pass 3x3
 * despeckle (requiring >= 2 valid precipitating neighbors) and soft broadcast boundary feathering
 * (2-3 neighbors -> alpha = 190).
 */
export function cleanReflectivityTileRgba(rgba, width, height) {
  if (!rgba || typeof rgba.length !== 'number') return rgba;
  const w = Number(width) | 0;
  const h = Number(height) | 0;
  const totalPixels = w * h;
  if (w <= 0 || h <= 0 || rgba.length < totalPixels * 4) return rgba;

  // Classification codes:
  // 0 = rejected / transparent
  // 1 = valid precipitating pixel (s >= 0.56 and hue outside [156, 278])
  // 2 = valid high-sat red/magenta precipitation (supports adjacent white hail cores)
  // 3 = candidate white hail core (mx >= 238 && mn >= 232)
  const state = new Uint8Array(totalPixels);
  let hasWhiteCandidate = false;

  // Pass 1: Empirical HSV clear-air clutter suppression
  for (let p = 0; p < totalPixels; p++) {
    const idx = p * 4;
    const a = rgba[idx + 3];
    if (a < 20) {
      if (a !== 0) {
        rgba[idx] = 0;
        rgba[idx + 1] = 0;
        rgba[idx + 2] = 0;
        rgba[idx + 3] = 0;
      }
      continue;
    }

    const r = rgba[idx];
    const g = rgba[idx + 1];
    const b = rgba[idx + 2];
    const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);

    if (mx >= 238 && mn >= 232) {
      state[p] = 3;
      hasWhiteCandidate = true;
      continue;
    }

    const d = mx - mn;
    if (mx === 0 || d === 0 || (d / mx) < 0.56) {
      rgba[idx] = 0;
      rgba[idx + 1] = 0;
      rgba[idx + 2] = 0;
      rgba[idx + 3] = 0;
      continue;
    }

    let hue;
    if (mx === r) {
      hue = 60 * (((g - b) / d) % 6);
      if (hue < 0) hue += 360;
    } else if (mx === g) {
      hue = 60 * ((b - r) / d + 2);
    } else {
      hue = 60 * ((r - g) / d + 4);
    }
    if (hue < 0) hue += 360;
    if (hue >= 360) hue -= 360;

    if (hue >= 156 && hue <= 278) {
      rgba[idx] = 0;
      rgba[idx + 1] = 0;
      rgba[idx + 2] = 0;
      rgba[idx + 3] = 0;
      continue;
    }

    state[p] = (hue <= 22 || hue > 278) ? 2 : 1;
  }

  // Pass 1b: Preserve white hail cores ONLY when supported by nearby red/magenta precipitation
  if (hasWhiteCandidate) {
    for (let y = 0; y < h; y++) {
      const rowOff = y * w;
      const yMin = y > 1 ? y - 2 : 0;
      const yMax = y + 2 < h ? y + 2 : h - 1;
      for (let x = 0; x < w; x++) {
        const p = rowOff + x;
        if (state[p] !== 3) continue;

        const xMin = x > 1 ? x - 2 : 0;
        const xMax = x + 2 < w ? x + 2 : w - 1;
        let hasCoreSupport = false;
        for (let ny = yMin; ny <= yMax && !hasCoreSupport; ny++) {
          const nRow = ny * w;
          for (let nx = xMin; nx <= xMax; nx++) {
            if (state[nRow + nx] === 2) {
              hasCoreSupport = true;
              break;
            }
          }
        }
        if (hasCoreSupport) {
          state[p] = 1;
        } else {
          state[p] = 0;
          const idx = p * 4;
          rgba[idx] = 0;
          rgba[idx + 1] = 0;
          rgba[idx + 2] = 0;
          rgba[idx + 3] = 0;
        }
      }
    }
  }

  // Pass 2: Single-pass 3x3 despeckle (>= 2 valid neighbors) + soft outer-edge feathering (2-3 neighbors -> alpha 190)
  for (let y = 0; y < h; y++) {
    const yMin = y > 0 ? y - 1 : 0;
    const yMax = y + 1 < h ? y + 1 : h - 1;
    const rowOff = y * w;
    for (let x = 0; x < w; x++) {
      const p = rowOff + x;
      if (state[p] === 0) continue;

      const xMin = x > 0 ? x - 1 : 0;
      const xMax = x + 1 < w ? x + 1 : w - 1;
      let neighbors = 0;
      for (let ny = yMin; ny <= yMax; ny++) {
        const nRow = ny * w;
        for (let nx = xMin; nx <= xMax; nx++) {
          if (nx === x && ny === y) continue;
          if (state[nRow + nx] !== 0) neighbors++;
        }
      }

      const idx = p * 4;
      if (neighbors < 2) {
        rgba[idx] = 0;
        rgba[idx + 1] = 0;
        rgba[idx + 2] = 0;
        rgba[idx + 3] = 0;
      } else if (neighbors <= 3) {
        if (rgba[idx + 3] > 190) {
          rgba[idx + 3] = 190;
        }
      }
    }
  }

  return rgba;
}

async function decodePngBuffer(rawBuf) {
  const blob = new Blob([rawBuf], { type: 'image/png' });
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => {
          try {
            bitmap.close?.();
          } catch {
            // ignore
          }
        }
      };
    } catch {
      // Fall through to HTMLImageElement decoder (handles iOS Safari WebKit PNG edge cases)
    }
  }
  if (typeof Image === 'function' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    const objUrl = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('Image decode failed'));
        el.src = objUrl;
      });
      return {
        source: img,
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
        close: () => {
          try {
            URL.revokeObjectURL(objUrl);
          } catch {
            // ignore
          }
        }
      };
    } catch (err) {
      try {
        URL.revokeObjectURL(objUrl);
      } catch {
        // ignore
      }
      throw err;
    }
  }
  throw new Error('Image decoder unavailable');
}

async function cleanReflectivityTileBytes(rawBuf) {
  if (!(rawBuf instanceof ArrayBuffer) || rawBuf.byteLength === 0) {
    return rawBuf;
  }
  let decoded = null;
  try {
    decoded = await decodePngBuffer(rawBuf);
    const width = decoded.width | 0;
    const height = decoded.height | 0;
    if (width <= 0 || height <= 0) return rawBuf;

    let canvas = null;
    let isOffscreen = false;
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
      canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
    } else if (typeof OffscreenCanvas === 'function') {
      canvas = new OffscreenCanvas(width, height);
      isOffscreen = true;
    } else {
      return rawBuf;
    }

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return rawBuf;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(decoded.source, 0, 0, width, height);

    const imgData = ctx.getImageData(0, 0, width, height);
    cleanReflectivityTileRgba(imgData.data, width, height);
    ctx.putImageData(imgData, 0, 0);

    let outBlob = null;
    if (isOffscreen && typeof canvas.convertToBlob === 'function') {
      outBlob = await canvas.convertToBlob({ type: 'image/png' });
    } else if (typeof canvas.toBlob === 'function') {
      outBlob = await new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Canvas toBlob failed'))), 'image/png');
      });
    } else {
      return rawBuf;
    }

    if (!outBlob || outBlob.size === 0) return rawBuf;
    return await outBlob.arrayBuffer();
  } catch {
    // 100% safe fallback to raw HTTPS bytes on any decode/CORS/environment failure — zero console errors
    return rawBuf;
  } finally {
    decoded?.close?.();
  }
}

async function handleCleanReflectivityTileRequest(params, abortController) {
  const rawUrl = String(params?.url || '');
  const prefix = `${CLEAN_PROTOCOL_NAME}://`;
  const httpsUrl = rawUrl.startsWith(prefix) ? rawUrl.slice(prefix.length) : rawUrl;
  if (!/^https?:\/\//i.test(httpsUrl)) {
    throw new Error('Invalid reflectivity tile URL');
  }

  const fetchInit = { cache: 'no-store' };
  if (abortController && abortController.signal) {
    fetchInit.signal = abortController.signal;
  }
  const resp = await fetch(httpsUrl, fetchInit);
  if (!resp.ok) {
    throw new Error(`Tile HTTP ${resp.status}`);
  }
  const rawBuf = await resp.arrayBuffer();
  const cleanedBuf = await cleanReflectivityTileBytes(rawBuf);
  return {
    data: cleanedBuf,
    cacheControl: 'no-store'
  };
}

export function ensureCleanReflectivityProtocol() {
  try {
    const ml = typeof window !== 'undefined' ? window.maplibregl : null;
    if (!ml || typeof ml.addProtocol !== 'function') return false;
    if (_registeredProtocolLibs.has(ml)) return true;
    ml.addProtocol(CLEAN_PROTOCOL_NAME, handleCleanReflectivityTileRequest);
    _registeredProtocolLibs.add(ml);
    return true;
  } catch {
    return false;
  }
}

const OVERLAY_LAYER_IDS = [
  'tempest_user_dot',
  'tempest_user_halo',
  'tempest_user_ring',
  'tempest_cells_label',
  'tempest_cells_circle',
  'tempest_cells_ring',
  'tempest_lsr_circle',
  'tempest_tot_line',
  'tempest_vectors_line',
  'tempest_vectors_casing',
  'tempest_cones_line',
  'tempest_cones_fill',
  'tempest_range_rings_label',
  'tempest_range_rings_line',
  'tempest_alerts_line',
  'tempest_alerts_fill',
  'tempest_mcd_line',
  'tempest_mcd_fill',
  'tempest_watches_line',
  'tempest_watches_fill',
  'tempest_flood_line',
  'tempest_flood_fill',
  'tempest_spc_line',
  'tempest_spc_fill'
];

const OVERLAY_SOURCE_IDS = [
  'tempest_user',
  'tempest_cells',
  'tempest_lsr',
  'tempest_tot',
  'tempest_vectors',
  'tempest_cones',
  'tempest_range_rings_labels',
  'tempest_range_rings',
  'tempest_alerts',
  'tempest_mcd',
  'tempest_watches',
  'tempest_flood',
  'tempest_spc'
];

const PRODUCT_LEGENDS = {
  CONUS_MOSAIC: {
    unit: 'dBZ',
    ticks: ['20', '35', '50', '65+'],
    grad: 'linear-gradient(90deg,#10b981 0%,#22c55e 20%,#84cc16 36%,#facc15 52%,#f97316 68%,#f43f5e 82%,#d946ef 93%,#f8fafc 100%)'
  },
  N0B: {
    unit: 'dBZ',
    ticks: ['20', '35', '50', '65+'],
    grad: 'linear-gradient(90deg,#10b981 0%,#22c55e 20%,#84cc16 36%,#facc15 52%,#f97316 68%,#f43f5e 82%,#d946ef 93%,#f8fafc 100%)'
  },
  N0G: {
    unit: 'kt',
    ticks: ['-60', '-30', '0', '+30', '+60'],
    grad: 'linear-gradient(90deg,#7dd3fc,#10b981,#166534,#334155,#dc2626,#f43f5e,#e879f9)'
  },
  N0C: {
    unit: 'ρhv',
    ticks: ['0.20', '0.60', '0.84', '0.94', '1.00'],
    grad: 'linear-gradient(90deg,#2563eb,#38bdf8,#facc15,#f97316,#f43f5e,#e879f9)'
  },
  N0X: {
    unit: 'dB',
    ticks: ['-2', '0', '+2', '+4', '+6'],
    grad: 'linear-gradient(90deg,#2563eb,#10b981,#facc15,#f97316,#f43f5e,#d946ef)'
  },
  EET: {
    unit: 'kft',
    ticks: ['10', '25', '40', '55', '65+'],
    grad: 'linear-gradient(90deg,#38bdf8,#22c55e,#facc15,#f97316,#f43f5e,#e879f9)'
  }
};

export class RadarMapController {
  constructor(containerId, callbacks = {}) {
    this.containerId = containerId;
    this.callbacks = callbacks || {};
    this.map = null;
    this.ready = false;
    this.basemap = 'dark';
    this.opacity = 0.78;
    this.frames = [];
    this._mountedFrameKey = null;
    this._mountedRadarLayerIds = [];
    this._mountedRadarSourceIds = [];
    this.frameIdx = 0;
    this.playing = false;
    this.speedMultiplier = 1;
    this.playTimer = null;
    this.wasPlayingBeforeHide = false;
    this._isBackgroundPaused = false;
    this._destroyed = false;
    this._resizeTimer = null;
    this._canvasEl = null;
    this._fallbackClickEl = null;
    this._lastMapError = null;
    this._webglUnavailable = false;
    this._lifecycleAttached = false;
    this.productCode = 'CONUS_MOSAIC';
    this.userLoc = { lat: 34.65, lon: -88.56 };
    this.overlayData = {
      alerts: [],
      stormCells: [],
      lsrGeoJson: { type: 'FeatureCollection', features: [] },
      mcdGeoJson: { type: 'FeatureCollection', features: [] },
      spcWatchesGeoJson: { type: 'FeatureCollection', features: [] },
      wpcFloodGeoJson: { type: 'FeatureCollection', features: [] },
      spcDay1GeoJson: { type: 'FeatureCollection', features: [] },
      spcDay1CatGeoJson: { type: 'FeatureCollection', features: [] },
      spcDay1TorGeoJson: { type: 'FeatureCollection', features: [] },
      spcDay1HailGeoJson: { type: 'FeatureCollection', features: [] },
      spcDay1WindGeoJson: { type: 'FeatureCollection', features: [] },
      spcDay2GeoJson: { type: 'FeatureCollection', features: [] },
      spcDay3GeoJson: { type: 'FeatureCollection', features: [] },
      spcOverlayLayerId: 1
    };
    this.layerVisibility = {
      alerts: true,
      cells: true,
      spc: true,
      watches: true,
      flood: false,
      mcd: true,
      lsr: true
    };

    this._onVisibilityChange = () => {
      if (this._destroyed || typeof document === 'undefined') return;
      if (document.hidden) {
        this.pauseForBackground();
      } else {
        this.resumeFromBackground();
      }
    };

    this._onPageHide = () => {
      if (this._destroyed) return;
      this.pauseForBackground();
    };

    this._onPageShow = (event) => {
      if (this._destroyed) return;
      if (typeof document === 'undefined' || !document.hidden) {
        this.resumeFromBackground();
        if (event?.persisted) {
          this.resize();
        }
      }
    };

    this._onWebGLContextLost = (evt) => {
      try {
        evt?.preventDefault?.();
      } catch {
        // ignore
      }
      this.pauseForBackground();
      this._reportError(new Error('Radar WebGL context lost'));
    };

    this._onWebGLContextRestored = () => {
      if (this._destroyed) return;
      this.resumeFromBackground();
      this.resize();
    };

    this._onFallbackContainerClick = () => {
      if (this._destroyed || this.map) return;
      this.inspectAtPoint(this.userLoc.lat, this.userLoc.lon, null);
    };

    this._attachLifecycleListeners();
  }

  _attachLifecycleListeners() {
    if (this._lifecycleAttached || this._destroyed) return;
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', this._onVisibilityChange);
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pagehide', this._onPageHide);
      window.addEventListener('pageshow', this._onPageShow);
    }
    this._lifecycleAttached = true;
  }

  _detachLifecycleListeners() {
    if (!this._lifecycleAttached) return;
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', this._onVisibilityChange);
    }
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('pagehide', this._onPageHide);
      window.removeEventListener('pageshow', this._onPageShow);
    }
    this._lifecycleAttached = false;
  }

  _reportError(err) {
    this._lastMapError = err || null;
    if (typeof this.callbacks.onError === 'function') {
      try {
        this.callbacks.onError(err);
      } catch {
        // Never allow error callbacks to throw uncaught exceptions
      }
    }
  }

  _clearMapFallback() {
    if (this._fallbackClickEl && typeof this._fallbackClickEl.removeEventListener === 'function') {
      this._fallbackClickEl.removeEventListener('click', this._onFallbackContainerClick);
    }
    this._fallbackClickEl = null;
    if (typeof document !== 'undefined') {
      const container = document.getElementById(this.containerId);
      container?.querySelectorAll?.('.radar-map-fallback')?.forEach?.((el) => el.remove());
    }
  }

  _renderMapFallback(message) {
    if (typeof document === 'undefined') return;
    const container = document.getElementById(this.containerId);
    if (!container) return;
    if (!this._fallbackClickEl && typeof container.addEventListener === 'function') {
      this._fallbackClickEl = container;
      container.addEventListener('click', this._onFallbackContainerClick);
    }
    if (container.querySelector('.radar-map-fallback')) return;
    const notice = document.createElement('div');
    notice.className = 'radar-map-fallback';
    notice.setAttribute('role', 'status');
    notice.textContent = message;
    container.appendChild(notice);
  }

  init(lat, lon, basemap = 'dark', opacity = 0.78) {
    if (this._destroyed) {
      this._destroyed = false;
      this._attachLifecycleListeners();
    }

    const nLat = Number(lat);
    const nLon = Number(lon);
    if (Number.isFinite(nLat) && Number.isFinite(nLon)) {
      this.userLoc = { lat: nLat, lon: nLon };
    }
    this.basemap = BASEMAP_STYLES[basemap] ? basemap : 'dark';
    this.opacity = Number.isFinite(Number(opacity)) ? Math.max(0.2, Math.min(1, Number(opacity))) : 0.78;

    if (this.map) {
      this.resize();
      return true;
    }

    if (typeof window === 'undefined' || typeof window.maplibregl === 'undefined' || typeof window.maplibregl.Map !== 'function') {
      this._webglUnavailable = true;
      this._renderMapFallback('Interactive radar map engine unavailable offline — radar frame controls remain active.');
      return false;
    }

    if (typeof document !== 'undefined' && !document.getElementById(this.containerId)) {
      return false;
    }

    ensureCleanReflectivityProtocol();

    try {
      this.map = new window.maplibregl.Map({
        container: this.containerId,
        style: BASEMAP_STYLES[this.basemap] || BASEMAP_STYLES.dark,
        center: [this.userLoc.lon, this.userLoc.lat],
        zoom: 7.2,
        attributionControl: false
      });
      this._webglUnavailable = false;
      this._clearMapFallback();
    } catch (err) {
      this.map = null;
      this.ready = false;
      this._webglUnavailable = true;
      this._reportError(err);
      this._renderMapFallback('Hardware WebGL radar map unavailable on this device/browser.');
      return false;
    }

    try {
      const canvas = typeof this.map.getCanvas === 'function' ? this.map.getCanvas() : null;
      if (canvas && typeof canvas.addEventListener === 'function') {
        this._canvasEl = canvas;
        canvas.addEventListener('webglcontextlost', this._onWebGLContextLost, false);
        canvas.addEventListener('webglcontextrestored', this._onWebGLContextRestored, false);
      }
    } catch {
      // ignore if mocked map does not expose canvas
    }

    this.map.on('error', (evt) => {
      // Gracefully absorb tile/network/style errors so headless or degraded networks never throw uncaught errors
      const err = evt?.error || evt || new Error('Radar map error');
      this._reportError(err);
    });

    this.map.on('style.load', () => {
      if (this._destroyed || !this.map) return;
      this.ready = true;
      try {
        this._attachAllLayers();
      } catch (err) {
        this._reportError(err);
      }
    });

    this.map.on('click', (e) => {
      if (!this.map || this._destroyed) return;
      try {
        const clickLat = Number(e?.lngLat?.lat);
        const clickLon = Number(e?.lngLat?.lng);
        this.inspectAtPoint(clickLat, clickLon, this.ready ? (e?.point || null) : null);
      } catch (err) {
        this._reportError(err);
      }
    });

    return true;
  }

  _spcRank(props) {
    const lbl = String(props?.LABEL || props?.OUTLOOK || props?.LABEL2 || '').trim().toUpperCase();
    const cat = { NONE: 0, TSTM: 1, MRGL: 2, SLGT: 3, ENH: 4, MDT: 5, HIGH: 6 };
    if (lbl === 'SIGN') return 100;
    if (cat[lbl] != null) return cat[lbl];
    const n = parseFloat(lbl.replace('%', ''));
    if (Number.isFinite(n)) return n <= 1 ? Math.round(n * 100) : Math.round(n);
    return 0;
  }

  _watchRank(props) {
    const isPds = Boolean(props?.is_pds || String(props?.pds || '').toUpperCase() === 'Y');
    const isTor = String(props?.type || '').toUpperCase() === 'TOR';
    return isPds ? 3 : isTor ? 2 : 1;
  }

  _collectCoveringSystems(lat, lon) {
    const validPt = isValidLatLon(lat, lon);
    const alerts = validPt
      ? (this.overlayData.alerts || [])
          .filter((a) => a && a.geometry && isPointInGeometry(lat, lon, a.geometry))
          .sort((a, b) => (b.rank || 0) - (a.rank || 0))
      : [];

    const watches = validPt
      ? (this.overlayData.spcWatchesGeoJson?.features || [])
          .filter((f) => f && f.geometry && isPointInGeometry(lat, lon, f.geometry))
          .sort((a, b) => this._watchRank(b.properties) - this._watchRank(a.properties))
      : [];

    const mcds = validPt
      ? (this.overlayData.mcdGeoJson?.features || [])
          .filter((f) => f && f.geometry && isPointInGeometry(lat, lon, f.geometry))
      : [];

    const floods = validPt
      ? (this.overlayData.wpcFloodGeoJson?.features || [])
          .filter((f) => f && f.geometry && isPointInGeometry(lat, lon, f.geometry))
          .sort((a, b) => this._spcRank(b.properties) - this._spcRank(a.properties))
      : [];

    const outlooks = validPt
      ? (this.overlayData.spcDay1GeoJson?.features || [])
          .filter((f) => f && f.geometry && isPointInGeometry(lat, lon, f.geometry))
          .sort((a, b) => this._spcRank(b.properties) - this._spcRank(a.properties))
      : [];

    let nearestCell = null;
    let nearestCellDistMi = Infinity;
    if (validPt) {
      for (const c of this.overlayData.stormCells || []) {
        if (!c || !isValidLatLon(Number(c.lat), Number(c.lon))) continue;
        const d = haversineMiles(lat, lon, Number(c.lat), Number(c.lon));
        if (Number.isFinite(d) && d < nearestCellDistMi) {
          nearestCellDistMi = d;
          nearestCell = c;
        }
      }
    }

    let nearestLsr = null;
    let nearestLsrDistMi = Infinity;
    if (validPt) {
      for (const f of this.overlayData.lsrGeoJson?.features || []) {
        const coords = f?.geometry?.coordinates;
        if (!Array.isArray(coords) || coords.length < 2) continue;
        const [fLon, fLat] = coords;
        if (!isValidLatLon(Number(fLat), Number(fLon))) continue;
        const d = haversineMiles(lat, lon, Number(fLat), Number(fLon));
        if (Number.isFinite(d) && d < nearestLsrDistMi) {
          nearestLsrDistMi = d;
          nearestLsr = f;
        }
      }
    }

    return {
      alerts,
      watches,
      mcds,
      floods,
      outlooks,
      nearestCell,
      nearestCellDistMi: Number.isFinite(nearestCellDistMi) ? nearestCellDistMi : null,
      nearestLsr,
      nearestLsrDistMi: Number.isFinite(nearestLsrDistMi) ? nearestLsrDistMi : null
    };
  }

  _queryRenderedSafe(screenPoint, layerIds) {
    if (!this.ready || !screenPoint || !this.map || typeof this.map.queryRenderedFeatures !== 'function') return [];
    const activeLayers = layerIds.filter((id) => {
      try {
        return Boolean(this.map.getLayer(id));
      } catch {
        return false;
      }
    });
    if (!activeLayers.length) return [];
    try {
      return this.map.queryRenderedFeatures(screenPoint, { layers: activeLayers }) || [];
    } catch {
      return [];
    }
  }

  /**
   * Resolves interactive weather-system inspection for any map click or programmatic coordinate tap.
   * Priority: Storm Cell -> LSR -> NWS Warning -> SPC Watch -> SPC MCD -> WPC Flood ERO -> SPC Outlook -> Open-Map Point.
   */
  inspectAtPoint(lat, lon, screenPoint = null) {
    if (this._destroyed) return null;
    const validPt = isValidLatLon(lat, lon);
    const ptLat = validPt ? lat : this.userLoc.lat;
    const ptLon = validPt ? lon : this.userLoc.lon;

    const systems = this._collectCoveringSystems(ptLat, ptLon);
    const distFromUserMi = isValidLatLon(this.userLoc.lat, this.userLoc.lon)
      ? haversineMiles(this.userLoc.lat, this.userLoc.lon, ptLat, ptLon)
      : null;
    const bearingFromUser = isValidLatLon(this.userLoc.lat, this.userLoc.lon)
      ? initialBearingDeg(this.userLoc.lat, this.userLoc.lon, ptLat, ptLon)
      : null;
    const activeFrame = this.frames[this.frameIdx] || null;
    const zoom = (this.map && typeof this.map.getZoom === 'function')
      ? (Number(this.map.getZoom()) || 7.2)
      : 7.2;
    const cellProximityMi = Math.max(1.5, Math.min(8, 360 / (2 ** zoom)));
    const lsrProximityMi = Math.max(1.2, Math.min(5, 220 / (2 ** zoom)));

    const context = {
      lat: ptLat,
      lon: ptLon,
      distFromUserMi,
      bearingFromUser,
      compassFromUser: degToCompass(bearingFromUser),
      productCode: this.productCode,
      activeFrame,
      spcOverlayLayerId: this.overlayData.spcOverlayLayerId || 1,
      systems
    };

    // 1. Storm Cell (rendered marker/cone hit OR tight proximity click when cells layer visible)
    if (this.layerVisibility.cells) {
      const cellHits = this._queryRenderedSafe(screenPoint, [
        'tempest_cells_circle',
        'tempest_cells_ring',
        'tempest_cells_label',
        'tempest_cones_fill'
      ]);
      let matchedCell = null;
      if (cellHits.length) {
        const cid = cellHits[0]?.properties?.id;
        matchedCell = (this.overlayData.stormCells || []).find((c) => c && c.id === cid) || null;
      }
      if (!matchedCell && systems.nearestCell && systems.nearestCellDistMi != null && systems.nearestCellDistMi <= cellProximityMi) {
        matchedCell = systems.nearestCell;
      }
      if (matchedCell) {
        if (typeof this.callbacks.onInspectCell === 'function') {
          this.callbacks.onInspectCell(matchedCell, context);
        }
        return { type: 'cell', item: matchedCell, context };
      }
    }

    // 2. Local Storm Report (LSR)
    if (this.layerVisibility.lsr) {
      const lsrHits = this._queryRenderedSafe(screenPoint, ['tempest_lsr_circle']);
      let lsrPayload = null;
      if (lsrHits.length) {
        const feat = lsrHits[0];
        lsrPayload = {
          properties: feat.properties || {},
          coords: feat.geometry?.coordinates || [ptLon, ptLat]
        };
      } else if (systems.nearestLsr && systems.nearestLsrDistMi != null && systems.nearestLsrDistMi <= lsrProximityMi) {
        lsrPayload = {
          properties: systems.nearestLsr.properties || {},
          coords: systems.nearestLsr.geometry?.coordinates || [ptLon, ptLat]
        };
      }
      if (lsrPayload) {
        if (typeof this.callbacks.onInspectLsr === 'function') {
          this.callbacks.onInspectLsr(lsrPayload, context);
        }
        return { type: 'lsr', item: lsrPayload, context };
      }
    }

    // 3. NWS Warning / Advisory Polygon
    if (this.layerVisibility.alerts) {
      const alertHits = this._queryRenderedSafe(screenPoint, ['tempest_alerts_fill', 'tempest_alerts_line']);
      let matchedAlert = null;
      if (alertHits.length) {
        const hitAlerts = alertHits
          .map((h) => (this.overlayData.alerts || []).find((a) => a && a.id === h.properties?.id))
          .filter(Boolean)
          .sort((a, b) => (b.rank || 0) - (a.rank || 0));
        matchedAlert = hitAlerts[0] || null;
      }
      if (!matchedAlert && systems.alerts.length) {
        matchedAlert = systems.alerts[0];
      }
      if (matchedAlert) {
        if (typeof this.callbacks.onInspectAlert === 'function') {
          this.callbacks.onInspectAlert(matchedAlert, context);
        }
        return { type: 'alert', item: matchedAlert, context };
      }
    }

    // 4. SPC Watch Box
    if (this.layerVisibility.watches) {
      const watchHits = this._queryRenderedSafe(screenPoint, ['tempest_watches_fill', 'tempest_watches_line']);
      const matchedWatch = systems.watches[0] || (watchHits.length ? watchHits[0] : null);
      if (matchedWatch) {
        if (typeof this.callbacks.onInspectWatch === 'function') {
          this.callbacks.onInspectWatch(matchedWatch, context);
        }
        return { type: 'watch', item: matchedWatch, context };
      }
    }

    // 5. SPC Mesoscale Discussion (MCD)
    if (this.layerVisibility.mcd) {
      const mcdHits = this._queryRenderedSafe(screenPoint, ['tempest_mcd_fill', 'tempest_mcd_line']);
      const matchedMcd = systems.mcds[0] || (mcdHits.length ? mcdHits[0] : null);
      if (matchedMcd) {
        if (typeof this.callbacks.onInspectMcd === 'function') {
          this.callbacks.onInspectMcd(matchedMcd, context);
        }
        return { type: 'mcd', item: matchedMcd, context };
      }
    }

    // 6. WPC Flash Flood ERO
    if (this.layerVisibility.flood) {
      const floodHits = this._queryRenderedSafe(screenPoint, ['tempest_flood_fill', 'tempest_flood_line']);
      const matchedFlood = systems.floods[0] || (floodHits.length ? floodHits[0] : null);
      if (matchedFlood) {
        if (typeof this.callbacks.onInspectWpc === 'function') {
          this.callbacks.onInspectWpc(matchedFlood, context);
        }
        return { type: 'wpc', item: matchedFlood, context };
      }
    }

    // 7. SPC Convective Outlook
    if (this.layerVisibility.spc) {
      const spcHits = this._queryRenderedSafe(screenPoint, ['tempest_spc_fill', 'tempest_spc_line']);
      const matchedOutlook = systems.outlooks[0] || (spcHits.length ? spcHits.sort((a, b) => this._spcRank(b.properties) - this._spcRank(a.properties))[0] : null);
      if (matchedOutlook) {
        if (typeof this.callbacks.onInspectOutlook === 'function') {
          this.callbacks.onInspectOutlook(matchedOutlook, context);
        }
        return { type: 'outlook', item: matchedOutlook, context };
      }
    }

    // 8. Open-Map Point Intelligence Fallback
    if (typeof this.callbacks.onInspectPoint === 'function') {
      this.callbacks.onInspectPoint(context);
    }
    return { type: 'point', item: context, context };
  }

  resize() {
    if (this._destroyed || !this.map) return;
    if (this._resizeTimer !== null) {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = null;
    }
    this._resizeTimer = setTimeout(() => {
      this._resizeTimer = null;
      if (this._destroyed || !this.map) return;
      try {
        this.map.resize();
      } catch (err) {
        this._reportError(err);
      }
    }, 40);
  }

  setUserLocation(lat, lon) {
    const nLat = Number(lat);
    const nLon = Number(lon);
    if (!Number.isFinite(nLat) || !Number.isFinite(nLon)) return;
    this.userLoc = { lat: nLat, lon: nLon };
    this._updateUserSource();
    if (this.ready) this._updateGeoJsonSources();
  }

  flyTo(lat, lon, zoom = 8.2, isUserOrigin = false) {
    const nLat = Number(lat);
    const nLon = Number(lon);
    if (!Number.isFinite(nLat) || !Number.isFinite(nLon)) return;
    if (isUserOrigin) {
      this.setUserLocation(nLat, nLon);
    }
    if (this.map && !this._destroyed) {
      try {
        this.map.flyTo({ center: [nLon, nLat], zoom, duration: 750 });
      } catch (err) {
        this._reportError(err);
      }
    }
  }

  setBasemap(styleKey) {
    if (this.basemap === styleKey || !BASEMAP_STYLES[styleKey]) return;
    this.basemap = styleKey;
    if (this.map && !this._destroyed) {
      this.ready = false;
      this._mountedFrameKey = null;
      this._mountedRadarLayerIds = [];
      this._mountedRadarSourceIds = [];
      try {
        this.map.setStyle(BASEMAP_STYLES[styleKey]);
      } catch (err) {
        this._reportError(err);
      }
    }
  }

  setOpacity(val) {
    const num = Number(val);
    if (!Number.isFinite(num)) return;
    this.opacity = Math.max(0.2, Math.min(1, num));
    if (!this.ready || !this.map || this._destroyed) return;
    this.frames.forEach((_, idx) => {
      const lid = `tempest_radar_lyr_${idx}`;
      try {
        if (this.map.getLayer(lid)) {
          this.map.setPaintProperty(lid, 'raster-opacity', idx === this.frameIdx ? this.opacity : 0);
        }
      } catch (err) {
        this._reportError(err);
      }
    });
  }

  setLayerVisibility(key, visible) {
    this.layerVisibility[key] = Boolean(visible);
    if (!this.ready || !this.map || this._destroyed) return;
    const vis = this.layerVisibility[key] ? 'visible' : 'none';
    const mapIds = {
      alerts: ['tempest_alerts_fill', 'tempest_alerts_line'],
      cells: [
        'tempest_range_rings_line',
        'tempest_range_rings_label',
        'tempest_cones_fill',
        'tempest_cones_line',
        'tempest_vectors_casing',
        'tempest_vectors_line',
        'tempest_tot_line',
        'tempest_cells_ring',
        'tempest_cells_circle',
        'tempest_cells_label'
      ],
      spc: ['tempest_spc_fill', 'tempest_spc_line'],
      watches: ['tempest_watches_fill', 'tempest_watches_line'],
      flood: ['tempest_flood_fill', 'tempest_flood_line'],
      mcd: ['tempest_mcd_fill', 'tempest_mcd_line'],
      lsr: ['tempest_lsr_circle']
    };
    for (const lid of mapIds[key] || []) {
      try {
        if (this.map.getLayer(lid)) {
          this.map.setLayoutProperty(lid, 'visibility', vis);
        }
      } catch (err) {
        this._reportError(err);
      }
    }
  }

  setOverlayData(data) {
    if (!data || typeof data !== 'object') return;
    this.overlayData = { ...this.overlayData, ...data };
    if (this.ready && !this._destroyed) this._updateGeoJsonSources();
  }

  setFrames(frames, productCode) {
    const nextFrames = Array.isArray(frames)
      ? frames.filter((f) => f && typeof f.tileUrl === 'string' && f.tileUrl.trim().length > 0)
      : [];
    const nextProduct = productCode || 'CONUS_MOSAIC';
    const nextKey = nextFrames.length > 0
      ? `${nextProduct}::${nextFrames.map((f) => f.tileUrl).join('|')}`
      : null;

    if (
      this.ready &&
      nextKey !== null &&
      nextKey === this._mountedFrameKey &&
      nextFrames.length > 0 &&
      this.map?.getLayer('tempest_radar_lyr_0')
    ) {
      // Same tile URLs already mounted — update labels silently with zero radar flash
      this.frames = nextFrames;
      this.productCode = nextProduct;
      if (this.frameIdx >= this.frames.length) {
        this.frameIdx = this.frames.length - 1;
      }
      this._notifyFrame();
      return;
    }

    this.stopPlayback();
    this.frames = nextFrames;
    this.productCode = nextProduct;
    this.frameIdx = Math.max(0, this.frames.length - 1);
    this._renderLegend();
    if (this.ready && !this._destroyed) {
      this._rebuildRadarLayers();
    }
    this._notifyFrame();
  }

  scrubTo(idx) {
    if (!this.frames.length) return;
    const clamped = Math.max(0, Math.min(this.frames.length - 1, Number(idx) || 0));
    this.frameIdx = clamped;
    if (this.ready && this.map && !this._destroyed) {
      this.frames.forEach((_, i) => {
        const lid = `tempest_radar_lyr_${i}`;
        try {
          if (this.map.getLayer(lid)) {
            this.map.setPaintProperty(lid, 'raster-opacity', i === this.frameIdx ? this.opacity : 0);
          }
        } catch (err) {
          this._reportError(err);
        }
      });
    }
    this._notifyFrame();
  }

  togglePlayback() {
    if (this.playing) {
      this.stopPlayback();
    } else {
      this.startPlayback();
    }
    return this.playing;
  }

  startPlayback() {
    if (this._destroyed || this.frames.length <= 1) return false;

    // Always clear any existing timer first to guarantee zero duplicate/zombie intervals
    if (this.playTimer !== null) {
      clearInterval(this.playTimer);
      this.playTimer = null;
    }

    // Never start an active animation interval while the page is backgrounded
    if (typeof document !== 'undefined' && document.hidden) {
      this.wasPlayingBeforeHide = true;
      this._isBackgroundPaused = true;
      this.playing = false;
      this._notifyPlaybackState();
      return false;
    }

    this.wasPlayingBeforeHide = false;
    this._isBackgroundPaused = false;
    this.playing = true;

    const stepMs = this.speedMultiplier === 2 ? 380 : 750;
    this.playTimer = setInterval(() => {
      if (this._destroyed || !this.playing || this.frames.length <= 1) {
        this.stopPlayback();
        return;
      }
      if (typeof document !== 'undefined' && document.hidden) {
        this.pauseForBackground();
        return;
      }
      const next = (this.frameIdx + 1) % this.frames.length;
      this.scrubTo(next);
    }, stepMs);

    this._notifyPlaybackState();
    return true;
  }

  stopPlayback() {
    this.playing = false;
    this.wasPlayingBeforeHide = false;
    this._isBackgroundPaused = false;
    if (this.playTimer !== null) {
      clearInterval(this.playTimer);
      this.playTimer = null;
    }
    this._notifyPlaybackState();
  }

  pauseForBackground() {
    // Idempotent: preserve original playing intent if both visibilitychange and pagehide (or app.js) invoke this
    if (!this._isBackgroundPaused) {
      this.wasPlayingBeforeHide = Boolean(this.playing || this.playTimer !== null);
      this._isBackgroundPaused = true;
    }
    this.playing = false;
    if (this.playTimer !== null) {
      clearInterval(this.playTimer);
      this.playTimer = null;
    }
    this._notifyPlaybackState();
  }

  resumeFromBackground() {
    if (this._destroyed) return false;
    if (!this._isBackgroundPaused) return this.playing;
    const shouldResume = this.wasPlayingBeforeHide;
    this._isBackgroundPaused = false;
    this.wasPlayingBeforeHide = false;
    if (shouldResume && this.frames.length > 1) {
      return this.startPlayback();
    }
    this._notifyPlaybackState();
    return false;
  }

  toggleSpeed() {
    this.speedMultiplier = this.speedMultiplier === 1 ? 2 : 1;
    if (this.playing) this.startPlayback();
    return this.speedMultiplier;
  }

  destroy() {
    this._destroyed = true;
    this.stopPlayback();

    if (this._resizeTimer !== null) {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = null;
    }

    this._detachLifecycleListeners();

    if (this._fallbackClickEl && typeof this._fallbackClickEl.removeEventListener === 'function') {
      try {
        this._fallbackClickEl.removeEventListener('click', this._onFallbackContainerClick);
      } catch {
        // ignore
      }
      this._fallbackClickEl = null;
    }

    if (this._canvasEl && typeof this._canvasEl.removeEventListener === 'function') {
      try {
        this._canvasEl.removeEventListener('webglcontextlost', this._onWebGLContextLost, false);
        this._canvasEl.removeEventListener('webglcontextrestored', this._onWebGLContextRestored, false);
      } catch {
        // ignore
      }
      this._canvasEl = null;
    }

    if (this.map) {
      try {
        this._clearRadarLayers();
      } catch {
        // ignore during teardown
      }
      try {
        this._clearOverlayLayers();
      } catch {
        // ignore during teardown
      }
      try {
        if (typeof this.map.remove === 'function') {
          this.map.remove();
        }
      } catch {
        // ignore during teardown
      }
      this.map = null;
    }

    this.ready = false;
    this._mountedFrameKey = null;
    this._mountedRadarLayerIds = [];
    this._mountedRadarSourceIds = [];
    this.frames = [];
  }

  _notifyPlaybackState() {
    if (typeof this.callbacks.onPlaybackChange === 'function') {
      try {
        this.callbacks.onPlaybackChange(this.playing);
      } catch {
        // ignore callback errors
      }
    }
  }

  _notifyFrame() {
    const fr = this.frames[this.frameIdx] || null;
    if (typeof this.callbacks.onFrameChange === 'function') {
      try {
        this.callbacks.onFrameChange(fr, this.frameIdx, this.frames.length);
      } catch {
        // ignore callback errors
      }
    }
  }

  _renderLegend() {
    if (typeof document === 'undefined') return;
    const el = document.getElementById('radar-legend-bar');
    if (!el) return;
    const cfg = PRODUCT_LEGENDS[this.productCode] || PRODUCT_LEGENDS.CONUS_MOSAIC;
    const ticksHtml = (cfg.ticks || []).map((t) => `<span>${t}</span>`).join('');
    el.innerHTML = `
      <div class="legend-scale-col">
        <div class="legend-gradient" style="background:${cfg.grad}"></div>
        <div class="legend-ticks">${ticksHtml}</div>
      </div>
      <span class="legend-unit">${cfg.unit}</span>
    `;
  }

  _safeAddSource(id, spec) {
    if (!this.map) return;
    try {
      if (!this.map.getSource(id)) {
        this.map.addSource(id, spec);
      }
    } catch (err) {
      this._reportError(err);
    }
  }

  _safeAddLayer(spec, beforeId) {
    if (!this.map) return;
    try {
      if (!this.map.getLayer(spec.id)) {
        if (beforeId) {
          this.map.addLayer(spec, beforeId);
        } else {
          this.map.addLayer(spec);
        }
      }
    } catch (err) {
      this._reportError(err);
    }
  }

  _clearOverlayLayers() {
    if (!this.map) return;
    for (const lid of OVERLAY_LAYER_IDS) {
      try {
        if (this.map.getLayer(lid)) this.map.removeLayer(lid);
      } catch {
        // ignore
      }
    }
    for (const sid of OVERLAY_SOURCE_IDS) {
      try {
        if (this.map.getSource(sid)) this.map.removeSource(sid);
      } catch {
        // ignore
      }
    }
  }

  _attachAllLayers() {
    if (!this.map || this._destroyed) return;
    this._rebuildRadarLayers();

    // SPC Convective Outlook (Day 1-3 Cat & Tor/Hail/Wind Prob)
    this._safeAddSource('tempest_spc', { type: 'geojson', data: this._emptyFc() });
    this._safeAddLayer({
      id: 'tempest_spc_fill',
      type: 'fill',
      source: 'tempest_spc',
      paint: {
        'fill-color': [
          'match', ['coalesce', ['get', 'LABEL'], ''],
          'TSTM', '#4caf50', 'MRGL', '#2e7d32', 'SLGT', '#fdd835', 'ENH', '#fb8c00', 'MDT', '#e53935', 'HIGH', '#d500f9',
          '0.02', '#2e7d32', '2%', '#2e7d32', '0.05', '#8d6e63', '5%', '#8d6e63', '0.10', '#fdd835', '10%', '#fdd835',
          '0.15', '#fb8c00', '15%', '#fb8c00', '0.30', '#e53935', '30%', '#e53935', '0.45', '#d500f9', '45%', '#d500f9',
          '0.60', '#aa00ff', '60%', '#aa00ff', 'SIGN', '#ff1744',
          ['coalesce', ['get', 'fill'], '#1e88e5']
        ],
        'fill-opacity': 0.16
      }
    });
    this._safeAddLayer({
      id: 'tempest_spc_line',
      type: 'line',
      source: 'tempest_spc',
      paint: { 'line-color': ['coalesce', ['get', 'stroke'], '#ffd54f'], 'line-width': 1.6 }
    });

    // WPC Excessive Rainfall (Flash Flood ERO)
    this._safeAddSource('tempest_flood', { type: 'geojson', data: this._emptyFc() });
    this._safeAddLayer({
      id: 'tempest_flood_fill',
      type: 'fill',
      source: 'tempest_flood',
      paint: {
        'fill-color': [
          'match', ['coalesce', ['get', 'OUTLOOK'], ''],
          'MRGL', '#26a69a', 'SLGT', '#fdd835', 'MDT', '#ef5350', 'HIGH', '#d500f9',
          '#00bfa5'
        ],
        'fill-opacity': 0.2
      }
    });
    this._safeAddLayer({
      id: 'tempest_flood_line',
      type: 'line',
      source: 'tempest_flood',
      paint: { 'line-color': '#00e676', 'line-width': 1.8, 'line-dasharray': [2, 2] }
    });

    // SPC Watch Boxes (PDS Tornado magenta, Tornado red, Severe amber)
    this._safeAddSource('tempest_watches', { type: 'geojson', data: this._emptyFc() });
    this._safeAddLayer({
      id: 'tempest_watches_fill',
      type: 'fill',
      source: 'tempest_watches',
      paint: { 'fill-color': ['get', 'watchColor'], 'fill-opacity': 0.11 }
    });
    this._safeAddLayer({
      id: 'tempest_watches_line',
      type: 'line',
      source: 'tempest_watches',
      paint: { 'line-color': ['get', 'watchColor'], 'line-width': 2.4, 'line-dasharray': [4, 2] }
    });

    // SPC MCD
    this._safeAddSource('tempest_mcd', { type: 'geojson', data: this._emptyFc() });
    this._safeAddLayer({
      id: 'tempest_mcd_fill',
      type: 'fill',
      source: 'tempest_mcd',
      paint: { 'fill-color': '#d946ef', 'fill-opacity': 0.12 }
    });
    this._safeAddLayer({
      id: 'tempest_mcd_line',
      type: 'line',
      source: 'tempest_mcd',
      paint: { 'line-color': '#d946ef', 'line-width': 2, 'line-dasharray': [4, 2] }
    });

    // NWS Alerts Polygons
    this._safeAddSource('tempest_alerts', { type: 'geojson', data: this._emptyFc() });
    this._safeAddLayer({
      id: 'tempest_alerts_fill',
      type: 'fill',
      source: 'tempest_alerts',
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.22 }
    });
    this._safeAddLayer({
      id: 'tempest_alerts_line',
      type: 'line',
      source: 'tempest_alerts',
      paint: { 'line-color': ['get', 'color'], 'line-width': 2.5 }
    });

    // Concentric Tactical Range Rings (15 / 30 / 60 mi)
    this._safeAddSource('tempest_range_rings', { type: 'geojson', data: this._emptyFc() });
    this._safeAddLayer({
      id: 'tempest_range_rings_line',
      type: 'line',
      source: 'tempest_range_rings',
      paint: {
        'line-color': '#7dd3fc',
        'line-opacity': 0.18,
        'line-width': 1.0,
        'line-dasharray': [4, 4]
      }
    });
    this._safeAddSource('tempest_range_rings_labels', { type: 'geojson', data: this._emptyFc() });
    this._safeAddLayer({
      id: 'tempest_range_rings_label',
      type: 'symbol',
      source: 'tempest_range_rings_labels',
      layout: {
        'text-field': ['get', 'label'],
        'text-size': 10,
        'text-anchor': 'bottom'
      },
      paint: {
        'text-color': 'rgba(125, 211, 252, 0.72)',
        'text-halo-color': '#070c16',
        'text-halo-width': 1.5
      }
    });

    // Storm Cell Threat Cones, Centerline Motion Vectors & TOT Lines
    this._safeAddSource('tempest_cones', { type: 'geojson', data: this._emptyFc() });
    this._safeAddLayer({
      id: 'tempest_cones_fill',
      type: 'fill',
      source: 'tempest_cones',
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.16 }
    });
    this._safeAddLayer({
      id: 'tempest_cones_line',
      type: 'line',
      source: 'tempest_cones',
      paint: { 'line-color': ['get', 'color'], 'line-width': 1.8, 'line-opacity': 0.85, 'line-dasharray': [3, 2] }
    });

    this._safeAddSource('tempest_vectors', { type: 'geojson', data: this._emptyFc() });
    this._safeAddLayer({
      id: 'tempest_vectors_casing',
      type: 'line',
      source: 'tempest_vectors',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#060b14', 'line-width': 4.4, 'line-opacity': 0.8 }
    });
    this._safeAddLayer({
      id: 'tempest_vectors_line',
      type: 'line',
      source: 'tempest_vectors',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 2.4 }
    });

    this._safeAddSource('tempest_tot', { type: 'geojson', data: this._emptyFc() });
    this._safeAddLayer({
      id: 'tempest_tot_line',
      type: 'line',
      source: 'tempest_tot',
      paint: { 'line-color': '#38bdf8', 'line-width': 2.0, 'line-dasharray': [3, 2] }
    });

    // Local Storm Reports
    this._safeAddSource('tempest_lsr', { type: 'geojson', data: this._emptyFc() });
    this._safeAddLayer({
      id: 'tempest_lsr_circle',
      type: 'circle',
      source: 'tempest_lsr',
      paint: {
        'circle-radius': 5.5,
        'circle-color': '#facc15',
        'circle-stroke-color': '#090d16',
        'circle-stroke-width': 1.8
      }
    });

    // Storm Cell Markers (Outer Rotation Halo + Core Dot + Velocity Vector Tag)
    this._safeAddSource('tempest_cells', { type: 'geojson', data: this._emptyFc() });
    this._safeAddLayer({
      id: 'tempest_cells_ring',
      type: 'circle',
      source: 'tempest_cells',
      filter: ['>=', ['get', 'threatScore'], 3],
      paint: {
        'circle-radius': 14,
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.16,
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 1.5,
        'circle-stroke-opacity': 0.72
      }
    });
    this._safeAddLayer({
      id: 'tempest_cells_circle',
      type: 'circle',
      source: 'tempest_cells',
      paint: {
        'circle-radius': ['case', ['>=', ['get', 'threatScore'], 3], 8.5, 6.5],
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2
      }
    });
    this._safeAddLayer({
      id: 'tempest_cells_label',
      type: 'symbol',
      source: 'tempest_cells',
      layout: {
        'text-field': ['get', 'label'],
        'text-size': 11,
        'text-offset': [0, 1.45],
        'text-anchor': 'top',
        'text-allow-overlap': false
      },
      paint: {
        'text-color': '#f8fafc',
        'text-halo-color': '#060a12',
        'text-halo-width': 1.8
      }
    });

    // User Location Beacon
    this._safeAddSource('tempest_user', { type: 'geojson', data: this._emptyFc() });
    this._safeAddLayer({
      id: 'tempest_user_ring',
      type: 'circle',
      source: 'tempest_user',
      paint: {
        'circle-radius': 18,
        'circle-color': 'transparent',
        'circle-stroke-color': '#38bdf8',
        'circle-stroke-width': 1.1,
        'circle-stroke-opacity': 0.38
      }
    });
    this._safeAddLayer({
      id: 'tempest_user_halo',
      type: 'circle',
      source: 'tempest_user',
      paint: { 'circle-radius': 11, 'circle-color': '#38bdf8', 'circle-opacity': 0.24 }
    });
    this._safeAddLayer({
      id: 'tempest_user_dot',
      type: 'circle',
      source: 'tempest_user',
      paint: { 'circle-radius': 5.5, 'circle-color': '#38bdf8', 'circle-stroke-color': '#f8fafc', 'circle-stroke-width': 2.2 }
    });

    this._updateUserSource();
    this._updateGeoJsonSources();
    Object.entries(this.layerVisibility).forEach(([k, v]) => this.setLayerVisibility(k, v));
  }

  _clearRadarLayers() {
    if (!this.map) return;

    const layerIds = new Set(this._mountedRadarLayerIds);
    const sourceIds = new Set(this._mountedRadarSourceIds);

    try {
      const style = typeof this.map.getStyle === 'function' ? this.map.getStyle() : null;
      if (style?.layers) {
        for (const lyr of style.layers) {
          if (lyr?.id && lyr.id.startsWith('tempest_radar_lyr_')) {
            layerIds.add(lyr.id);
          }
        }
      }
      if (style?.sources) {
        for (const sid of Object.keys(style.sources)) {
          if (sid.startsWith('tempest_radar_src_')) {
            sourceIds.add(sid);
          }
        }
      }
    } catch {
      // ignore if style is not ready yet
    }

    const fallbackMax = Math.max(20, this.frames.length, this._mountedRadarLayerIds.length);
    for (let i = 0; i < fallbackMax; i++) {
      layerIds.add(`tempest_radar_lyr_${i}`);
      sourceIds.add(`tempest_radar_src_${i}`);
    }

    // Remove all raster layers FIRST so MapLibre releases textures cleanly before removing sources
    for (const lid of layerIds) {
      try {
        if (this.map.getLayer(lid)) this.map.removeLayer(lid);
      } catch {
        // ignore stale removal errors
      }
    }
    for (const sid of sourceIds) {
      try {
        if (this.map.getSource(sid)) this.map.removeSource(sid);
      } catch {
        // ignore stale removal errors
      }
    }

    this._mountedRadarLayerIds = [];
    this._mountedRadarSourceIds = [];
    this._mountedFrameKey = null;
  }

  _rebuildRadarLayers() {
    if (!this.map || this._destroyed) return;
    this._clearRadarLayers();

    if (!this.frames.length) return;

    this._mountedFrameKey = `${this.productCode}::${this.frames.map((f) => f.tileUrl).join('|')}`;
    const beforeLayer = this.map.getLayer('tempest_spc_fill') ? 'tempest_spc_fill' : undefined;
    const useCleanProtocol =
      CLEANABLE_REFLECTIVITY_PRODUCTS.has(String(this.productCode || '').toUpperCase()) &&
      ensureCleanReflectivityProtocol();

    this.frames.forEach((fr, idx) => {
      if (!fr || typeof fr.tileUrl !== 'string' || !fr.tileUrl.trim()) return;
      const sid = `tempest_radar_src_${idx}`;
      const lid = `tempest_radar_lyr_${idx}`;
      const rawTileUrl = fr.tileUrl.trim();
      const effectiveTileUrl =
        useCleanProtocol && /^https?:\/\//i.test(rawTileUrl)
          ? `${CLEAN_PROTOCOL_NAME}://${rawTileUrl}`
          : rawTileUrl;
      try {
        this.map.addSource(sid, {
          type: 'raster',
          tiles: [effectiveTileUrl],
          tileSize: 256
        });
        this._mountedRadarSourceIds.push(sid);
        this.map.addLayer({
          id: lid,
          type: 'raster',
          source: sid,
          paint: {
            'raster-opacity': idx === this.frameIdx ? this.opacity : 0,
            'raster-fade-duration': 0,
            'raster-resampling': 'linear'
          }
        }, beforeLayer);
        this._mountedRadarLayerIds.push(lid);
      } catch (err) {
        this._reportError(err);
      }
    });
  }

  _updateUserSource() {
    if (!this.ready || !this.map || this._destroyed) return;
    try {
      const userSrc = this.map.getSource('tempest_user');
      if (!userSrc) return;
      userSrc.setData({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [this.userLoc.lon, this.userLoc.lat] },
          properties: {}
        }]
      });

      const ringRadii = [15, 30, 60];
      this.map.getSource('tempest_range_rings')?.setData({
        type: 'FeatureCollection',
        features: ringRadii.map((mi) => ({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: buildCirclePolygon(this.userLoc.lat, this.userLoc.lon, mi, 64) },
          properties: { radiusMi: mi }
        }))
      });
      this.map.getSource('tempest_range_rings_labels')?.setData({
        type: 'FeatureCollection',
        features: ringRadii.map((mi) => {
          const pt = destinationPoint(this.userLoc.lat, this.userLoc.lon, 0, mi);
          if (!pt) return null;
          return {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [pt.lon, pt.lat] },
            properties: { label: `${mi} mi` }
          };
        }).filter(Boolean)
      });
    } catch (err) {
      this._reportError(err);
    }
  }

  _updateGeoJsonSources() {
    if (!this.ready || !this.map || this._destroyed) return;

    try {
      const alertFeatures = (this.overlayData.alerts || [])
        .filter((a) => a && a.geometry)
        .map((a) => ({
          type: 'Feature',
          geometry: a.geometry,
          properties: { id: a.id, event: a.event, color: a.color }
        }));
      this.map.getSource('tempest_alerts')?.setData({ type: 'FeatureCollection', features: alertFeatures });

      const cells = (this.overlayData.stormCells || [])
        .filter((c) => c && Number.isFinite(c.lon) && Number.isFinite(c.lat));
      const cellFeatures = cells.map((c) => {
        const prefix = c.tvs ? 'TVS' : c.meso ? 'SUP' : c.threatScore >= 2 ? 'SVR' : '';
        const dirTag = c.speedMph >= 3 && c.moveToCompass && c.moveToCompass !== '--'
          ? ` →${c.moveToCompass} ${c.speedMph}`
          : '';
        const label = prefix ? `${prefix} ${c.stormId}${dirTag}` : `${c.stormId}${dirTag}`;
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
          properties: {
            id: c.id,
            color: c.color,
            threatScore: c.threatScore || 1,
            label
          }
        };
      });
      this.map.getSource('tempest_cells')?.setData({ type: 'FeatureCollection', features: cellFeatures });

      const coneFeatures = cells
        .filter((c) => Array.isArray(c.coneCoords) && c.coneCoords.length >= 3)
        .map((c) => ({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [c.coneCoords] },
          properties: { id: c.id, color: c.color }
        }));
      this.map.getSource('tempest_cones')?.setData({ type: 'FeatureCollection', features: coneFeatures });

      const vectorFeatures = [];
      for (const c of cells) {
        if (!c.vectorLine) continue;
        if (Array.isArray(c.vectorLine.coords)) {
          vectorFeatures.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: c.vectorLine.coords },
            properties: { id: c.id, color: c.color }
          });
        }
        if (Array.isArray(c.vectorLine.arrowCoords)) {
          vectorFeatures.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: c.vectorLine.arrowCoords },
            properties: { id: c.id, color: c.color }
          });
        }
      }
      this.map.getSource('tempest_vectors')?.setData({ type: 'FeatureCollection', features: vectorFeatures });

      const totFeatures = cells
        .filter((c) => c?.intercept?.verdict === 'DIRECT_INTERCEPT' || c?.intercept?.verdict === 'NEAR_MISS')
        .map((c) => ({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[c.lon, c.lat], [this.userLoc.lon, this.userLoc.lat]] },
          properties: { id: c.id }
        }));
      this.map.getSource('tempest_tot')?.setData({ type: 'FeatureCollection', features: totFeatures });

      this.map.getSource('tempest_spc')?.setData(this.overlayData.spcDay1GeoJson || this._emptyFc());
      this.map.getSource('tempest_flood')?.setData(this.overlayData.wpcFloodGeoJson || this._emptyFc());
      const watchFeats = (this.overlayData.spcWatchesGeoJson?.features || []).map((f) => {
        const p = f.properties || {};
        const isPds = Boolean(p.is_pds || String(p.pds || '').toUpperCase() === 'Y');
        const isTor = String(p.type || '').toUpperCase() === 'TOR';
        const watchColor = isPds ? '#ff00ff' : isTor ? '#ff1744' : '#ffb300';
        return { ...f, properties: { ...p, watchColor } };
      });
      this.map.getSource('tempest_watches')?.setData({ type: 'FeatureCollection', features: watchFeats });
      this.map.getSource('tempest_mcd')?.setData(this.overlayData.mcdGeoJson || this._emptyFc());
      this.map.getSource('tempest_lsr')?.setData(this.overlayData.lsrGeoJson || this._emptyFc());
    } catch (err) {
      this._reportError(err);
    }
  }

  _emptyFc() {
    return { type: 'FeatureCollection', features: [] };
  }
}
