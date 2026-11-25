import {
  RADAR_PRODUCTS,
  STALE_THRESHOLD_MS,
  WPC_WSSI_MODES,
  buildRadarFrames,
  evaluateDataStaleness,
  fetchIemStormIntel,
  fetchNwsAfd,
  fetchNwsAlerts,
  fetchNwsPointBundle,
  fetchOpenMeteo,
  fetchOpenMeteoWinterModels,
  fetchSpcOverlayLayer,
  fetchWpcFloodOutlook,
  fetchWpcWssiBundle,
  fetchWpcWssiLayer,
  formatCentralHour,
  formatCentralTime,
  getCentralHour24,
  parseUtcTimestampMs,
  searchLocations
} from './weatherApi.js';
import {
  analyzeEnvironment,
  analyzeStormCells,
  analyzeWinterSuite,
  canonicalAlertId,
  classifyNwsAlert,
  evaluateMultiDayOutlooks,
  evaluateWssiAtPoint,
  filterAndDeduplicateAlerts,
  isAlertExpired,
  mphToKt,
  resolveCurrentConditions,
  wmoInfo,
  wssiImpactRank,
  wssiMetaForRank
} from './analyzers.js';
import { findNearestNexradStation, getStationsSortedByDistance } from './nexradStations.js';
import { degToCompass, geometryCentroid, haversineMiles, initialBearingDeg, isPointInGeometry, isValidLatLon } from './geoMath.js';
import { RadarMapController } from './radarMap.js';
import { SIREN_CATALOG, audioEngine } from './audio.js';
import { APP_LOCAL_VERSION, updater } from './updater.js';

const STORAGE_KEY_SETTINGS = 'borden_tempest_ios_settings_v2';
const STORAGE_KEY_LOCATIONS = 'borden_tempest_ios_locations_v1';
const STORAGE_KEY_NOTIFIED = 'borden_tempest_ios_notified_v2';
const STORAGE_KEY_SNAPSHOT = 'borden_tempest_ios_snapshot_v1';
const EXPIRY_SWEEP_MS = 15000;

const DEFAULT_SETTINGS = {
  tornadoSoundId: 'tornado_siren_eas',
  voiceAnnouncerEnabled: true,
  adaptiveStormModeEnabled: true,
  keepScreenAwakeInStorm: true,
  severeWarningAlertsEnabled: true,
  convectiveAlertsEnabled: true,
  convectiveAlertThreshold: 'STANDARD', // SENSITIVE | STANDARD | HIGH_ONLY
  proactiveTotAlertsEnabled: true,
  proactiveTotLeadMinutes: 35,
  winterAlertsEnabled: true,
  nocturnalReadinessEnabled: true,
  groundFreezeThresholdF: 32,
  radarProduct: 'CONUS_MOSAIC',
  spcOverlayLayerId: 1,
  wssiOverlayLayerId: 4,
  radarOpacity: 0.78,
  basemap: 'dark'
};

const DEFAULT_LOCATION = {
  id: 'default_booneville',
  name: 'Booneville, MS',
  lat: 34.6581,
  lon: -88.5667
};

let _svgUid = 0;

const SPC_CAT_INFO = {
  TSTM: { rank: 0, scale: '0/5', title: 'General Thunderstorms', color: '#81c784', desc: 'Non-severe lightning, brief heavy downpours, and gusty winds possible; organized severe storms not expected.' },
  MRGL: { rank: 1, scale: '1/5', title: 'Marginal Risk', color: '#4caf50', desc: 'Isolated severe storms possible; limited in duration and coverage with localized hail or gusty winds.' },
  SLGT: { rank: 2, scale: '2/5', title: 'Slight Risk', color: '#fdd835', desc: 'Scattered severe thunderstorms possible; short-lived or isolated intense storms with damaging winds, hail, or a brief tornado.' },
  ENH: { rank: 3, scale: '3/5', title: 'Enhanced Risk', color: '#fb8c00', desc: 'Numerous severe storms possible; more persistent and widespread damaging winds, large hail, and tornadoes.' },
  MDT: { rank: 4, scale: '4/5', title: 'Moderate Risk', color: '#ef5350', desc: 'Widespread severe weather outbreak likely; long-lived intense supercells, strong tornadoes, and destructive wind/hail swaths.' },
  HIGH: { rank: 5, scale: '5/5', title: 'High Risk', color: '#d500f9', desc: 'Major severe weather outbreak expected; life-threatening violent tornadoes and/or widespread destructive derecho winds.' }
};

const WPC_ERO_INFO = {
  MRGL: { rank: 1, scale: '1/4', pct: '5–15%', title: 'Marginal Flash Flood Risk', color: '#26a69a', desc: 'Localized rapid runoff and minor flooding possible in poor-drainage urban areas, creeks, and low-water crossings.' },
  SLGT: { rank: 2, scale: '2/4', pct: '15–40%', title: 'Slight Flash Flood Risk', color: '#fdd835', desc: 'Scattered flash flooding expected with intense rainfall rates; low-water crossings and small streams may flood quickly.' },
  MDT: { rank: 3, scale: '3/4', pct: '40–70%', title: 'Moderate Flash Flood Risk', color: '#ef5350', desc: 'Numerous significant flash floods likely; dangerous water rises across roads, creeks, and flood-prone communities.' },
  HIGH: { rank: 4, scale: '4/4', pct: '≥70%', title: 'High Flash Flood Risk', color: '#d500f9', desc: 'Severe, widespread, and life-threatening flash flooding expected. Avoid travel and move to higher ground immediately.' }
};

const PTYPE_SEVERITY_ORDER = {
  FREEZING_RAIN: 8,
  SLEET: 7,
  SNOW: 6,
  WINTRY_MIX: 5,
  REFREEZE: 4,
  COLD_RAIN: 3,
  DRY_FREEZE: 2,
  CLEAR: 1
};

const state = {
  tab: 'dashboard',
  settings: loadJson(STORAGE_KEY_SETTINGS, DEFAULT_SETTINGS),
  savedLocations: loadJson(STORAGE_KEY_LOCATIONS, [DEFAULT_LOCATION]),
  activeLocation: null,
  selectedRadarSite: null,
  isLoading: false,
  isLocatingGps: false,
  isOffline: false,
  lastUpdated: null,
  nwsBundle: null,
  openMeteo: null,
  current: null,
  environment: null,
  winter: null,
  localAlerts: [],
  alerts: [],
  regionalAlerts: [],
  radarFrames: [],
  staleness: null,
  stormCells: [],
  iemIntel: null,
  winterModels: null,
  wssiBundle: null,
  multiDaySpc: null,
  afd: null,
  activePlayingSoundId: null,
  activePopupAlertId: null,
  isStormWatchActive: false,
  pollTimerId: null,
  expirySweepTimerId: null,
  voiceBriefingTimerId: null,
  wakeLockSentinel: null,
  wasHidden: false,
  refreshSeq: 0,
  pendingRefresh: null,
  notifiedMap: loadNotifiedMap()
};

function getSavedHomeLocation() {
  if (Array.isArray(state.savedLocations)) {
    const valid = state.savedLocations.find((loc) => loc && isValidLatLon(Number(loc.lat), Number(loc.lon)));
    if (valid) return valid;
  }
  return DEFAULT_LOCATION;
}

state.activeLocation = getSavedHomeLocation();

const radarMap = new RadarMapController('radar-map-container', {
  onFrameChange: (fr, idx, total) => {
    const timeEl = document.getElementById('radar-frame-time');
    const feedEl = document.getElementById('radar-feed-tag');
    const scrub = document.getElementById('radar-scrubber');
    if (scrub) {
      const maxVal = Math.max(0, total - 1);
      scrub.max = maxVal;
      scrub.value = idx;
      const pct = maxVal > 0 ? Math.round((idx / maxVal) * 100) : 100;
      scrub.style.setProperty('--scrubber-pct', `${pct}%`);
    }
    if (timeEl) timeEl.textContent = fr ? fr.label : 'No radar frames';
    if (feedEl) feedEl.textContent = fr ? fr.feedLabel : 'IEM';
  },
  onPlaybackChange: (isPlaying) => {
    const playBtn = document.getElementById('btn-radar-play');
    if (playBtn) playBtn.textContent = isPlaying ? '⏸' : '▶';
  },
  onError: () => {
    // Non-fatal radar/WebGL errors are handled gracefully by RadarMapController
  },
  onInspectCell: (cell, ctx) => openInspectSheet('cell', cell, ctx),
  onInspectAlert: (alert, ctx) => openInspectSheet('alert', alert, ctx),
  onInspectLsr: (lsr, ctx) => openInspectSheet('lsr', lsr, ctx),
  onInspectWatch: (watch, ctx) => openInspectSheet('watch', watch, ctx),
  onInspectMcd: (mcd, ctx) => openInspectSheet('mcd', mcd, ctx),
  onInspectWpc: (wpc, ctx) => openInspectSheet('wpc', wpc, ctx),
  onInspectWssi: (wssi, ctx) => openInspectSheet('wssi', wssi, ctx),
  onInspectOutlook: (outlook, ctx) => openInspectSheet('outlook', outlook, ctx),
  onInspectPoint: (ctx) => openInspectSheet('point', ctx, ctx)
});

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return Array.isArray(fallback) ? [...fallback] : { ...fallback };
    const parsed = JSON.parse(raw);
    if (Array.isArray(fallback)) {
      return Array.isArray(parsed) && parsed.length ? parsed : [...fallback];
    }
    return parsed && typeof parsed === 'object' ? { ...fallback, ...parsed } : { ...fallback };
  } catch {
    return Array.isArray(fallback) ? [...fallback] : { ...fallback };
  }
}

function loadNotifiedMap() {
  const map = loadJson(STORAGE_KEY_NOTIFIED, {});
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const pruned = {};
  for (const [k, v] of Object.entries(map)) {
    if (v && v.ts && v.ts > cutoff) pruned[k] = v;
  }
  return pruned;
}

function saveNotifiedMap() {
  try {
    localStorage.setItem(STORAGE_KEY_NOTIFIED, JSON.stringify(state.notifiedMap));
  } catch {
    // ignore quota errors
  }
}

function hasBeenNotified(key, fingerprint = '1') {
  const rec = state.notifiedMap[key];
  return Boolean(rec && rec.fp === fingerprint);
}

function markNotified(key, fingerprint = '1') {
  state.notifiedMap[key] = { fp: fingerprint, ts: Date.now() };
  saveNotifiedMap();
}

function getNwsNotificationKey(alert) {
  const canon = alert?.canonicalId || canonicalAlertId(alert?.id || alert?.identifier || alert?.atId);
  return `nws_${canon || String(alert?.id || 'unknown').toLowerCase()}`;
}

function isNwsAlertAlreadyNotified(alert) {
  if (!alert) return true;
  const key = getNwsNotificationKey(alert);
  const fp = alert.escalationFingerprint || '1';
  if (hasBeenNotified(key, fp)) return true;

  // Routine NWS continuation/update referencing a previously notified alert with identical escalation
  if (Array.isArray(alert.references) && alert.references.length) {
    for (const refId of alert.references) {
      const refCanon = canonicalAlertId(refId);
      if (refCanon && hasBeenNotified(`nws_${refCanon}`, fp)) {
        markNotified(key, fp);
        return true;
      }
    }
  }
  return false;
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(state.settings));
  } catch {
    // ignore private-mode or quota errors
  }
}

function saveLocations() {
  try {
    localStorage.setItem(STORAGE_KEY_LOCATIONS, JSON.stringify(state.savedLocations));
  } catch {
    // ignore private-mode or quota errors
  }
}

function fmtFixed(val, digits = 1, fallback = '--') {
  return typeof val === 'number' && Number.isFinite(val) ? val.toFixed(digits) : fallback;
}

function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), 2800);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ==================== SCREEN WAKE LOCK ==================== */
async function syncWakeLock() {
  const wantAwake = state.settings.keepScreenAwakeInStorm && state.isStormWatchActive && !document.hidden;
  if (!('wakeLock' in navigator)) return;

  if (wantAwake && !state.wakeLockSentinel) {
    try {
      state.wakeLockSentinel = await navigator.wakeLock.request('screen');
      state.wakeLockSentinel.addEventListener('release', () => {
        state.wakeLockSentinel = null;
      });
    } catch {
      // iOS may deny wake lock until user gesture; silently ignore
    }
  } else if (!wantAwake && state.wakeLockSentinel) {
    try {
      await state.wakeLockSentinel.release();
    } catch {
      // ignore
    }
    state.wakeLockSentinel = null;
  }
}

/* ==================== ADAPTIVE POLLING, EXPIRY SWEEP & STALENESS ==================== */
function clearPollTimer() {
  if (state.pollTimerId !== null) {
    clearTimeout(state.pollTimerId);
    state.pollTimerId = null;
  }
}

function clearExpirySweepTimer() {
  if (state.expirySweepTimerId !== null) {
    clearInterval(state.expirySweepTimerId);
    state.expirySweepTimerId = null;
  }
}

function startExpirySweep() {
  clearExpirySweepTimer();
  if (document.hidden) return;
  state.expirySweepTimerId = setInterval(() => {
    if (document.hidden) {
      clearExpirySweepTimer();
      return;
    }
    purgeExpiredAlerts(Date.now());
  }, EXPIRY_SWEEP_MS);
}

function updateDataStalenessBanner(nowMs = Date.now()) {
  const activeFrames = state.radarFrames?.length
    ? state.radarFrames
    : (radarMap.frames?.length ? radarMap.frames : null);

  let effectiveNws = state.nwsBundle;
  if (!effectiveNws && state.lastUpdated && state.current) {
    effectiveNws = { _meta: { fetchedAtMs: state.lastUpdated.getTime() } };
  }

  const staleness = evaluateDataStaleness({
    radarFrames: activeFrames,
    openMeteo: state.openMeteo,
    nwsBundle: effectiveNws,
    stormCells: state.iemIntel?.stormCellsGeoJson || state.stormCells,
    nowMs,
    thresholdMs: STALE_THRESHOLD_MS
  });
  state.staleness = staleness;

  const banner = document.getElementById('data-staleness-banner');
  if (banner) {
    banner.classList.toggle('hidden', !staleness.isStale);
    banner.hidden = !staleness.isStale;
    const titleEl = document.getElementById('data-staleness-title');
    const msgEl = document.getElementById('data-staleness-message');
    if (staleness.isStale) {
      if (titleEl) {
        titleEl.textContent = `Stale Weather Data (>${staleness.thresholdMinutes}m)`;
      }
      if (msgEl) {
        msgEl.textContent = staleness.summary || 'Live radar or forecast feeds are more than 15 minutes old. Tap Refresh to sync.';
      }
    }
  }
  return staleness;
}

function purgeExpiredAlerts(nowMs = Date.now()) {
  const loc = state.activeLocation || getSavedHomeLocation();
  const prevLocalIds = (state.localAlerts || []).map((a) => a.canonicalId || a.id).join('|');
  const prevRegionalIds = (state.regionalAlerts || []).map((a) => a.canonicalId || a.id).join('|');

  const nextLocal = filterAndDeduplicateAlerts(state.localAlerts || [], loc.lat, loc.lon, nowMs);
  const nextRegional = filterAndDeduplicateAlerts(state.regionalAlerts || [], loc.lat, loc.lon, nowMs);

  const nextLocalIds = nextLocal.map((a) => a.canonicalId || a.id).join('|');
  const nextRegionalIds = nextRegional.map((a) => a.canonicalId || a.id).join('|');
  const changed = nextLocalIds !== prevLocalIds || nextRegionalIds !== prevRegionalIds;

  if (changed) {
    state.localAlerts = nextLocal;
    state.alerts = nextLocal;
    state.regionalAlerts = nextRegional;

    if (state.activePopupAlertId && !nextLocal.some((a) => (a.canonicalId || a.id) === state.activePopupAlertId)) {
      state.activePopupAlertId = null;
      audioEngine.stop();
      stopVoiceBriefing();
      document.getElementById('alert-popup-modal')?.classList.add('hidden');
    }

    evaluateStormWatchState();
    updateHeaderAndBadges();
    updateTelemetryRibbon();
    renderDashboard();
    renderAlerts();
    radarMap.setOverlayData({ alerts: state.regionalAlerts });
  }

  updateDataStalenessBanner(nowMs);
  return changed;
}

function evaluateStormWatchState() {
  const hasCriticalOrSevere = state.localAlerts.some((a) => !a.isExpired && (a.tier === 'CRITICAL' || a.tier === 'SEVERE' || a.tier === 'WATCH'));
  const hasApproachingThreat = state.stormCells.some((c) =>
    (c.threatScore >= 2) &&
    (c.intercept.verdict === 'DIRECT_INTERCEPT' || c.intercept.verdict === 'NEAR_MISS') &&
    (c.intercept.etaMinutes == null || c.intercept.etaMinutes <= 60)
  );
  const highEnv = state.environment?.level === 'high';
  state.isStormWatchActive = Boolean(hasCriticalOrSevere || hasApproachingThreat || highEnv);
  scheduleNextPoll();
  syncWakeLock();
}

function scheduleNextPoll() {
  clearPollTimer();
  if (document.hidden) return;
  const intervalMs = (state.settings.adaptiveStormModeEnabled && state.isStormWatchActive)
    ? 45000   // 45 seconds in Active Storm Watch
    : 180000; // 3 minutes in normal weather

  state.pollTimerId = setTimeout(() => {
    state.pollTimerId = null;
    if (!document.hidden) {
      void refreshAllData(true);
    }
  }, intervalMs);
}

let _gestureUnlockArmed = false;

function armGestureUnlock() {
  if (_gestureUnlockArmed) return;
  _gestureUnlockArmed = true;
  const unlockOnGesture = () => {
    _gestureUnlockArmed = false;
    audioEngine.unlockForIOS();
    void syncWakeLock();
    window.removeEventListener('touchstart', unlockOnGesture);
    window.removeEventListener('click', unlockOnGesture);
  };
  window.addEventListener('touchstart', unlockOnGesture, { passive: true });
  window.addEventListener('click', unlockOnGesture, { passive: true });
}

function handlePageHidden() {
  state.wasHidden = true;
  clearPollTimer();
  clearExpirySweepTimer();
  if (typeof radarMap.pauseForBackground === 'function') {
    radarMap.pauseForBackground();
  } else {
    radarMap.stopPlayback();
  }
  const playBtn = document.getElementById('btn-radar-play');
  if (playBtn) playBtn.textContent = '▶';
  void syncWakeLock();
}

function handlePageVisible(isBFCacheRestore = false) {
  state.wasHidden = false;
  armGestureUnlock();
  const resumed = typeof radarMap.resumeFromBackground === 'function'
    ? radarMap.resumeFromBackground()
    : false;
  if (isBFCacheRestore && typeof radarMap.resize === 'function') {
    radarMap.resize();
  }
  const playBtn = document.getElementById('btn-radar-play');
  if (playBtn) playBtn.textContent = resumed ? '⏸' : '▶';

  purgeExpiredAlerts(Date.now());
  startExpirySweep();
  scheduleNextPoll();
  void syncWakeLock();

  // Refresh immediately if returning after > 60s (or BFCache restore with stale/missing data)
  if (!state.lastUpdated || Date.now() - state.lastUpdated.getTime() > 60000) {
    void refreshAllData(true);
  }
}

function stripTransientUpdateParam() {
  try {
    if (typeof window === 'undefined' || !window.location || !window.history || typeof window.history.replaceState !== 'function') return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has('_upd')) return;
    url.searchParams.delete('_upd');
    const clean = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState(null, '', clean);
  } catch {
    // ignore restricted history environments
  }
}

/* ==================== BOOTSTRAP ==================== */
let _tempestBooted = false;

function bootTempest() {
  if (_tempestBooted) return;
  _tempestBooted = true;

  try { stripTransientUpdateParam(); } catch { /* non-fatal */ }
  try { armGestureUnlock(); } catch { /* non-fatal */ }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      handlePageHidden();
    } else {
      handlePageVisible(false);
    }
  });
  window.addEventListener('pagehide', handlePageHidden);
  window.addEventListener('pageshow', (event) => {
    if (!document.hidden && (event?.persisted || state.wasHidden)) {
      handlePageVisible(Boolean(event?.persisted));
    }
  });
  window.addEventListener('online', () => {
    state.isOffline = false;
    void refreshAllData(true);
  });
  window.addEventListener('offline', () => {
    state.isOffline = true;
    updateDataStalenessBanner();
    updateHeaderAndBadges();
  });

  audioEngine.onStateChange = (playingId) => {
    state.activePlayingSoundId = playingId;
    document.getElementById('btn-siren-stop')?.classList.toggle('hidden', !playingId);
    if (state.tab === 'settings') renderSettings();
  };

  try { wireEvents(); } catch { /* non-fatal */ }
  try { checkIosInstallBanner(); } catch { /* non-fatal */ }
  let hydrated = false;
  try { hydrated = hydrateFromSnapshot(); } catch { hydrated = false; }
  try { startExpirySweep(); } catch { /* non-fatal */ }

  void updater.init((manifest) => {
    const banner = document.getElementById('update-banner');
    if (banner) {
      const titleEl = document.getElementById('update-banner-title');
      const subEl = document.getElementById('update-banner-sub');
      if (titleEl) titleEl.textContent = `Tempest v${manifest?.versionName || 'New'} Ready`;
      if (subEl) {
        subEl.textContent = manifest?.releaseNotes
          ? manifest.releaseNotes.slice(0, 88) + '…'
          : 'Tap Update to install instantly.';
      }
      banner.classList.remove('hidden');
    }
    if (state.tab === 'settings') renderSettings();
  }).then((res) => {
    if (res?.status === 'UP_TO_DATE') {
      document.getElementById('update-banner')?.classList.add('hidden');
    }
  }).catch(() => {});

  void refreshAllData(hydrated);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootTempest, { once: true });
} else {
  bootTempest();
}

function checkIosInstallBanner() {
  const el = document.getElementById('ios-install-banner');
  if (!el) return;
  let hiddenThisSession = false;
  try {
    hiddenThisSession = sessionStorage.getItem('tempest_hide_ios_tip') === '1';
  } catch {
    hiddenThisSession = false;
  }
  if (!updater.isStandalone() && !hiddenThisSession) {
    el.classList.remove('hidden');
  }
}

function wireEvents() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.getElementById('btn-refresh')?.addEventListener('click', () => { void refreshAllData(false); });
  document.getElementById('btn-staleness-refresh')?.addEventListener('click', () => { void refreshAllData(false); });
  document.getElementById('btn-gps')?.addEventListener('click', requestGpsLocation);
  document.getElementById('btn-siren-stop')?.addEventListener('click', () => {
    audioEngine.stop();
    stopVoiceBriefing();
  });
  const locTrigger = document.getElementById('location-picker-trigger');
  locTrigger?.addEventListener('click', openLocationModal);
  locTrigger?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openLocationModal();
    }
  });
  document.getElementById('telemetry-ribbon')?.addEventListener('click', () => {
    switchTab(state.localAlerts.length ? 'alerts' : 'radar');
  });

  // Session-only hide so users never permanently lose the Safari Home Screen tip before installing
  document.getElementById('btn-dismiss-ios-banner')?.addEventListener('click', () => {
    try {
      sessionStorage.setItem('tempest_hide_ios_tip', '1');
    } catch {
      // ignore
    }
    document.getElementById('ios-install-banner')?.classList.add('hidden');
  });

  document.getElementById('btn-install-update')?.addEventListener('click', () => {
    showToast('Installing latest Tempest update...');
    void updater.applyUpdateNow().catch(() => {});
  });

  document.querySelectorAll('#radar-product-chips .radar-chip').forEach((chip) => {
    chip.addEventListener('click', () => { void selectRadarProduct(chip.dataset.product); });
  });

  document.querySelectorAll('#radar-quick-flip .qflip-btn').forEach((btn) => {
    btn.addEventListener('click', () => { void selectRadarProduct(btn.dataset.qflip); });
  });

  document.querySelectorAll('#spc-mode-row .spc-mode-btn').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.spcLayer) === (state.settings.spcOverlayLayerId || 1));
    btn.addEventListener('click', () => { void selectSpcOverlayLayer(Number(btn.dataset.spcLayer)); });
  });

  document.querySelectorAll('#wssi-mode-row .wssi-mode-btn').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.wssiLayer) === (state.settings.wssiOverlayLayerId || 4));
    btn.addEventListener('click', () => { void selectWssiOverlayLayer(Number(btn.dataset.wssiLayer)); });
  });

  document.getElementById('btn-close-afd-modal')?.addEventListener('click', () => {
    document.getElementById('afd-modal')?.classList.add('hidden');
  });
  document.getElementById('afd-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'afd-modal') document.getElementById('afd-modal').classList.add('hidden');
  });

  document.getElementById('btn-radar-play')?.addEventListener('click', () => {
    const playing = radarMap.togglePlayback();
    const playBtn = document.getElementById('btn-radar-play');
    if (playBtn) playBtn.textContent = playing ? '⏸' : '▶';
  });
  document.getElementById('btn-radar-speed')?.addEventListener('click', () => {
    const sp = radarMap.toggleSpeed();
    const speedBtn = document.getElementById('btn-radar-speed');
    if (speedBtn) speedBtn.textContent = `${sp}x`;
  });
  document.getElementById('radar-scrubber')?.addEventListener('input', (e) => {
    radarMap.stopPlayback();
    const playBtn = document.getElementById('btn-radar-play');
    if (playBtn) playBtn.textContent = '▶';
    const maxVal = Math.max(1, Number(e.target.max) || 1);
    const curVal = Number(e.target.value) || 0;
    e.target.style.setProperty('--scrubber-pct', `${Math.round((curVal / maxVal) * 100)}%`);
    radarMap.scrubTo(curVal);
  });
  document.getElementById('btn-radar-recenter')?.addEventListener('click', () => {
    radarMap.flyTo(state.activeLocation.lat, state.activeLocation.lon, 8.2, true);
  });
  document.getElementById('radar-storm-hud')?.addEventListener('click', () => {
    if (state.stormCells?.length) {
      const top = state.stormCells[0];
      radarMap.flyTo(top.lat, top.lon, 8.8, false);
      openInspectSheet('cell', top);
    } else {
      radarMap.flyTo(state.activeLocation.lat, state.activeLocation.lon, 8.0, true);
      showToast('No severe storm cells detected within 120 miles.');
    }
  });
  document.getElementById('btn-radar-site')?.addEventListener('click', openSiteModal);
  document.getElementById('btn-radar-layers')?.addEventListener('click', () => {
    document.getElementById('radar-inspect-sheet')?.classList.add('hidden');
    document.getElementById('radar-layers-sheet')?.classList.toggle('hidden');
  });
  document.getElementById('btn-close-layers')?.addEventListener('click', () => {
    document.getElementById('radar-layers-sheet')?.classList.add('hidden');
  });
  document.getElementById('btn-close-inspect')?.addEventListener('click', () => {
    document.getElementById('radar-inspect-sheet')?.classList.add('hidden');
  });

  ['alerts', 'cells', 'watches', 'spc', 'flood', 'wssi', 'mcd', 'lsr'].forEach((key) => {
    document.getElementById(`layer-${key}`)?.addEventListener('change', async (e) => {
      radarMap.setLayerVisibility(key, e.target.checked);
      if (key === 'flood' && e.target.checked && !state.iemIntel?.wpcFloodGeoJson?.features?.length) {
        try {
          const wpcFloodGeoJson = await fetchWpcFloodOutlook();
          state.iemIntel = { ...(state.iemIntel || {}), wpcFloodGeoJson };
          radarMap.setOverlayData({ wpcFloodGeoJson });
        } catch {
          // non-fatal when offline
        }
      }
      if (key === 'wssi' && e.target.checked && !state.wssiBundle?.overlayGeoJson?.features?.length) {
        try {
          const lid = state.settings.wssiOverlayLayerId || 4;
          const bundle = await fetchWpcWssiBundle(lid);
          state.wssiBundle = bundle;
          radarMap.setOverlayData({ wpcWssiGeoJson: bundle.overlayGeoJson });
        } catch {
          // non-fatal when offline
        }
      }
    });
  });

  const opSlider = document.getElementById('radar-opacity-slider');
  if (opSlider) {
    const initPct = Math.round(state.settings.radarOpacity * 100);
    opSlider.value = initPct;
    opSlider.style.setProperty('--range-pct', `${Math.round(((initPct - 25) / 75) * 100)}%`);
    document.getElementById('radar-opacity-val').textContent = `${opSlider.value}%`;
    opSlider.addEventListener('input', (e) => {
      const pct = Number(e.target.value);
      opSlider.style.setProperty('--range-pct', `${Math.round(((pct - 25) / 75) * 100)}%`);
      document.getElementById('radar-opacity-val').textContent = `${pct}%`;
      state.settings.radarOpacity = pct / 100;
      saveSettings();
      radarMap.setOpacity(state.settings.radarOpacity);
    });
  }
  document.querySelectorAll('.seg-btn[data-basemap]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.basemap === state.settings.basemap);
    btn.addEventListener('click', () => {
      const bm = btn.dataset.basemap;
      state.settings.basemap = bm;
      saveSettings();
      document.querySelectorAll('.seg-btn[data-basemap]').forEach((b) => b.classList.toggle('active', b.dataset.basemap === bm));
      radarMap.setBasemap(bm);
    });
  });

  document.getElementById('btn-close-location-modal')?.addEventListener('click', closeLocationModal);
  document.getElementById('location-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'location-modal') closeLocationModal();
  });
  document.getElementById('btn-location-search')?.addEventListener('click', runLocationSearch);
  document.getElementById('location-search-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runLocationSearch();
  });

  document.getElementById('btn-close-site-modal')?.addEventListener('click', () => {
    document.getElementById('site-modal')?.classList.add('hidden');
  });
  document.getElementById('site-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'site-modal') document.getElementById('site-modal').classList.add('hidden');
  });
  document.getElementById('site-search-input')?.addEventListener('input', renderSiteList);

  document.getElementById('btn-alert-popup-dismiss')?.addEventListener('click', () => {
    state.activePopupAlertId = null;
    audioEngine.stop();
    stopVoiceBriefing();
    document.getElementById('alert-popup-modal')?.classList.add('hidden');
  });
  document.getElementById('btn-alert-popup-radar')?.addEventListener('click', () => {
    state.activePopupAlertId = null;
    audioEngine.stop();
    stopVoiceBriefing();
    document.getElementById('alert-popup-modal')?.classList.add('hidden');
    switchTab('radar');
  });
}

function switchTab(tabName) {
  state.tab = tabName;
  if (tabName !== 'radar') {
    radarMap.stopPlayback();
    const playBtn = document.getElementById('btn-radar-play');
    if (playBtn) playBtn.textContent = '▶';
  }
  document.querySelectorAll('.tab-btn').forEach((b) => {
    const active = b.dataset.tab === tabName;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.tab-view').forEach((v) => {
    v.classList.toggle('active', v.id === `tab-${tabName}`);
  });

  if (tabName === 'radar') {
    void ensureRadarReady().catch(() => {});
  } else if (tabName === 'alerts') {
    purgeExpiredAlerts(Date.now());
    renderAlerts();
  } else if (tabName === 'settings') {
    renderSettings();
  } else {
    renderDashboard();
  }
}

function hydrateFromSnapshot() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SNAPSHOT);
    if (!raw) return false;
    const snap = JSON.parse(raw);
    if (!snap || snap.locId !== state.activeLocation?.id) return false;
    if (!snap.savedAt || Date.now() - snap.savedAt > 6 * 3600 * 1000) return false;

    const nowMs = Date.now();
    const loc = state.activeLocation || getSavedHomeLocation();

    state.nwsBundle = snap.nwsBundle || null;
    if (state.nwsBundle && !state.nwsBundle._meta && snap.savedAt) {
      state.nwsBundle._meta = { fetchedAtMs: snap.savedAt };
    }
    state.openMeteo = snap.openMeteo || (snap.openMeteoMeta ? { _meta: snap.openMeteoMeta } : null);
    state.current = snap.current || null;
    state.environment = snap.environment || null;
    state.winter = snap.winter || null;
    state.localAlerts = filterAndDeduplicateAlerts(snap.localAlerts || [], loc.lat, loc.lon, nowMs);
    state.alerts = state.localAlerts;
    state.regionalAlerts = filterAndDeduplicateAlerts(snap.regionalAlerts || [], loc.lat, loc.lon, nowMs);
    state.stormCells = snap.stormCells || [];
    state.multiDaySpc = snap.multiDaySpc || null;
    state.afd = snap.afd || null;
    if (snap.selectedRadarSite) state.selectedRadarSite = snap.selectedRadarSite;
    state.lastUpdated = snap.savedAt ? new Date(snap.savedAt) : null;

    evaluateStormWatchState();
    updateHeaderAndBadges();
    updateDataStalenessBanner(nowMs);
    updateTelemetryRibbon();
    updateRadarStormHud();
    renderDashboard();
    renderAlerts();
    return Boolean(state.current);
  } catch {
    return false;
  }
}

function saveSnapshot() {
  try {
    if (!state.activeLocation?.id || !state.current) return;
    const compactBundle = state.nwsBundle ? {
      cityLabel: state.nwsBundle.cityLabel,
      stateCode: state.nwsBundle.stateCode,
      cwa: state.nwsBundle.cwa,
      radarStation: state.nwsBundle.radarStation,
      forecastPeriods: (state.nwsBundle.forecastPeriods || []).slice(0, 14),
      hourlyPeriods: (state.nwsBundle.hourlyPeriods || []).slice(0, 24),
      observations: (state.nwsBundle.observations || []).slice(0, 2),
      _meta: state.nwsBundle._meta || null
    } : null;
    const compactSnap = {
      locId: state.activeLocation.id,
      savedAt: state.lastUpdated ? state.lastUpdated.getTime() : Date.now(),
      selectedRadarSite: state.selectedRadarSite,
      nwsBundle: compactBundle,
      openMeteoMeta: state.openMeteo?._meta || null,
      current: state.current,
      environment: state.environment,
      winter: state.winter,
      localAlerts: (state.localAlerts || []).slice(0, 8).map(({ geometry, ...rest }) => rest),
      stormCells: (state.stormCells || []).slice(0, 12),
      multiDaySpc: state.multiDaySpc,
      afd: state.afd
    };
    localStorage.setItem(STORAGE_KEY_SNAPSHOT, JSON.stringify(compactSnap));
  } catch {
    // ignore storage quota errors
  }
}

function updateTelemetryRibbon() {
  const ribbon = document.getElementById('telemetry-ribbon');
  const threatEl = document.getElementById('telem-threat');
  const radarEl = document.getElementById('telem-radar');
  const cellsEl = document.getElementById('telem-cells');
  const stpEl = document.getElementById('telem-stp');
  if (!ribbon || !threatEl) return;

  const site = state.selectedRadarSite || findNearestNexradStation(state.activeLocation.lat, state.activeLocation.lon).id;
  if (radarEl) radarEl.textContent = site;

  const cells = state.stormCells || [];
  const tvsCnt = cells.filter((c) => c.threatLevel === 'TORNADO_TVS').length;
  const supCnt = cells.filter((c) => c.threatLevel === 'SUPERCELL').length;
  const svrCnt = cells.filter((c) => c.threatLevel === 'SEVERE').length;
  if (cellsEl) {
    cellsEl.textContent = `${cells.length} ${cells.length === 1 ? 'CELL' : 'CELLS'}${supCnt || tvsCnt ? ` (${tvsCnt + supCnt} ROT)` : ''}`;
  }

  const stp = Number(state.environment?.stp ?? 0);
  const cape = Number(state.environment?.peakCape12h ?? 0);
  if (stpEl) {
    stpEl.textContent = stp >= 0.3 ? `STP ${stp.toFixed(1)}` : `CAPE ${Math.round(cape)}`;
  }

  const alerts = state.localAlerts || [];
  const hasCritical = alerts.some((a) => a.tier === 'CRITICAL') || tvsCnt > 0;
  const hasSevere = alerts.some((a) => a.tier === 'SEVERE') || svrCnt > 0 || supCnt > 0;
  const hasWatch = alerts.some((a) => a.tier === 'WATCH');
  const hasWinter = (state.winter?.hazardLevel && state.winter.hazardLevel !== 'CLEAR') || alerts.some((a) => a.tier === 'WINTER');
  const hasAdvisory = alerts.length > 0 || state.environment?.level === 'high' || state.environment?.level === 'mod';

  ribbon.className = 'telemetry-ribbon';
  if (hasCritical) {
    ribbon.classList.add('tone-critical');
    threatEl.textContent = tvsCnt > 0 ? 'TVS DETECTED' : 'EMERGENCY WARN';
  } else if (hasSevere) {
    ribbon.classList.add('tone-severe');
    threatEl.textContent = supCnt > 0 ? 'SUPERCELL TRACK' : 'SEVERE ACTIVE';
  } else if (hasWatch) {
    ribbon.classList.add('tone-watch');
    threatEl.textContent = 'WATCH ACTIVE';
  } else if (hasWinter) {
    ribbon.classList.add('tone-advisory');
    threatEl.textContent = 'WINTER HAZARD';
  } else if (hasAdvisory) {
    ribbon.classList.add('tone-advisory');
    threatEl.textContent = 'ADVISORY / CONV';
  } else {
    ribbon.classList.add('tone-clear');
    threatEl.textContent = 'ALL CLEAR';
  }
}

function mergeDegradedIemIntel(prev, next) {
  if (!next) return prev;
  if (!prev) return next;
  const degraded = new Set(next._meta?.degradedFeeds || []);
  const coreOk = next._meta?.anyCoreFeedSucceeded !== false && degraded.size < 4;
  if (!coreOk && !next._meta?.succeededFeeds?.length) {
    // Total offline drop — preserve previous valid intel & its honest age instead of blanking the map
    return prev;
  }
  return {
    stormCellsGeoJson: degraded.has('stormCells') ? (prev.stormCellsGeoJson || next.stormCellsGeoJson) : next.stormCellsGeoJson,
    lsrGeoJson: degraded.has('lsr') ? (prev.lsrGeoJson || next.lsrGeoJson) : next.lsrGeoJson,
    mcdGeoJson: degraded.has('mcd') ? (prev.mcdGeoJson || next.mcdGeoJson) : next.mcdGeoJson,
    spcWatchesGeoJson: degraded.has('spcWatches') ? (prev.spcWatchesGeoJson || next.spcWatchesGeoJson) : next.spcWatchesGeoJson,
    wpcFloodGeoJson: (degraded.has('wpcFlood') || (!next.wpcFloodGeoJson?.features?.length && prev.wpcFloodGeoJson?.features?.length))
      ? (prev.wpcFloodGeoJson || next.wpcFloodGeoJson)
      : next.wpcFloodGeoJson,
    spcOverlayGeoJson: (degraded.has('spcOverlay') || (!next.spcOverlayGeoJson?.features?.length && prev.spcOverlayGeoJson?.features?.length))
      ? (prev.spcOverlayGeoJson || next.spcOverlayGeoJson)
      : next.spcOverlayGeoJson,
    spcDay1GeoJson: (!next.spcDay1GeoJson?.features?.length && prev.spcDay1GeoJson?.features?.length) ? prev.spcDay1GeoJson : next.spcDay1GeoJson,
    spcDay1TorGeoJson: (!next.spcDay1TorGeoJson?.features?.length && prev.spcDay1TorGeoJson?.features?.length) ? prev.spcDay1TorGeoJson : next.spcDay1TorGeoJson,
    spcDay1HailGeoJson: (!next.spcDay1HailGeoJson?.features?.length && prev.spcDay1HailGeoJson?.features?.length) ? prev.spcDay1HailGeoJson : next.spcDay1HailGeoJson,
    spcDay1WindGeoJson: (!next.spcDay1WindGeoJson?.features?.length && prev.spcDay1WindGeoJson?.features?.length) ? prev.spcDay1WindGeoJson : next.spcDay1WindGeoJson,
    spcDay2GeoJson: (!next.spcDay2GeoJson?.features?.length && prev.spcDay2GeoJson?.features?.length) ? prev.spcDay2GeoJson : next.spcDay2GeoJson,
    spcDay3GeoJson: (!next.spcDay3GeoJson?.features?.length && prev.spcDay3GeoJson?.features?.length) ? prev.spcDay3GeoJson : next.spcDay3GeoJson,
    _meta: degraded.has('stormCells') && prev._meta?.fetchedAtMs != null
      ? { ...next._meta, fetchedAtMs: prev._meta.fetchedAtMs, fetchedAtUtc: prev._meta.fetchedAtUtc, fetchedAtCentral: prev._meta.fetchedAtCentral, latestCellMs: prev._meta.latestCellMs }
      : next._meta
  };
}

function switchActiveLocation(newLoc, { fly = true } = {}) {
  if (!newLoc || !isValidLatLon(Number(newLoc.lat), Number(newLoc.lon))) return;
  const prev = state.activeLocation;
  const changed = !prev ||
    prev.id !== newLoc.id ||
    Math.abs(Number(prev.lat) - Number(newLoc.lat)) > 1e-4 ||
    Math.abs(Number(prev.lon) - Number(newLoc.lon)) > 1e-4;

  state.activeLocation = { ...newLoc, lat: Number(newLoc.lat), lon: Number(newLoc.lon) };
  state.selectedRadarSite = findNearestNexradStation(state.activeLocation.lat, state.activeLocation.lon).id;

  if (changed) {
    // Invalidate any in-flight refresh for the prior location & clear location-scoped data
    state.refreshSeq += 1;
    state.nwsBundle = null;
    state.openMeteo = null;
    state.current = null;
    state.environment = null;
    state.winter = null;
    state.localAlerts = [];
    state.alerts = [];
    state.regionalAlerts = [];
    state.radarFrames = [];
    state.stormCells = [];
    state.winterModels = null;
    state.multiDaySpc = null;
    state.afd = null;
    state.lastUpdated = null;
    if (state.activePopupAlertId) {
      state.activePopupAlertId = null;
      audioEngine.stop();
      stopVoiceBriefing();
      document.getElementById('alert-popup-modal')?.classList.add('hidden');
    }
    updateHeaderAndBadges();
    updateTelemetryRibbon();
    updateRadarStormHud();
  }

  if (fly) {
    radarMap.flyTo(state.activeLocation.lat, state.activeLocation.lon, 8.2, true);
  }
  void refreshAllData(false);
}

/* ==================== DATA SYNC ==================== */
async function refreshAllData(silent = false) {
  if (state.isLoading) {
    // Queue explicit user refresh / location switch so it is never silently dropped
    if (!silent) {
      state.pendingRefresh = { silent: false };
    }
    return;
  }
  state.isLoading = true;
  const reqSeq = ++state.refreshSeq;
  const force = !silent;
  const refBtn = document.getElementById('btn-refresh');
  if (!silent) refBtn?.classList.add('spinning');

  if (!state.activeLocation || !isValidLatLon(Number(state.activeLocation.lat), Number(state.activeLocation.lon))) {
    state.activeLocation = getSavedHomeLocation();
  }
  const { lat, lon } = state.activeLocation;
  const nearest = findNearestNexradStation(lat, lon);
  if (!state.selectedRadarSite) {
    state.selectedRadarSite = nearest.id;
  }

  const locNameEl = document.getElementById('header-location-name');
  if (locNameEl) locNameEl.textContent = state.activeLocation.name;
  const statusSubEl = document.getElementById('header-status-sub');
  if (!silent && !state.current && statusSubEl) {
    statusSubEl.textContent = 'Syncing NWS, HRRR/GFS & NEXRAD...';
  }

  const includeFlood = Boolean(document.getElementById('layer-flood')?.checked);

  try {
    const wssiLayerId = state.settings.wssiOverlayLayerId || 4;
    const [nwsRes, omRes, iemRes, winModelRes, wssiRes] = await Promise.allSettled([
      fetchNwsPointBundle(lat, lon, force),
      fetchOpenMeteo(lat, lon),
      fetchIemStormIntel(state.settings.spcOverlayLayerId || 1, { includeFlood, force }),
      fetchOpenMeteoWinterModels(lat, lon, { force }).catch(() => null),
      fetchWpcWssiBundle(wssiLayerId, force).catch(() => null)
    ]);

    // Abort stale write-back if user switched locations while requests were in flight
    if (reqSeq !== state.refreshSeq) return;

    const nwsOk = nwsRes.status === 'fulfilled' && Boolean(nwsRes.value);
    const omOk = omRes.status === 'fulfilled' && Boolean(omRes.value);
    const iemOk = iemRes.status === 'fulfilled' && Boolean(iemRes.value) && !iemRes.value._meta?.degraded;

    if (nwsOk) {
      const prevNws = state.nwsBundle;
      const nextNws = nwsRes.value;
      state.nwsBundle = {
        ...nextNws,
        forecastPeriods: nextNws.forecastPeriods?.length ? nextNws.forecastPeriods : (prevNws?.forecastPeriods || []),
        hourlyPeriods: nextNws.hourlyPeriods?.length ? nextNws.hourlyPeriods : (prevNws?.hourlyPeriods || []),
        gridData: nextNws.gridData || prevNws?.gridData || null,
        observations: nextNws.observations?.length ? nextNws.observations : (prevNws?.observations || [])
      };
    }
    if (omOk) state.openMeteo = omRes.value;
    if (iemRes.status === 'fulfilled' && iemRes.value) {
      state.iemIntel = mergeDegradedIemIntel(state.iemIntel, iemRes.value);
    }
    if (winModelRes.status === 'fulfilled' && winModelRes.value) {
      state.winterModels = winModelRes.value;
    }
    if (wssiRes.status === 'fulfilled' && wssiRes.value) {
      const nextWssi = wssiRes.value;
      if (nextWssi._meta?.allFailed && state.wssiBundle) {
        // Offline / total WSSI failure — preserve prior valid WSSI polygons
      } else if (nextWssi._meta?.degraded && state.wssiBundle?.layers) {
        const failedIds = new Set(nextWssi._meta.failedLayerIds || []);
        const mergedLayers = { ...nextWssi.layers };
        for (const fid of failedIds) {
          if (state.wssiBundle.layers[fid]) mergedLayers[fid] = state.wssiBundle.layers[fid];
        }
        const activeId = nextWssi.overlayLayerId || wssiLayerId;
        state.wssiBundle = {
          ...nextWssi,
          layers: mergedLayers,
          overlayGeoJson: mergedLayers[activeId] || nextWssi.overlayGeoJson
        };
      } else {
        state.wssiBundle = nextWssi;
      }
    }

    if (state.nwsBundle?.cityLabel && state.activeLocation.id === 'gps_current') {
      state.activeLocation.name = `${state.nwsBundle.cityLabel} (GPS)`;
    }

    let alertsSucceeded = false;
    const [alertsRes, afdRes] = await Promise.all([
      fetchNwsAlerts(lat, lon, state.nwsBundle?.stateCode)
        .then((res) => {
          alertsSucceeded = !res?._meta?.degraded;
          return res || { localFeatures: [], regionalFeatures: [] };
        })
        .catch(() => ({
          localFeatures: [],
          regionalFeatures: [],
          _meta: { degraded: true }
        })),
      fetchNwsAfd(state.nwsBundle?.cwa, force).catch(() => null)
    ]);

    if (reqSeq !== state.refreshSeq) return;

    if (afdRes) state.afd = afdRes;
    state.multiDaySpc = evaluateMultiDayOutlooks(lat, lon, state.iemIntel);

    const nowMs = Date.now();
    const anyFeedSucceeded = nwsOk || omOk || iemOk || alertsSucceeded;
    state.isOffline = !anyFeedSucceeded;

    if (alertsSucceeded || (alertsRes.localFeatures || []).length > 0 || (alertsRes.regionalFeatures || []).length > 0) {
      const regionalRaw = alertsRes.regionalFeatures || [];
      const regionalFiltered = filterAndDeduplicateAlerts(regionalRaw, lat, lon, nowMs);
      const survivingRegionalIds = new Set(regionalFiltered.map((a) => a.canonicalId));
      const localFiltered = filterAndDeduplicateAlerts(alertsRes.localFeatures || [], lat, lon, nowMs)
        .filter((a) => regionalRaw.length === 0 || survivingRegionalIds.has(a.canonicalId));

      state.localAlerts = localFiltered;
      state.alerts = localFiltered;
      state.regionalAlerts = regionalFiltered;
    } else {
      // Offline / degraded alert fetch: purge any previously cached alerts that have since expired
      state.localAlerts = filterAndDeduplicateAlerts(state.localAlerts || [], lat, lon, nowMs);
      state.alerts = state.localAlerts;
      state.regionalAlerts = filterAndDeduplicateAlerts(state.regionalAlerts || [], lat, lon, nowMs);
    }

    // Dismiss active live-warning popup immediately if that warning expired or was cancelled
    if (state.activePopupAlertId && !state.localAlerts.some((a) => (a.canonicalId || a.id) === state.activePopupAlertId)) {
      state.activePopupAlertId = null;
      audioEngine.stop();
      stopVoiceBriefing();
      document.getElementById('alert-popup-modal')?.classList.add('hidden');
    }

    if (state.nwsBundle || state.openMeteo) {
      state.current = resolveCurrentConditions(state.nwsBundle, state.openMeteo, nowMs);
    }
    const mcdCount = state.iemIntel?.mcdGeoJson?.features?.length || 0;
    if (state.openMeteo?.hourly || !state.environment) {
      state.environment = analyzeEnvironment(state.openMeteo, state.current, mcdCount, {
        convectiveAlertThreshold: state.settings.convectiveAlertThreshold,
        nocturnalReadinessEnabled: state.settings.nocturnalReadinessEnabled,
        multiDaySpc: state.multiDaySpc,
        nowMs
      });
    }
    if (state.openMeteo?.hourly || !state.winter) {
      state.winter = analyzeWinterSuite(state.openMeteo, state.current, state.settings.groundFreezeThresholdF, nowMs, {
        gridData: state.nwsBundle?.gridData || null,
        winterModels: state.winterModels,
        wssiBundle: state.wssiBundle,
        lat,
        lon
      });
    }
    state.stormCells = analyzeStormCells(state.iemIntel?.stormCellsGeoJson, lat, lon, 120, nowMs);

    if (anyFeedSucceeded) {
      state.lastUpdated = new Date(nowMs);
    }

    evaluateStormWatchState();
    updateDataStalenessBanner(nowMs);
    updateHeaderAndBadges();
    updateTelemetryRibbon();
    updateRadarStormHud();
    renderDashboard();
    renderAlerts();
    if (anyFeedSucceeded) saveSnapshot();
    if (state.tab === 'settings') renderSettings();

    radarMap.setUserLocation(lat, lon);
    syncRadarOverlays();

    // Do not fabricate fresh CONUS_MOSAIC timestamps when completely offline if frames already exist
    if (state.tab === 'radar' && (anyFeedSucceeded || !state.radarFrames.length)) {
      await loadRadarFramesForCurrentProduct();
    }

    checkAllLiveAlertTriggers();
    if (!silent) {
      showToast(anyFeedSucceeded ? 'Weather, radar & severe intel updated' : 'Offline — showing last available data');
    }
  } catch (err) {
    if (reqSeq !== state.refreshSeq) return;
    state.isOffline = true;
    updateDataStalenessBanner(Date.now());
    if (statusSubEl) statusSubEl.textContent = 'Offline or partial feed — tap refresh';
    if (!silent) showToast(`Sync error: ${err?.message || 'Check connection'}`);
    scheduleNextPoll();
  } finally {
    state.isLoading = false;
    refBtn?.classList.remove('spinning');
    if (state.pendingRefresh) {
      const nextReq = state.pendingRefresh;
      state.pendingRefresh = null;
      setTimeout(() => { void refreshAllData(nextReq.silent); }, 0);
    }
  }
}

function updateHeaderAndBadges() {
  const loc = state.activeLocation || getSavedHomeLocation();
  const locEl = document.getElementById('header-location-name');
  if (locEl) locEl.textContent = loc.name;
  const clock = state.lastUpdated ? formatCentralTime(state.lastUpdated) : '--';
  const site = state.selectedRadarSite || findNearestNexradStation(loc.lat, loc.lon).id;
  const watchTag = (state.settings.adaptiveStormModeEnabled && state.isStormWatchActive) ? '⚡ STORM WATCH (45s) • ' : '';
  const offlineTag = state.isOffline ? 'OFFLINE • ' : '';
  const subEl = document.getElementById('header-status-sub');
  if (subEl) {
    subEl.textContent = `${offlineTag}${watchTag}Updated ${clock} • Radar ${site} • v${APP_LOCAL_VERSION.versionName}`;
  }

  updateDataStalenessBanner();

  const leadMin = state.settings.proactiveTotLeadMinutes || 35;
  const threatCells = state.stormCells.filter((c) =>
    c.threatScore >= 2 &&
    (
      c.tvs ||
      c.threatLevel === 'SUPERCELL' ||
      ((c.intercept.verdict === 'DIRECT_INTERCEPT' || c.intercept.verdict === 'NEAR_MISS') &&
        c.intercept.etaMinutes != null && c.intercept.etaMinutes <= leadMin)
    )
  );
  const totalCount = state.localAlerts.length + threatCells.length +
    (state.winter?.winterAlerts?.length || 0) +
    (state.environment?.proactiveAlerts?.length || 0);

  const badge = document.getElementById('alerts-badge');
  if (badge) {
    badge.textContent = String(totalCount);
    badge.classList.toggle('hidden', totalCount === 0);
  }
}

function updateRadarStormHud() {
  const pill = document.getElementById('radar-storm-hud');
  const txt = document.getElementById('radar-hud-text');
  if (!pill || !txt) return;

  const cells = state.stormCells || [];
  const tvsCells = cells.filter((c) => c.threatLevel === 'TORNADO_TVS');
  const supCells = cells.filter((c) => c.threatLevel === 'SUPERCELL');
  const svrCells = cells.filter((c) => c.threatLevel === 'SEVERE');

  pill.classList.remove('hud-critical', 'hud-supercell', 'hud-severe');
  if (tvsCells.length) {
    pill.classList.add('hud-critical');
    txt.textContent = `TVS ${tvsCells.length} · ${fmtFixed(tvsCells[0].intercept?.distanceMi, 0)} mi`;
  } else if (supCells.length) {
    pill.classList.add('hud-supercell');
    txt.textContent = `${supCells.length} Sup · ${fmtFixed(supCells[0].intercept?.distanceMi, 0)} mi ${supCells[0].moveToCompass}`;
  } else if (svrCells.length) {
    pill.classList.add('hud-severe');
    txt.textContent = `${svrCells.length} Svr · ${fmtFixed(svrCells[0].intercept?.distanceMi, 0)} mi`;
  } else if (cells.length) {
    txt.textContent = `${cells.length} Cell${cells.length > 1 ? 's' : ''} · ${fmtFixed(cells[0].intercept?.distanceMi, 0)} mi`;
  } else {
    txt.textContent = '✓ Area Clear';
  }
}

/**
 * Full 5-Tier Severe Weather Trigger Engine — honors every Settings toggle,
 * deduplicates persistently in localStorage, and re-triggers immediately on escalations.
 */
function checkAllLiveAlertTriggers() {
  const s = state.settings;
  const nowMs = Date.now();

  // 1. CRITICAL NWS Alerts (Tornado Warning, Tornado Emergency, Flash Flood Emergency) — ALWAYS active
  const topCritical = state.localAlerts.find((a) =>
    !isAlertExpired(a, nowMs) &&
    a.tier === 'CRITICAL' &&
    !isNwsAlertAlreadyNotified(a)
  );
  if (topCritical) {
    markNotified(getNwsNotificationKey(topCritical), topCritical.escalationFingerprint);
    const badge = topCritical.isTornadoEmergency
      ? 'TORNADO EMERGENCY'
      : topCritical.isPdsOrObserved
        ? 'OBSERVED / PDS TORNADO'
        : 'CRITICAL WARNING';
    const tags = [
      topCritical.insidePolygon === true ? 'YOU ARE INSIDE THE WARNING POLYGON' : null,
      topCritical.tornadoDetection ? `Tornado: ${topCritical.tornadoDetection}` : null,
      topCritical.tornadoDamageThreat ? `Threat: ${topCritical.tornadoDamageThreat}` : null,
      topCritical.maxWindGust ? `Wind: ${topCritical.maxWindGust}` : null,
      topCritical.maxHailSize ? `Hail: ${topCritical.maxHailSize}"` : null
    ].filter(Boolean).join(' • ');

    triggerAlertPopup({
      badge,
      title: topCritical.event,
      body: `${tags ? tags + '\n\n' : ''}${topCritical.headline}\n\n${topCritical.instruction || topCritical.areaDesc}`,
      soundId: s.tornadoSoundId,
      loop: topCritical.isTornadoEmergency || topCritical.isPdsOrObserved,
      alertCanonicalId: topCritical.canonicalId || topCritical.id
    });
    return;
  }

  // 2. SEVERE NWS Alerts (Severe Thunderstorm Warning, Flash Flood Warning, Snow Squall Warning)
  if (s.severeWarningAlertsEnabled) {
    const topSevere = state.localAlerts.find((a) =>
      !isAlertExpired(a, nowMs) &&
      a.tier === 'SEVERE' &&
      !isNwsAlertAlreadyNotified(a)
    );
    if (topSevere) {
      markNotified(getNwsNotificationKey(topSevere), topSevere.escalationFingerprint);
      const badge = topSevere.isDestructiveSevere ? 'DESTRUCTIVE SEVERE WARNING' : 'SEVERE WARNING';
      triggerAlertPopup({
        badge,
        title: topSevere.event,
        body: `${topSevere.insidePolygon === true ? 'INSIDE WARNING POLYGON\n' : ''}${topSevere.headline}\n\n${topSevere.instruction || topSevere.areaDesc}`,
        soundId: 'svr_tstorm_alarm',
        loop: false,
        alertCanonicalId: topSevere.canonicalId || topSevere.id
      });
      return;
    }
  }

  // 3. Proactive NEXRAD Storm Cell Time-on-Target (TOT) Intercept
  if (s.proactiveTotAlertsEnabled) {
    const leadMin = s.proactiveTotLeadMinutes || 35;
    const incoming = state.stormCells.find((c) => {
      const fp = `${c.threatLevel}_${c.intercept?.verdict}`;
      return c.threatScore >= 2 &&
        (c.intercept?.verdict === 'DIRECT_INTERCEPT' || c.intercept?.verdict === 'NEAR_MISS') &&
        c.intercept?.etaMinutes != null &&
        c.intercept.etaMinutes <= leadMin &&
        !hasBeenNotified(`cell_${c.id}`, fp);
    });
    if (incoming) {
      const fp = `${incoming.threatLevel}_${incoming.intercept.verdict}`;
      markNotified(`cell_${incoming.id}`, fp);
      const isRot = incoming.threatLevel === 'TORNADO_TVS' || incoming.threatLevel === 'SUPERCELL';
      triggerAlertPopup({
        badge: incoming.tvs ? 'TVS STORM INTERCEPT' : isRot ? 'ROTATING SUPERCELL TOT' : 'APPROACHING SEVERE CELL',
        title: `Cell ${incoming.stormId} • ETA ~${incoming.intercept.etaMinutes} min`,
        body: `${fmtFixed(incoming.intercept.distanceMi, 1)} mi ${incoming.intercept.compassFromUser} moving ${incoming.moveToCompass} @ ${incoming.speedMph} mph\n${incoming.intercept.verdictLabel}${incoming.maxHailIn ? ` • Hail ${incoming.maxHailIn}"` : ''}\n\nProactive Borden Tempest radar-cell tracking — open Radar to verify Velocity (N0G) & CC Debris (N0C).`,
        soundId: isRot ? 'supercell_alert_alarm' : 'storm_tot_ping',
        loop: false
      });
      return;
    }
  }

  // 4. Convective / HSLC / Nocturnal Environment Alerts (suppressed while an active CRITICAL/SEVERE warning is already in effect)
  const hasActiveOfficialWarning = state.localAlerts.some((a) =>
    !isAlertExpired(a, nowMs) && (a.tier === 'CRITICAL' || a.tier === 'SEVERE')
  );
  if (!hasActiveOfficialWarning && s.convectiveAlertsEnabled && state.environment?.proactiveAlerts?.length) {
    const ca = state.environment.proactiveAlerts[0];
    const hourBucket = new Date(nowMs).toISOString().slice(0, 13); // dedupe per 1-hour window per regime
    if (!hasBeenNotified(`env_${ca.id}`, hourBucket)) {
      markNotified(`env_${ca.id}`, hourBucket);
      triggerAlertPopup({
        badge: state.environment.nocturnalEscalated ? 'NOCTURNAL READINESS' : 'CONVECTIVE ENVIRONMENT',
        title: ca.title,
        body: `${ca.summary}\n\n${state.environment.nocturnalRisk}`,
        soundId: 'convective_chime',
        loop: false
      });
      return;
    }
  }

  // 5. Winter / Black Ice / Freezing Fog / Pro Winter Ice, Snow & Refreeze Alerts
  if (s.winterAlertsEnabled && state.winter) {
    const pw = state.winter.proWinter;
    let wa = (state.winter.winterAlerts || []).find((w) => w.severity === 'high') || null;
    if (!wa && pw) {
      const ice72 = Number(pw.ice72hIn) || 0;
      const snow72 = Number(pw.snow72hIn) || 0;
      const hasHighIce = ice72 >= 0.25 || pw.iceRiskTier === 'HIGH' || pw.iceRiskTier === 'CATASTROPHIC';
      const roadSnow = pw.roadSnow72hIn != null ? Number(pw.roadSnow72hIn) : snow72;
      const hasHighSnow = pw.groundAccumStatus !== 'WARM_GROUND_MELTS' && pw.groundAccumStatus !== 'GRASS_SLUSH_ONLY' && roadSnow >= 4.0;
      const hasRefreeze = (Array.isArray(pw.hourlySlots) && pw.hourlySlots.some((slot) => slot?.pType === 'REFREEZE')) ||
        (typeof pw.refreezeLabel === 'string' && pw.refreezeLabel.length > 0 && !pw.refreezeLabel.startsWith('No '));
      if (hasHighIce) {
        wa = {
          id: 'pro_winter_ice',
          title: pw.headline || `Ice Storm Threat (${ice72.toFixed(2)}")`,
          summary: [pw.iceRiskDetail || 'Damaging glaze accretion forecast.', pw.changeoverLabel].filter(Boolean).join(' • '),
          severity: 'high'
        };
      } else if (hasHighSnow) {
        wa = {
          id: 'pro_winter_snow',
          title: pw.headline || `Winter Storm (${snow72.toFixed(1)}" Snow)`,
          summary: [`${fmtFixed(pw.snow24hIn, 1, '0.0')}" / 24h`, pw.peakWindowLabel].filter(Boolean).join(' • '),
          severity: 'high'
        };
      } else if (hasRefreeze) {
        wa = {
          id: 'pro_winter_refreeze',
          title: 'Black-Ice Refreeze Hazard',
          summary: [pw.refreezeLabel || 'Wet-to-freeze refreeze detected', pw.thawLabel].filter(Boolean).join(' • '),
          severity: 'high'
        };
      }
    }
    if (wa && wa.severity === 'high') {
      const hourBucket = new Date(nowMs).toISOString().slice(0, 13);
      if (!hasBeenNotified(`win_${wa.id}`, hourBucket)) {
        markNotified(`win_${wa.id}`, hourBucket);
        triggerAlertPopup({
          badge: 'WINTER SURFACE HAZARD',
          title: wa.title,
          body: wa.summary,
          soundId: 'winter_alert_chime',
          loop: false
        });
      }
    }
  }
}

function fallbackToSavedHomeLocation(reasonLabel) {
  state.isLocatingGps = false;
  const gpsBtn = document.getElementById('btn-gps');
  gpsBtn?.classList.remove('spinning');

  const home = getSavedHomeLocation();
  if (
    !state.activeLocation ||
    !isValidLatLon(Number(state.activeLocation.lat), Number(state.activeLocation.lon)) ||
    state.activeLocation.id === 'gps_current'
  ) {
    state.activeLocation = home;
    state.selectedRadarSite = findNearestNexradStation(home.lat, home.lon).id;
  }

  showToast(`${reasonLabel} — using ${state.activeLocation.name}.`);
  updateHeaderAndBadges();
  scheduleNextPoll();
  if (!state.current && !state.isLoading) {
    void refreshAllData(true);
  }
}

function requestGpsLocation() {
  if (state.isLocatingGps) return;
  if (typeof navigator === 'undefined' || !navigator.geolocation || typeof navigator.geolocation.getCurrentPosition !== 'function') {
    fallbackToSavedHomeLocation('GPS unavailable on this browser');
    return;
  }

  state.isLocatingGps = true;
  const gpsBtn = document.getElementById('btn-gps');
  gpsBtn?.classList.add('spinning');
  showToast('Requesting GPS location...');

  let settled = false;
  const watchdogId = setTimeout(() => {
    if (settled) return;
    settled = true;
    fallbackToSavedHomeLocation('GPS timed out');
  }, 11500);

  const finishGps = () => {
    clearTimeout(watchdogId);
    state.isLocatingGps = false;
    gpsBtn?.classList.remove('spinning');
  };

  try {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (settled) return;
        settled = true;
        finishGps();
        const lat = Number(pos?.coords?.latitude);
        const lon = Number(pos?.coords?.longitude);
        if (!isValidLatLon(lat, lon)) {
          fallbackToSavedHomeLocation('GPS returned invalid coordinates');
          return;
        }
        switchActiveLocation({ id: 'gps_current', name: 'Current Location (GPS)', lat, lon }, { fly: true });
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdogId);
        const code = err?.code;
        const reason = code === 1
          ? 'Location permission denied'
          : code === 2
            ? 'GPS position unavailable'
            : code === 3
              ? 'GPS request timed out'
              : 'GPS unavailable';
        fallbackToSavedHomeLocation(reason);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  } catch {
    if (!settled) {
      settled = true;
      clearTimeout(watchdogId);
      fallbackToSavedHomeLocation('GPS unavailable');
    }
  }
}

function syncRadarOverlays() {
  radarMap.setOverlayData({
    alerts: state.regionalAlerts,
    stormCells: state.stormCells,
    lsrGeoJson: state.iemIntel?.lsrGeoJson,
    mcdGeoJson: state.iemIntel?.mcdGeoJson,
    spcWatchesGeoJson: state.iemIntel?.spcWatchesGeoJson,
    wpcFloodGeoJson: state.iemIntel?.wpcFloodGeoJson,
    wpcWssiGeoJson: state.wssiBundle?.layers?.[state.settings.wssiOverlayLayerId || 4] || state.wssiBundle?.overlayGeoJson,
    spcDay1GeoJson: state.iemIntel?.spcOverlayGeoJson || state.iemIntel?.spcDay1GeoJson,
    spcDay1CatGeoJson: state.iemIntel?.spcDay1GeoJson,
    spcDay1TorGeoJson: state.iemIntel?.spcDay1TorGeoJson,
    spcDay1HailGeoJson: state.iemIntel?.spcDay1HailGeoJson,
    spcDay1WindGeoJson: state.iemIntel?.spcDay1WindGeoJson,
    spcDay2GeoJson: state.iemIntel?.spcDay2GeoJson,
    spcDay3GeoJson: state.iemIntel?.spcDay3GeoJson,
    spcOverlayLayerId: state.settings.spcOverlayLayerId || 1
  });
}

/* ==================== RADAR ==================== */
async function ensureRadarReady() {
  const loc = state.activeLocation || getSavedHomeLocation();
  const { lat, lon } = loc;
  const nearest = findNearestNexradStation(lat, lon);
  if (!state.selectedRadarSite) state.selectedRadarSite = nearest.id;
  const siteLbl = document.getElementById('radar-site-label');
  if (siteLbl) siteLbl.textContent = `Site: ${state.selectedRadarSite}`;

  document.querySelectorAll('#radar-product-chips .radar-chip').forEach((c) => {
    c.classList.toggle('active', c.dataset.product === state.settings.radarProduct);
  });
  document.querySelectorAll('#radar-quick-flip .qflip-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.qflip === state.settings.radarProduct);
  });

  radarMap.init(lat, lon, state.settings.basemap, state.settings.radarOpacity);
  radarMap.setUserLocation(lat, lon);
  radarMap.resize();
  updateRadarStormHud();
  syncRadarOverlays();
  await loadRadarFramesForCurrentProduct();
}

async function selectRadarProduct(productCode) {
  state.settings.radarProduct = productCode;
  saveSettings();
  document.querySelectorAll('#radar-product-chips .radar-chip').forEach((c) => {
    c.classList.toggle('active', c.dataset.product === productCode);
  });
  document.querySelectorAll('#radar-quick-flip .qflip-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.qflip === productCode);
  });
  await loadRadarFramesForCurrentProduct();
}

async function selectSpcOverlayLayer(layerId) {
  state.settings.spcOverlayLayerId = layerId;
  saveSettings();
  document.querySelectorAll('#spc-mode-row .spc-mode-btn').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.spcLayer) === layerId);
  });
  const chk = document.getElementById('layer-spc');
  if (chk && !chk.checked) {
    chk.checked = true;
    radarMap.setLayerVisibility('spc', true);
  }
  try {
    const geo = await fetchSpcOverlayLayer(layerId);
    if (state.iemIntel) state.iemIntel.spcOverlayGeoJson = geo;
    radarMap.setOverlayData({ spcDay1GeoJson: geo, spcOverlayLayerId: layerId });
  } catch {
    // non-fatal when offline
  }
}

async function selectWssiOverlayLayer(layerId) {
  const safeId = Number.isFinite(Number(layerId)) ? Number(layerId) : 4;
  state.settings.wssiOverlayLayerId = safeId;
  saveSettings();
  document.querySelectorAll('#wssi-mode-row .wssi-mode-btn').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.wssiLayer) === safeId);
  });
  const chk = document.getElementById('layer-wssi');
  if (chk && !chk.checked) {
    chk.checked = true;
    radarMap.setLayerVisibility('wssi', true);
  }
  try {
    const cached = !state.wssiBundle?._meta?.allFailed ? state.wssiBundle?.layers?.[safeId] : null;
    const geo = (cached && Array.isArray(cached.features) && cached.features.length > 0)
      ? cached
      : await fetchWpcWssiLayer(safeId);
    const resolvedGeo = (geo?.features?.length || !cached) ? geo : cached;
    state.wssiBundle = {
      ...(state.wssiBundle || { layers: {} }),
      overlayLayerId: safeId,
      overlayGeoJson: resolvedGeo,
      layers: { ...(state.wssiBundle?.layers || {}), [safeId]: resolvedGeo }
    };
    radarMap.setOverlayData({ wpcWssiGeoJson: resolvedGeo });
  } catch {
    // non-fatal when offline
  }
}

async function loadRadarFramesForCurrentProduct() {
  const prod = state.settings.radarProduct || 'CONUS_MOSAIC';
  const loc = state.activeLocation || getSavedHomeLocation();
  const site = state.selectedRadarSite || findNearestNexradStation(loc.lat, loc.lon).id;
  const siteLbl = document.getElementById('radar-site-label');
  if (siteLbl) siteLbl.textContent = `Site: ${site}`;
  const frameTimeEl = document.getElementById('radar-frame-time');
  if ((!radarMap.frames?.length || radarMap.productCode !== prod) && frameTimeEl) {
    frameTimeEl.textContent = 'Loading radar scans...';
  }
  try {
    const frames = await buildRadarFrames(prod, site);
    const nextFrames = Array.isArray(frames) ? frames : [];
    const sameExisting =
      state.radarFrames.length > 0 &&
      state.radarFrames._meta?.productCode === prod &&
      (prod === 'CONUS_MOSAIC' || state.radarFrames._meta?.siteId === site) &&
      !state.radarFrames._meta?.fallback;

    // Never replace genuine prior scan timestamps with a synthetic age=0 fallback frame during an outage
    if (!(nextFrames._meta?.fallback && sameExisting)) {
      state.radarFrames = nextFrames;
      radarMap.setFrames(state.radarFrames, prod);
    }
    updateDataStalenessBanner();
    const playBtn = document.getElementById('btn-radar-play');
    if (playBtn) playBtn.textContent = radarMap.playing ? '⏸' : '▶';
  } catch {
    if (frameTimeEl && !radarMap.frames?.length) {
      frameTimeEl.textContent = 'Radar scans unavailable';
    }
    updateDataStalenessBanner();
  }
}

function formatCountdownLabel(tsRaw, nowMs = Date.now()) {
  const targetMs = parseUtcTimestampMs(tsRaw);
  if (targetMs == null) return null;
  const diffMin = Math.round((targetMs - nowMs) / 60000);
  if (diffMin <= 0) return 'Expiring / Expired';
  if (diffMin < 60) return `${diffMin}m left`;
  const hrs = Math.floor(diffMin / 60);
  const mins = diffMin % 60;
  return mins > 0 ? `${hrs}h ${mins}m left` : `${hrs}h left`;
}

function formatCoordPair(lat, lon) {
  if (!isValidLatLon(Number(lat), Number(lon))) return '--';
  const nLat = Number(lat);
  const nLon = Number(lon);
  return `${Math.abs(nLat).toFixed(3)}°${nLat >= 0 ? 'N' : 'S'}, ${Math.abs(nLon).toFixed(3)}°${nLon >= 0 ? 'E' : 'W'}`;
}

function renderDbzSpectrumBar(maxDbz, maxDbzHeightKft = null) {
  const dbz = Number(maxDbz) || 0;
  const pct = Math.max(4, Math.min(100, Math.round(((dbz - 20) / 50) * 100)));
  const tierLabel = dbz >= 65
    ? 'Extreme Hail / Debris Core'
    : dbz >= 58
      ? 'Severe Convective Core'
      : dbz >= 50
        ? 'Heavy Storm Core'
        : dbz >= 35
          ? 'Moderate Precipitation'
          : 'Light Echo';
  return `
    <div class="inspect-gauge-card">
      <div class="inspect-gauge-head">
        <span>Reflectivity Intensity</span>
        <span class="inspect-mono-val">${dbz > 0 ? `${dbz} dBZ` : '--'}${maxDbzHeightKft ? ` @ ${maxDbzHeightKft} kft` : ''}</span>
      </div>
      <div class="dbz-bar-track">
        <div class="dbz-bar-fill" style="width:${pct}%;"></div>
        <div class="dbz-bar-marker" style="left:${pct}%;"></div>
      </div>
      <div class="inspect-gauge-foot">
        <span>20</span><span>35</span><span>50</span><span>65+ dBZ</span>
      </div>
      <div class="inspect-gauge-caption">${tierLabel}</div>
    </div>
  `;
}

function renderSegmentedRiskBar(levelIdx, maxSteps, activeColor, labelText) {
  const segs = Array.from({ length: maxSteps }, (_, i) => {
    const filled = i < levelIdx;
    return `<span class="risk-seg ${filled ? 'filled' : ''}" style="${filled ? `background:${activeColor};box-shadow:0 0 8px ${activeColor}66;` : ''}"></span>`;
  }).join('');
  return `
    <div class="inspect-gauge-card">
      <div class="inspect-gauge-head">
        <span>Hazard Severity Scale</span>
        <span class="inspect-mono-val" style="color:${activeColor};">${escapeHtml(labelText)}</span>
      </div>
      <div class="risk-seg-track">${segs}</div>
    </div>
  `;
}

function buildSystemSwitcherHtml(activeType, ctx) {
  if (!ctx || !ctx.systems) return '';
  const sys = ctx.systems;
  const pills = [];
  if (sys.alerts?.length) {
    pills.push(`<button type="button" class="inspect-switch-pill ${activeType === 'alert' ? 'active' : ''}" data-switch-sys="alert">Warning (${sys.alerts.length})</button>`);
  }
  if (sys.watches?.length) {
    pills.push(`<button type="button" class="inspect-switch-pill ${activeType === 'watch' ? 'active' : ''}" data-switch-sys="watch">Watch</button>`);
  }
  if (sys.mcds?.length) {
    pills.push(`<button type="button" class="inspect-switch-pill ${activeType === 'mcd' ? 'active' : ''}" data-switch-sys="mcd">MCD</button>`);
  }
  if (sys.floods?.length) {
    pills.push(`<button type="button" class="inspect-switch-pill ${activeType === 'wpc' ? 'active' : ''}" data-switch-sys="wpc">Flood ERO</button>`);
  }
  if (sys.wssiFeatures?.length) {
    pills.push(`<button type="button" class="inspect-switch-pill ${activeType === 'wssi' ? 'active' : ''}" data-switch-sys="wssi">Winter WSSI</button>`);
  }
  if (sys.outlooks?.length) {
    pills.push(`<button type="button" class="inspect-switch-pill ${activeType === 'outlook' ? 'active' : ''}" data-switch-sys="outlook">SPC Outlook</button>`);
  }
  if (sys.nearestCell) {
    pills.push(`<button type="button" class="inspect-switch-pill ${activeType === 'cell' ? 'active' : ''}" data-switch-sys="cell">Cell ${escapeHtml(sys.nearestCell.stormId)}</button>`);
  }
  pills.push(`<button type="button" class="inspect-switch-pill ${activeType === 'point' ? 'active' : ''}" data-switch-sys="point">Point Intel</button>`);
  if (pills.length <= 1) return '';
  return `<div class="inspect-switcher-row" role="tablist" aria-label="Systems at tapped point">${pills.join('')}</div>`;
}

function openInspectSheet(type, item, ctx = null) {
  document.getElementById('radar-layers-sheet')?.classList.add('hidden');
  const sheet = document.getElementById('radar-inspect-sheet');
  const titleEl = document.getElementById('inspect-title');
  const subEl = document.getElementById('inspect-sub');
  const bodyEl = document.getElementById('inspect-body');
  if (!sheet || !titleEl || !bodyEl) return;

  const loc = state.activeLocation || getSavedHomeLocation();
  const switcherHtml = buildSystemSwitcherHtml(type, ctx);
  let toneClass = 'sheet-tone-cyan';
  let subtitle = '';

  if (type === 'cell' && item) {
    const speedKt = Math.round(mphToKt(item.speedMph || 0) ?? 0);
    const scanCentral = item.valid ? formatCentralTime(item.valid) : 'Live NEXRAD';
    const radarConfirmText = item.confirmingRadars?.length > 1
      ? `Multi-radar (${item.confirmingRadars.length}): ${item.confirmingRadars.join(' · ')}`
      : `Single-site NEXRAD: ${item.nexrad}`;
    const guidance = item.tvs
      ? 'IMMEDIATE ACTION: Tornado Vortex Signature detected. Move to an interior ground-floor room away from windows and verify N0G Velocity & N0C Debris.'
      : item.threatLevel === 'SUPERCELL'
        ? 'HIGH ALERT: Deep rotating mesocyclone detected. Monitor Velocity (N0G) & CC Debris (N0C) closely and prepare to shelter if a Tornado Warning issues.'
        : item.threatScore >= 2
          ? 'SEVERE STORM: Damaging winds and/or large hail core possible. Move indoors away from windows and protect vehicles.'
          : 'CONVECTIVE CELL: Monitor intensification, lightning, and rainfall trends along projected track.';

    toneClass = item.tvs ? 'sheet-tone-critical' : item.meso ? 'sheet-tone-supercell' : item.threatScore >= 2 ? 'sheet-tone-severe' : 'sheet-tone-watch';
    titleEl.textContent = `Storm Cell ${item.stormId} (${item.nexrad})`;
    subtitle = `Scan ${scanCentral} • ${fmtFixed(item.intercept?.distanceMi, 1)} mi ${item.intercept?.compassFromUser || '--'}`;

    bodyEl.innerHTML = `
      ${switcherHtml}
      <div class="tag-row" style="margin-top:0;">
        <span class="badge-${item.tvs ? 'red' : item.meso ? 'magenta' : item.threatScore >= 2 ? 'amber' : 'muted'}">${escapeHtml(item.threatLevel.replace('_', ' '))}</span>
        ${item.tvs && String(item.tvs).toUpperCase() !== 'TVS' ? `<span class="badge-red">TVS: ${escapeHtml(item.tvs)}</span>` : ''}
        ${item.meso ? `<span class="badge-magenta">MESO RANK ${escapeHtml(item.meso)}</span>` : ''}
        ${item.maxHailIn > 0 ? `<span class="badge-amber">Hail ${item.maxHailIn}"</span>` : ''}
        ${item.confirmingRadars?.length > 1 ? `<span class="badge-cyan">${item.confirmingRadars.length}x Confirmed</span>` : ''}
      </div>
      ${renderDbzSpectrumBar(item.maxDbz, item.maxDbzHeightKft)}
      <div class="cell-motion-banner">
        <span>${escapeHtml(item.motionSummary || `Moving ${item.moveToCompass} @ ${item.speedMph} mph`)}${item.speedMph >= 3 ? ` (${speedKt} kt)` : ''}</span>
        <span>${fmtFixed(item.intercept?.distanceMi, 1)} mi ${item.intercept?.compassFromUser || '--'}</span>
      </div>
      <div class="cell-proof-grid">
        <div class="cell-proof-item">
          <div class="cell-proof-k">Hail / POH</div>
          <div class="cell-proof-v">${item.maxHailIn > 0 ? `${item.maxHailIn}"` : `${item.poh ?? 0}%`}</div>
        </div>
        <div class="cell-proof-item">
          <div class="cell-proof-k">VIL</div>
          <div class="cell-proof-v">${item.vil ?? 0}</div>
        </div>
        <div class="cell-proof-item">
          <div class="cell-proof-k">Echo Top</div>
          <div class="cell-proof-v">${item.topKft ? `${item.topKft} kft` : '--'}</div>
        </div>
        <div class="cell-proof-item">
          <div class="cell-proof-k">Rotation</div>
          <div class="cell-proof-v">${item.tvs ? 'TVS' : item.meso ? `M${escapeHtml(item.meso)}` : 'None'}</div>
        </div>
      </div>
      <div class="inspect-kv-card">
        <div class="inspect-kv-row">
          <span>Intercept Verdict</span>
          <strong>${escapeHtml(item.intercept?.verdictLabel || '--')}</strong>
        </div>
        <div class="inspect-kv-row">
          <span>Time on Target (TOT)</span>
          <strong>${item.intercept?.etaMinutes != null ? `~${item.intercept.etaMinutes} min (CPA ${fmtFixed(item.intercept?.cpaMiles, 1)} mi)` : 'No direct intercept'}</strong>
        </div>
        <div class="inspect-kv-row">
          <span>Radar Verification</span>
          <strong>${escapeHtml(radarConfirmText)}${item.radarRangeMi ? ` • ${item.radarRangeMi} mi` : ''}</strong>
        </div>
      </div>
      <div class="inspect-guidance ${item.tvs ? 'critical' : item.threatScore >= 2 ? 'severe' : 'info'}">
        ${escapeHtml(guidance)}
      </div>
      <div class="inspect-action-bar">
        <button type="button" class="btn-secondary-sm" data-inspect-fly="${item.lat},${item.lon},9.2">Center Cell</button>
        <button type="button" class="btn-glass-cyan" data-inspect-prod="N0G">Vel N0G</button>
        <button type="button" class="btn-glass-violet" data-inspect-prod="N0C">CC ρhv</button>
      </div>
    `;
  } else if (type === 'lsr' && item) {
    const p = item.properties || {};
    const [lon, lat] = item.coords || [loc.lon, loc.lat];
    const distMi = haversineMiles(loc.lat, loc.lon, lat, lon);
    const brg = degToCompass(initialBearingDeg(loc.lat, loc.lon, lat, lon));
    const evType = p.typetext || p.type || 'Storm Report';
    const mag = p.magnitude ? `${p.magnitude}${p.unit ? ' ' + p.unit : ''}` : null;
    const evUp = String(evType).toUpperCase();
    const isTor = evUp.includes('TORNADO') || evUp.includes('FUNNEL');
    const isHail = evUp.includes('HAIL');
    const isWind = evUp.includes('WIND');
    const isFlood = evUp.includes('FLOOD') || evUp.includes('RAIN');
    const glyph = isTor ? '🌪️' : isHail ? '🧊' : isWind ? '💨' : isFlood ? '🌊' : '⚡';
    const reportedCt = (p.valid || p.utcvalid) ? formatCentralTime(p.valid || p.utcvalid) : 'Recent';

    toneClass = isTor ? 'sheet-tone-critical' : isHail || isWind ? 'sheet-tone-severe' : 'sheet-tone-watch';
    titleEl.textContent = `${evType}${mag ? ` • ${mag}` : ''}`;
    subtitle = `LSR Spotter Report • ${fmtFixed(distMi, 1)} mi ${brg}`;

    bodyEl.innerHTML = `
      ${switcherHtml}
      <div class="lsr-hero-strip">
        <div class="lsr-glyph-badge ${isTor ? 'critical' : 'amber'}" aria-hidden="true">${glyph}</div>
        <div class="lsr-hero-meta">
          <div class="tag-row" style="margin-top:0;">
            <span class="badge-${isTor ? 'red' : 'amber'}">CONFIRMED SPOTTER REPORT</span>
            <span class="badge-cyan">${fmtFixed(distMi, 1)} mi ${brg}</span>
          </div>
          <div class="alert-meta" style="margin-top:4px;">${escapeHtml(p.city || 'Nearby')}${p.county ? ` (${escapeHtml(p.county)} Co.)` : ''}, ${escapeHtml(p.state || p.st || '')}</div>
        </div>
      </div>
      <div class="inspect-kv-card">
        <div class="inspect-kv-row"><span>Reported (CT)</span><strong>${escapeHtml(reportedCt)}</strong></div>
        <div class="inspect-kv-row"><span>Magnitude / Type</span><strong>${escapeHtml(mag || evType)}</strong></div>
        ${p.source ? `<div class="inspect-kv-row"><span>Source</span><strong>${escapeHtml(p.source)}</strong></div>` : ''}
        <div class="inspect-kv-row"><span>Coordinates</span><strong>${formatCoordPair(lat, lon)}</strong></div>
      </div>
      <div class="alert-meta">
        ${escapeHtml(p.remark || 'Verified NWS Local Storm Report.')}
      </div>
      <div class="inspect-action-bar">
        <button type="button" class="btn-secondary-sm" data-inspect-fly="${lat},${lon},9.2">Center Report</button>
        <button type="button" class="btn-glass-cyan" data-inspect-prod="N0B">Refl N0B</button>
      </div>
    `;
  } else if (type === 'watch' && item) {
    const p = item.properties || item;
    const isPds = Boolean(p.is_pds || String(p.pds || '').toUpperCase() === 'Y');
    const watchType = String(p.type || '').toUpperCase();
    const isTor = watchType === 'TOR' || watchType.includes('TORNADO');
    const watchNum = p.num || p.SEL || p.watch_num || '';
    const ctr = item.geometry ? geometryCentroid(item.geometry) : null;
    const insideUser = item.geometry ? isPointInGeometry(loc.lat, loc.lon, item.geometry) : false;
    const rangeTag = ctr
      ? `${fmtFixed(haversineMiles(loc.lat, loc.lon, ctr.lat, ctr.lon), 1)} mi ${degToCompass(initialBearingDeg(loc.lat, loc.lon, ctr.lat, ctr.lon))}`
      : null;
    const issueRaw = p.issue || p.utc_issue || p.issued || p.valid;
    const expireRaw = p.expire || p.utc_expire || p.expired;
    const countdown = formatCountdownLabel(expireRaw);

    toneClass = isPds ? 'sheet-tone-critical' : isTor ? 'sheet-tone-critical' : 'sheet-tone-watch';
    titleEl.textContent = `${isPds ? 'PDS ' : ''}${isTor ? 'Tornado' : 'Severe Thunderstorm'} Watch${watchNum ? ` #${watchNum}` : ''}`;
    subtitle = `SPC Watch Box${countdown ? ` • ${countdown}` : ''}`;

    bodyEl.innerHTML = `
      ${switcherHtml}
      <div class="tag-row" style="margin-top:0;">
        <span class="badge-${isPds ? 'magenta' : isTor ? 'red' : 'amber'}">${isPds ? 'PARTICULARLY DANGEROUS SITUATION' : isTor ? 'TORNADO WATCH' : 'SEVERE T-STORM WATCH'}</span>
        ${insideUser ? '<span class="badge-red">YOU ARE INSIDE WATCH</span>' : rangeTag ? `<span class="badge-cyan">${rangeTag}</span>` : ''}
        ${countdown ? `<span class="badge-muted">${escapeHtml(countdown)}</span>` : ''}
      </div>
      <div class="inspect-kv-card">
        <div class="inspect-kv-row"><span>Issued (CT)</span><strong>${issueRaw ? escapeHtml(formatCentralTime(issueRaw)) : '--'}</strong></div>
        <div class="inspect-kv-row"><span>Expires (CT)</span><strong>${expireRaw ? escapeHtml(formatCentralTime(expireRaw)) : '--'}</strong></div>
        ${p.max_hail ? `<div class="inspect-kv-row"><span>Max Hail Threat</span><strong>${escapeHtml(String(p.max_hail))}"</strong></div>` : ''}
        ${p.max_gust ? `<div class="inspect-kv-row"><span>Max Wind Gust</span><strong>${escapeHtml(String(p.max_gust))} mph</strong></div>` : ''}
        ${p.states ? `<div class="inspect-kv-row"><span>States</span><strong>${escapeHtml(String(p.states))}</strong></div>` : ''}
      </div>
      <div class="inspect-guidance ${isTor ? 'critical' : 'severe'}">
        ${isPds
          ? 'PDS WATCH: Atmospheric conditions are exceptionally favorable for intense, long-track tornadoes and severe supercells. Keep sirens armed and shelter plan ready.'
          : isTor
            ? 'TORNADO WATCH: Conditions are favorable for supercells and tornadoes in and close to the watch area. Stay alert for immediate Warnings.'
            : 'SEVERE THUNDERSTORM WATCH: Conditions are favorable for organized severe storms producing damaging winds and large hail.'}
      </div>
      ${ctr ? `<div class="inspect-action-bar"><button type="button" class="btn-secondary-sm" data-inspect-fly="${ctr.lat},${ctr.lon},7.4">Center Watch Box</button></div>` : ''}
    `;
  } else if (type === 'mcd' && item) {
    const p = item.properties || item;
    const num = p.num || p.id || '';
    const ctr = item.geometry ? geometryCentroid(item.geometry) : null;
    const insideUser = item.geometry ? isPointInGeometry(loc.lat, loc.lon, item.geometry) : false;
    const rangeTag = ctr
      ? `${fmtFixed(haversineMiles(loc.lat, loc.lon, ctr.lat, ctr.lon), 1)} mi ${degToCompass(initialBearingDeg(loc.lat, loc.lon, ctr.lat, ctr.lon))}`
      : null;
    const validRaw = p.valid || p.issue || p.utc_issue;
    const expireRaw = p.expire || p.utc_expire;
    const countdown = formatCountdownLabel(expireRaw);
    const watchProb = p.watch_confidence || p.prob_watch || p.watch_prob || null;

    toneClass = 'sheet-tone-supercell';
    titleEl.textContent = `SPC Mesoscale Discussion${num ? ` #${num}` : ''}`;
    subtitle = `Short-Term Severe Analysis${countdown ? ` • ${countdown}` : ''}`;

    bodyEl.innerHTML = `
      ${switcherHtml}
      <div class="tag-row" style="margin-top:0;">
        <span class="badge-magenta">SPC MCD</span>
        ${watchProb ? `<span class="badge-amber">Watch Prob: ${escapeHtml(String(watchProb))}</span>` : ''}
        ${insideUser ? '<span class="badge-red">INSIDE MCD AREA</span>' : rangeTag ? `<span class="badge-cyan">${rangeTag}</span>` : ''}
      </div>
      <div class="inspect-kv-card">
        <div class="inspect-kv-row"><span>Concerning</span><strong>${escapeHtml(p.concerning || 'Developing Severe Weather')}</strong></div>
        <div class="inspect-kv-row"><span>Valid (CT)</span><strong>${validRaw ? escapeHtml(formatCentralTime(validRaw)) : '--'}</strong></div>
        <div class="inspect-kv-row"><span>Expires (CT)</span><strong>${expireRaw ? escapeHtml(formatCentralTime(expireRaw)) : '--'}${countdown ? ` (${escapeHtml(countdown)})` : ''}</strong></div>
        ${p.areas_affected || p.states ? `<div class="inspect-kv-row"><span>Affected Area</span><strong>${escapeHtml(p.areas_affected || p.states)}</strong></div>` : ''}
        ${p.most_prob_tornado ? `<div class="inspect-kv-row"><span>Most Likely Tornado</span><strong>${escapeHtml(String(p.most_prob_tornado))}</strong></div>` : ''}
        ${p.most_prob_gust ? `<div class="inspect-kv-row"><span>Most Likely Gust</span><strong>${escapeHtml(String(p.most_prob_gust))}</strong></div>` : ''}
      </div>
      <div class="alert-meta">
        ${escapeHtml((p.discussion || p.summary || 'SPC meteorologists are closely monitoring mesoscale convective trends in this corridor for potential watch issuance or intensifying storm hazards.').slice(0, 560))}
      </div>
      ${ctr ? `<div class="inspect-action-bar"><button type="button" class="btn-secondary-sm" data-inspect-fly="${ctr.lat},${ctr.lon},7.5">Center MCD Polygon</button></div>` : ''}
    `;
  } else if (type === 'wpc' && item) {
    const p = item.properties || item;
    const rawLbl = String(p.OUTLOOK || p.LABEL || p.CATEGORY || 'MRGL').trim().toUpperCase();
    const norm = rawLbl.includes('HIGH') ? 'HIGH' : rawLbl.includes('MDT') || rawLbl.includes('MODERATE') ? 'MDT' : rawLbl.includes('SLGT') || rawLbl.includes('SLIGHT') ? 'SLGT' : 'MRGL';
    const meta = WPC_ERO_INFO[norm] || WPC_ERO_INFO.MRGL;
    const ctr = item.geometry ? geometryCentroid(item.geometry) : null;
    const insideUser = item.geometry ? isPointInGeometry(loc.lat, loc.lon, item.geometry) : false;
    const validRaw = p.VALID || p.valid || p.ISSUE_TIME;
    const expireRaw = p.EXPIRE || p.expire || p.END_TIME;

    toneClass = norm === 'HIGH' || norm === 'MDT' ? 'sheet-tone-critical' : 'sheet-tone-blue';
    titleEl.textContent = `WPC Flash Flood ERO — ${norm}`;
    subtitle = `${meta.title} (${meta.scale} • ${meta.pct})`;

    bodyEl.innerHTML = `
      ${switcherHtml}
      <div class="tag-row" style="margin-top:0;">
        <span class="badge-blue">WPC EXCESSIVE RAINFALL (${meta.scale})</span>
        <span class="badge-${norm === 'HIGH' || norm === 'MDT' ? 'red' : 'amber'}">${norm} (${meta.pct})</span>
        ${insideUser ? '<span class="badge-cyan">COVERS YOUR LOCATION</span>' : ''}
      </div>
      ${renderSegmentedRiskBar(meta.rank, 4, meta.color, `${norm} • ${meta.scale}`)}
      ${(validRaw || expireRaw) ? `
        <div class="inspect-kv-card">
          ${validRaw ? `<div class="inspect-kv-row"><span>Valid (CT)</span><strong>${escapeHtml(formatCentralTime(validRaw))}</strong></div>` : ''}
          ${expireRaw ? `<div class="inspect-kv-row"><span>Expires (CT)</span><strong>${escapeHtml(formatCentralTime(expireRaw))}</strong></div>` : ''}
        </div>
      ` : ''}
      <div class="inspect-guidance ${norm === 'HIGH' || norm === 'MDT' ? 'critical' : 'info'}">
        ${escapeHtml(meta.desc)}
      </div>
      ${ctr ? `<div class="inspect-action-bar"><button type="button" class="btn-secondary-sm" data-inspect-fly="${ctr.lat},${ctr.lon},7.2">Center Flood Outlook</button></div>` : ''}
    `;
  } else if (type === 'wssi' && item) {
    const p = item.properties || item;
    const impactStr = String(p.impact ?? p.IMPACT ?? 'WINTER WEATHER AREA').trim();
    const validTime = p.valid_time ?? p.VALID_TIME;
    const issueTime = p.issue_time ?? p.ISSUE_TIME;
    const component = p.component ?? p.COMPONENT;
    const rank = wssiImpactRank(impactStr);
    const meta = wssiMetaForRank(rank);
    const ctr = item.geometry ? geometryCentroid(item.geometry) : null;
    const insideUser = item.geometry ? isPointInGeometry(loc.lat, loc.lon, item.geometry) : false;
    const modeLabel = (WPC_WSSI_MODES.find((m) => m.id === (state.settings.wssiOverlayLayerId || 4)) || WPC_WSSI_MODES[0]).label;

    toneClass = rank >= 4 ? 'sheet-tone-critical' : 'sheet-tone-cyan';
    titleEl.textContent = `WPC Winter Storm Severity — ${meta.label}`;
    subtitle = `Layer: ${modeLabel}${component ? ` • ${component}` : ''}`;

    bodyEl.innerHTML = `
      ${switcherHtml}
      <div class="tag-row" style="margin-top:0;">
        <span class="badge-blue">NOAA WPC WSSI (${escapeHtml(modeLabel)})</span>
        <span class="badge-${rank >= 4 ? 'red' : rank >= 3 ? 'amber' : 'cyan'}">${escapeHtml(impactStr.toUpperCase())}</span>
        ${insideUser ? '<span class="badge-cyan">COVERS YOUR LOCATION</span>' : ''}
      </div>
      ${renderSegmentedRiskBar(Math.max(1, rank), 6, meta.color, `${meta.label} • Rank ${rank}/6`)}
      <div class="inspect-kv-card">
        ${validTime ? `<div class="inspect-kv-row"><span>Valid Window</span><strong>${escapeHtml(String(validTime))}</strong></div>` : ''}
        ${issueTime ? `<div class="inspect-kv-row"><span>Issued</span><strong>${escapeHtml(String(issueTime))}</strong></div>` : ''}
        <div class="inspect-kv-row"><span>Component</span><strong>${escapeHtml(String(component || 'Overall Winter Severity'))}</strong></div>
      </div>
      ${ctr ? `<div class="inspect-action-bar"><button type="button" class="btn-secondary-sm" data-inspect-fly="${ctr.lat},${ctr.lon},6.8">Center WSSI Area</button></div>` : ''}
    `;
  } else if (type === 'outlook' && item) {
    const p = item.properties || item;
    const rawLbl = String(p.LABEL || p.LABEL2 || p.OUTLOOK || '').trim().toUpperCase();
    const layerId = ctx?.spcOverlayLayerId || state.settings.spcOverlayLayerId || 1;
    const layerNameMap = { 1: 'Day 1 Categorical', 3: 'Day 1 Tornado Prob', 5: 'Day 1 Hail Prob', 7: 'Day 1 Wind Prob', 9: 'Day 2 Categorical', 17: 'Day 3 Categorical' };
    const layerTitle = layerNameMap[layerId] || 'Convective Outlook';
    const isProbLayer = layerId === 3 || layerId === 5 || layerId === 7;
    const ptLat = ctx?.lat ?? loc.lat;
    const ptLon = ctx?.lon ?? loc.lon;
    const ptOutlooks = evaluateMultiDayOutlooks(ptLat, ptLon, state.iemIntel);

    let levelColor = outlookColor(rawLbl);
    let badgeText = rawLbl || 'OUTLOOK';
    let riskRank = 1;
    let descText = 'SPC severe thunderstorm outlook corridor. Monitor local forecasts and radar trends.';

    if (isProbLayer || /^\d/.test(rawLbl) || rawLbl === 'SIGN') {
      const n = parseFloat(rawLbl.replace('%', ''));
      const pctNum = Number.isFinite(n) ? (n <= 1 ? Math.round(n * 100) : Math.round(n)) : 0;
      badgeText = rawLbl === 'SIGN' ? 'SIGNIFICANT HATCHED' : `${pctNum}% PROBABILITY`;
      levelColor = rawLbl === 'SIGN' || pctNum >= 30 ? '#ff2948' : pctNum >= 15 ? '#fb8c00' : pctNum >= 5 ? '#fdd835' : '#4caf50';
      riskRank = rawLbl === 'SIGN' ? 5 : pctNum >= 30 ? 4 : pctNum >= 15 ? 3 : pctNum >= 5 ? 2 : 1;
      const hazWord = layerId === 3 ? 'tornado within 25 miles of a point' : layerId === 5 ? '1"+ severe hail within 25 miles of a point' : '58+ mph damaging wind gusts within 25 miles of a point';
      descText = rawLbl === 'SIGN'
        ? `Hatched Significant Severe area: 10%+ probability of violent/significant hazard (EF2+ tornado, 2"+ hail, or 75+ mph wind) within 25 miles.`
        : `SPC estimates a ${pctNum}% probability of ${hazWord} during the outlook period.`;
    } else {
      const catKey = rawLbl.includes('HIGH') ? 'HIGH' : rawLbl.includes('MDT') || rawLbl.includes('MODERATE') ? 'MDT' : rawLbl.includes('ENH') ? 'ENH' : rawLbl.includes('SLGT') || rawLbl.includes('SLIGHT') ? 'SLGT' : rawLbl.includes('MRGL') || rawLbl.includes('MARGINAL') ? 'MRGL' : 'TSTM';
      const cm = SPC_CAT_INFO[catKey] || SPC_CAT_INFO.TSTM;
      levelColor = cm.color;
      badgeText = `${catKey} (${cm.scale})`;
      riskRank = cm.rank;
      descText = cm.desc;
    }

    const validRaw = p.VALID || p.valid || p.ISSUE;
    const expireRaw = p.EXPIRE || p.expire;

    toneClass = riskRank >= 4 ? 'sheet-tone-critical' : riskRank >= 3 ? 'sheet-tone-severe' : 'sheet-tone-watch';
    titleEl.textContent = `SPC ${layerTitle} — ${badgeText}`;
    subtitle = `Storm Prediction Center Outlook`;

    bodyEl.innerHTML = `
      ${switcherHtml}
      <div class="tag-row" style="margin-top:0;">
        <span class="badge-${riskRank >= 4 ? 'red' : riskRank >= 2 ? 'amber' : 'green'}">${escapeHtml(badgeText)}</span>
        <span class="badge-muted">${escapeHtml(layerTitle)}</span>
      </div>
      ${renderSegmentedRiskBar(Math.max(1, riskRank), 5, levelColor, badgeText)}
      <div class="cell-proof-grid">
        <div class="cell-proof-item"><div class="cell-proof-k">Day 1</div><div class="cell-proof-v" style="color:${outlookColor(ptOutlooks.day1Category)};">${escapeHtml(ptOutlooks.day1Category)}</div></div>
        <div class="cell-proof-item"><div class="cell-proof-k">Tor %</div><div class="cell-proof-v">${escapeHtml(ptOutlooks.day1TornadoProb)}</div></div>
        <div class="cell-proof-item"><div class="cell-proof-k">Hail %</div><div class="cell-proof-v">${escapeHtml(ptOutlooks.day1HailProb)}</div></div>
        <div class="cell-proof-item"><div class="cell-proof-k">Wind %</div><div class="cell-proof-v">${escapeHtml(ptOutlooks.day1WindProb)}</div></div>
      </div>
      ${(validRaw || expireRaw) ? `
        <div class="inspect-kv-card">
          ${validRaw ? `<div class="inspect-kv-row"><span>Valid (CT)</span><strong>${escapeHtml(formatCentralTime(validRaw))}</strong></div>` : ''}
          ${expireRaw ? `<div class="inspect-kv-row"><span>Expires (CT)</span><strong>${escapeHtml(formatCentralTime(expireRaw))}</strong></div>` : ''}
          <div class="inspect-kv-row"><span>Day 2 / Day 3</span><strong>${escapeHtml(ptOutlooks.day2Category)} / ${escapeHtml(ptOutlooks.day3Category)}</strong></div>
        </div>
      ` : ''}
      <div class="inspect-guidance ${riskRank >= 4 ? 'critical' : riskRank >= 3 ? 'severe' : 'info'}">
        ${escapeHtml(descText)}
      </div>
    `;
  } else if (type === 'point' && item) {
    const ptLat = Number(item.lat ?? loc.lat);
    const ptLon = Number(item.lon ?? loc.lon);
    const sys = item.systems || {};
    const ptOutlooks = evaluateMultiDayOutlooks(ptLat, ptLon, state.iemIntel);
    const distFromUser = item.distFromUserMi;
    const rangeLabel = distFromUser != null && distFromUser > 0.3
      ? `${fmtFixed(distFromUser, 1)} mi ${item.compassFromUser || '--'} of ${loc.name}`
      : `At ${loc.name}`;
    const site = state.selectedRadarSite || findNearestNexradStation(loc.lat, loc.lon).id;
    const prodMeta = RADAR_PRODUCTS.find((rp) => rp.code === (item.productCode || state.settings.radarProduct)) || RADAR_PRODUCTS[0];
    const frameTimeStr = item.activeFrame?.timestampMs
      ? formatCentralTime(item.activeFrame.timestampMs)
      : (item.activeFrame?.label || 'Live Feed');
    const env = state.environment || {};

    const coveringChips = [];
    for (const a of (sys.alerts || []).slice(0, 3)) {
      coveringChips.push(`<button type="button" class="inspect-sys-chip tone-red" data-switch-sys="alert">⚠ ${escapeHtml(a.event)}</button>`);
    }
    for (const w of (sys.watches || []).slice(0, 2)) {
      const wp = w.properties || {};
      const lbl = `${(wp.is_pds || String(wp.pds || '').toUpperCase() === 'Y') ? 'PDS ' : ''}${String(wp.type || '').toUpperCase() === 'TOR' ? 'Tornado' : 'Severe'} Watch${wp.num ? ' #' + wp.num : ''}`;
      coveringChips.push(`<button type="button" class="inspect-sys-chip tone-amber" data-switch-sys="watch">🛡 ${escapeHtml(lbl)}</button>`);
    }
    for (const m of (sys.mcds || []).slice(0, 2)) {
      coveringChips.push(`<button type="button" class="inspect-sys-chip tone-magenta" data-switch-sys="mcd">📡 SPC MCD #${escapeHtml(m.properties?.num || '')}</button>`);
    }
    if (ptOutlooks.day1Category !== 'NONE') {
      coveringChips.push(`<button type="button" class="inspect-sys-chip tone-cyan" data-switch-sys="outlook">SPC Day 1: ${escapeHtml(ptOutlooks.day1Category)}${ptOutlooks.day1TornadoProb !== 'NONE' ? ` • Tor ${escapeHtml(ptOutlooks.day1TornadoProb)}` : ''}</button>`);
    }
    if (ptOutlooks.wpcDay1FloodRisk !== 'NONE') {
      coveringChips.push(`<button type="button" class="inspect-sys-chip tone-blue" data-switch-sys="wpc">💧 WPC Flood: ${escapeHtml(ptOutlooks.wpcDay1FloodRisk)}</button>`);
    }
    const ptWssi = evaluateWssiAtPoint(ptLat, ptLon, state.wssiBundle);
    if (ptWssi.highestRank > 0) {
      coveringChips.push(`<button type="button" class="inspect-sys-chip tone-cyan" ${sys.wssiFeatures?.length ? 'data-switch-sys="wssi"' : ''}>❄️ WSSI: ${escapeHtml(ptWssi.highestImpact)}</button>`);
    }

    const nc = sys.nearestCell;
    const ncDist = sys.nearestCellDistMi;
    const ncBrg = (nc && isValidLatLon(ptLat, ptLon) && isValidLatLon(nc.lat, nc.lon))
      ? degToCompass(initialBearingDeg(ptLat, ptLon, nc.lat, nc.lon))
      : '--';

    toneClass = (sys.alerts || []).some((a) => a.tier === 'CRITICAL') ? 'sheet-tone-critical' : 'sheet-tone-cyan';
    titleEl.textContent = 'Radar Point Intelligence';
    subtitle = `${formatCoordPair(ptLat, ptLon)} • ${rangeLabel}`;

    bodyEl.innerHTML = `
      ${switcherHtml}
      <div class="inspect-section-label">Active Weather Systems at This Point</div>
      ${coveringChips.length
        ? `<div class="inspect-sys-chips">${coveringChips.join('')}</div>`
        : `<div class="inspect-clear-pill">✓ No Active Warnings, Watches, or MCDs Covering This Point</div>`}

      <div class="inspect-section-label">Nearest Tracked Storm Cell</div>
      ${nc ? `
        <div class="inspect-cell-mini">
          <div>
            <div class="inspect-cell-mini-title">
              <span class="badge-${nc.tvs ? 'red' : nc.meso ? 'magenta' : nc.threatScore >= 2 ? 'amber' : 'muted'}">${escapeHtml(nc.threatLevel.replace('_', ' '))}</span>
              <strong>Cell ${escapeHtml(nc.stormId)} (${escapeHtml(nc.nexrad)})</strong>
            </div>
            <div class="alert-meta" style="margin-top:4px;">
              ${fmtFixed(ncDist, 1)} mi ${ncBrg} • ${nc.maxDbz || '--'} dBZ • ${nc.speedMph >= 3 ? `${nc.moveToCompass} @ ${nc.speedMph} mph` : 'Slow'}${nc.maxHailIn > 0 ? ` • Hail ${nc.maxHailIn}"` : ''}${nc.tvs ? ' • TVS' : ''}
            </div>
          </div>
          <button type="button" class="btn-secondary-sm" data-switch-sys="cell">Inspect</button>
        </div>
      ` : `<div class="alert-meta">No severe convective cells currently tracked within 120 miles.</div>`}

      <div class="inspect-section-label">NEXRAD Feed &amp; Synoptic Environment</div>
      <div class="inspect-kv-card">
        <div class="inspect-kv-row"><span>Active Radar</span><strong>${escapeHtml(site)} • ${escapeHtml(prodMeta.shortLabel)}</strong></div>
        <div class="inspect-kv-row"><span>Frame Time (CT)</span><strong>${escapeHtml(frameTimeStr)}</strong></div>
        <div class="inspect-kv-row"><span>Synoptic Regime</span><strong>${escapeHtml(env.regime || 'Quiet / Stable')}</strong></div>
        <div class="inspect-kv-row"><span>CAPE / CIN • Shear</span><strong>${env.peakCape12h ?? 0} / ${env.cinNow ?? 0} • ${env.bulkShear0to6KmKt ?? 0} kt</strong></div>
        <div class="inspect-kv-row"><span>STP / SCP • 0–1km SRH</span><strong>${fmtFixed(env.stp ?? 0, 1)} / ${fmtFixed(env.scp ?? 0, 1)} • ${env.srh0to1Km ?? 0} m²/s²</strong></div>
        <div class="inspect-kv-row"><span>Bunkers Storm Motion</span><strong>${escapeHtml(env.bunkersCompass || '--')} @ ${env.bunkersSpeedKt ?? 0} kt</strong></div>
      </div>

      <div class="inspect-action-bar">
        <button type="button" class="btn-glass-cyan" data-inspect-prod="N0B">Refl N0B</button>
        <button type="button" class="btn-glass-cyan" data-inspect-prod="N0G">Vel N0G</button>
        <button type="button" class="btn-glass-violet" data-inspect-prod="N0C">CC ρhv</button>
        <button type="button" class="btn-secondary-sm" data-inspect-fly="${ptLat},${ptLon},8.8">Center</button>
      </div>
    `;
  } else if (item) {
    // Default / 'alert': NWS Warning or Advisory
    const ctr = item.geometry ? geometryCentroid(item.geometry) : null;
    const rangeTag = ctr
      ? `${fmtFixed(haversineMiles(loc.lat, loc.lon, ctr.lat, ctr.lon), 1)} mi ${degToCompass(initialBearingDeg(loc.lat, loc.lon, ctr.lat, ctr.lon))}`
      : null;
    const effRaw = item.effectiveMs ?? item.effective ?? item.sentMs ?? item.sent;
    const expRaw = item.expiresMs ?? item.expires ?? item.endsMs ?? item.ends;
    const countdown = formatCountdownLabel(expRaw);

    toneClass = item.tier === 'CRITICAL' ? 'sheet-tone-critical' : item.tier === 'SEVERE' ? 'sheet-tone-severe' : item.tier === 'WINTER' ? 'sheet-tone-blue' : 'sheet-tone-watch';
    titleEl.textContent = item.event || 'NWS Weather Alert';
    subtitle = `${item.senderName || 'NWS'}${countdown ? ` • ${countdown}` : ''}`;

    bodyEl.innerHTML = `
      ${switcherHtml}
      <div class="tag-row" style="margin-top:0;">
        <span class="badge-${item.tier === 'CRITICAL' ? 'red' : item.tier === 'WINTER' ? 'blue' : 'amber'}">${item.isTornadoEmergency ? 'TORNADO EMERGENCY' : item.isPdsOrObserved ? 'OBSERVED / PDS' : escapeHtml(item.tier || 'ALERT')}</span>
        ${item.insidePolygon === true ? '<span class="badge-red">INSIDE POLYGON</span>' : rangeTag ? `<span class="badge-cyan">${rangeTag}</span>` : ''}
        ${item.tornadoDetection ? `<span class="badge-red">Tornado: ${escapeHtml(item.tornadoDetection)}</span>` : ''}
        ${item.tornadoDamageThreat ? `<span class="badge-red">Damage: ${escapeHtml(item.tornadoDamageThreat)}</span>` : ''}
        ${item.thunderstormDamageThreat ? `<span class="badge-red">Threat: ${escapeHtml(item.thunderstormDamageThreat)}</span>` : ''}
        ${item.maxWindGust ? `<span class="badge-amber">Wind: ${escapeHtml(item.maxWindGust)}</span>` : ''}
        ${item.maxHailSize ? `<span class="badge-amber">Hail: ${escapeHtml(item.maxHailSize)}"</span>` : ''}
      </div>
      ${item.stormMotion ? `<div class="cell-motion-banner"><span>${escapeHtml(item.stormMotion.summary)}</span><span>NWS CAP Vector</span></div>` : ''}
      <div class="inspect-kv-card">
        <div class="inspect-kv-row"><span>Issuing WFO</span><strong>${escapeHtml(item.senderName || 'NWS')}</strong></div>
        <div class="inspect-kv-row"><span>Effective (CT)</span><strong>${effRaw ? escapeHtml(formatCentralTime(effRaw)) : '--'}</strong></div>
        <div class="inspect-kv-row"><span>Expires (CT)</span><strong>${expRaw ? escapeHtml(formatCentralTime(expRaw)) : '--'}${countdown ? ` (${escapeHtml(countdown)})` : ''}</strong></div>
        ${item.areaDesc ? `<div class="inspect-kv-row"><span>Counties / Area</span><strong>${escapeHtml(item.areaDesc.slice(0, 140))}</strong></div>` : ''}
      </div>
      ${item.instruction ? `
        <div class="inspect-guidance ${item.tier === 'CRITICAL' ? 'critical' : 'severe'}">
          <strong>Protective Action:</strong> ${escapeHtml(item.instruction.slice(0, 420))}
        </div>
      ` : ''}
      <div class="alert-meta">
        <strong>${escapeHtml(item.headline || '')}</strong>${item.description ? `<br/><br/>${escapeHtml(item.description.slice(0, 520))}` : ''}
      </div>
      <div class="inspect-action-bar">
        ${ctr ? `<button type="button" class="btn-secondary-sm" data-inspect-fly="${ctr.lat},${ctr.lon},8.8">Focus Polygon</button>` : ''}
        <button type="button" class="btn-glass-cyan" data-inspect-prod="N0G">Vel N0G</button>
        <button type="button" class="btn-glass-violet" data-inspect-prod="N0C">CC ρhv</button>
      </div>
    `;
  }

  if (subEl) subEl.textContent = subtitle;
  sheet.classList.remove('sheet-tone-critical', 'sheet-tone-severe', 'sheet-tone-supercell', 'sheet-tone-watch', 'sheet-tone-blue', 'sheet-tone-cyan');
  sheet.classList.add(toneClass);

  // Wire interactive switcher pills & quick-jump buttons inside the inspector sheet
  bodyEl.querySelectorAll('[data-switch-sys]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.switchSys;
      const sys = ctx?.systems;
      if (target === 'point' && ctx) openInspectSheet('point', ctx, ctx);
      else if (target === 'alert' && sys?.alerts?.[0]) openInspectSheet('alert', sys.alerts[0], ctx);
      else if (target === 'watch' && sys?.watches?.[0]) openInspectSheet('watch', sys.watches[0], ctx);
      else if (target === 'mcd' && sys?.mcds?.[0]) openInspectSheet('mcd', sys.mcds[0], ctx);
      else if (target === 'wpc' && sys?.floods?.[0]) openInspectSheet('wpc', sys.floods[0], ctx);
      else if (target === 'wssi' && sys?.wssiFeatures?.[0]) openInspectSheet('wssi', sys.wssiFeatures[0], ctx);
      else if (target === 'outlook' && sys?.outlooks?.[0]) openInspectSheet('outlook', sys.outlooks[0], ctx);
      else if (target === 'cell' && sys?.nearestCell) openInspectSheet('cell', sys.nearestCell, ctx);
    });
  });

  bodyEl.querySelectorAll('[data-inspect-prod]').forEach((btn) => {
    btn.addEventListener('click', () => {
      void selectRadarProduct(btn.dataset.inspectProd);
    });
  });

  bodyEl.querySelectorAll('[data-inspect-fly]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const [fLat, fLon, fZoom] = String(btn.dataset.inspectFly || '').split(',').map(Number);
      if (isValidLatLon(fLat, fLon)) {
        radarMap.flyTo(fLat, fLon, Number.isFinite(fZoom) ? fZoom : 8.8, false);
      }
    });
  });

  sheet.classList.remove('hidden');
}

/* ==================== GRAPHICS & TELEMETRY HELPERS ==================== */
function skyAtmosphereClass(condText, isNight) {
  const s = String(condText || '').toLowerCase();
  if (s.includes('thunder') || s.includes('storm') || s.includes('tornado')) return 'cond-storm';
  if (s.includes('snow') || s.includes('sleet') || s.includes('ice') || s.includes('blizzard') || s.includes('freezing')) return 'cond-winter';
  if (s.includes('rain') || s.includes('shower') || s.includes('drizzle')) return 'cond-rain';
  if (s.includes('overcast') || s.includes('mostly cloudy') || s.includes('fog') || s.includes('haze') || s.includes('mist')) return 'cond-cloud';
  return isNight ? 'cond-night' : 'cond-clear';
}

function renderWeatherGraphicSvg(conditionText, isNight = false, size = 86) {
  const s = String(conditionText || '').toLowerCase();
  const uid = `wg${++_svgUid}`;
  const isStorm = s.includes('thunder') || s.includes('t-storm') || s.includes('storm');
  const isSnow = s.includes('snow') || s.includes('sleet') || s.includes('ice') || s.includes('flur');
  const isRain = !isStorm && (s.includes('rain') || s.includes('shower') || s.includes('drizzle'));
  const isFog = s.includes('fog') || s.includes('mist') || s.includes('haze');
  const isPartly = s.includes('partly') || s.includes('mostly clear') || s.includes('few') || s.includes('scattered') || s.includes('mostly sunny');
  const isOvercast = s.includes('overcast') || s.includes('cloudy');

  const defs = `
    <defs>
      <radialGradient id="${uid}_sunHalo" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#fde68a" stop-opacity="0.46"/>
        <stop offset="52%" stop-color="#f59e0b" stop-opacity="0.16"/>
        <stop offset="100%" stop-color="#f59e0b" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="${uid}_sunCore" cx="34%" cy="30%" r="68%">
        <stop offset="0%" stop-color="#fefce8"/>
        <stop offset="35%" stop-color="#fde047"/>
        <stop offset="76%" stop-color="#f59e0b"/>
        <stop offset="100%" stop-color="#ea580c"/>
      </radialGradient>
      <radialGradient id="${uid}_moonHalo" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#93c5fd" stop-opacity="0.34"/>
        <stop offset="56%" stop-color="#6366f1" stop-opacity="0.12"/>
        <stop offset="100%" stop-color="#6366f1" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="${uid}_moonCore" x1="18%" y1="12%" x2="84%" y2="88%">
        <stop offset="0%" stop-color="#ffffff"/>
        <stop offset="52%" stop-color="#dbeafe"/>
        <stop offset="100%" stop-color="#93c5fd"/>
      </linearGradient>
      <linearGradient id="${uid}_cloudLight" x1="25%" y1="0%" x2="65%" y2="100%">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="0.96"/>
        <stop offset="55%" stop-color="#dbe4f0" stop-opacity="0.92"/>
        <stop offset="100%" stop-color="#94a3b8" stop-opacity="0.88"/>
      </linearGradient>
      <linearGradient id="${uid}_cloudMid" x1="20%" y1="0%" x2="70%" y2="100%">
        <stop offset="0%" stop-color="#cbd5e1" stop-opacity="0.86"/>
        <stop offset="60%" stop-color="#8da2bc" stop-opacity="0.84"/>
        <stop offset="100%" stop-color="#475569" stop-opacity="0.86"/>
      </linearGradient>
      <linearGradient id="${uid}_cloudStorm" x1="22%" y1="0%" x2="74%" y2="100%">
        <stop offset="0%" stop-color="#94a3b8" stop-opacity="0.92"/>
        <stop offset="52%" stop-color="#475569" stop-opacity="0.94"/>
        <stop offset="100%" stop-color="#1e293b" stop-opacity="0.96"/>
      </linearGradient>
      <linearGradient id="${uid}_rain" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="#7dd3fc" stop-opacity="0.2"/>
        <stop offset="55%" stop-color="#38bdf8" stop-opacity="0.95"/>
        <stop offset="100%" stop-color="#e0f2fe" stop-opacity="1"/>
      </linearGradient>
      <linearGradient id="${uid}_bolt" x1="30%" y1="0%" x2="65%" y2="100%">
        <stop offset="0%" stop-color="#fef9c3"/>
        <stop offset="48%" stop-color="#facc15"/>
        <stop offset="100%" stop-color="#f59e0b"/>
      </linearGradient>
      <radialGradient id="${uid}_stormGlow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#fde047" stop-opacity="0.32"/>
        <stop offset="55%" stop-color="#a855f7" stop-opacity="0.14"/>
        <stop offset="100%" stop-color="#a855f7" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="${uid}_mist" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#cbd5e1" stop-opacity="0"/>
        <stop offset="22%" stop-color="#cbd5e1" stop-opacity="0.72"/>
        <stop offset="78%" stop-color="#94a3b8" stop-opacity="0.68"/>
        <stop offset="100%" stop-color="#94a3b8" stop-opacity="0"/>
      </linearGradient>
    </defs>
  `;

  const sunOrb = (cx = 32, cy = 32, r = 13.5, haloR = 29) => `
    <circle cx="${cx}" cy="${cy}" r="${haloR}" fill="url(#${uid}_sunHalo)"/>
    <circle cx="${cx}" cy="${cy}" r="${(r * 1.32).toFixed(1)}" fill="#fbbf24" opacity="0.14"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${uid}_sunCore)"/>
    <ellipse cx="${(cx - r * 0.28).toFixed(1)}" cy="${(cy - r * 0.3).toFixed(1)}" rx="${(r * 0.42).toFixed(1)}" ry="${(r * 0.26).toFixed(1)}" transform="rotate(-28 ${cx} ${cy})" fill="#ffffff" opacity="0.34"/>
  `;

  const moonOrb = (tx = 0, ty = 0, sc = 1) => `
    <g transform="translate(${tx},${ty}) scale(${sc})">
      <circle cx="32" cy="31" r="25" fill="url(#${uid}_moonHalo)"/>
      <path d="M37.4 15.5a15.2 15.2 0 1 0 12.8 20.6A12.2 12.2 0 0 1 37.4 15.5Z" fill="url(#${uid}_moonCore)" stroke="rgba(255,255,255,0.45)" stroke-width="0.6"/>
      <path d="M47 17.2l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" fill="#fef3c7" opacity="0.92"/>
      <circle cx="17.5" cy="21" r="1.15" fill="#bae6fd" opacity="0.75"/>
      <circle cx="49.5" cy="29.5" r="0.9" fill="#e0f2fe" opacity="0.65"/>
    </g>
  `;

  const cloudLayer = (fillUrl, tx = 0, ty = 0, sc = 1, opacity = 1, rim = true) => `
    <g transform="translate(${tx},${ty}) scale(${sc})" opacity="${opacity}">
      <path d="M18.5 44h26.5a9.4 9.4 0 0 0 1.4-18.7A13.4 13.4 0 0 0 21.5 28a8.6 8.6 0 0 0-3 16Z"
        fill="url(#${fillUrl})"
        ${rim ? 'stroke="rgba(255,255,255,0.42)" stroke-width="0.65"' : ''}/>
      ${rim ? '<path d="M22.8 28.4A12.6 12.6 0 0 1 44.5 25.8" fill="none" stroke="rgba(255,255,255,0.58)" stroke-width="0.85" stroke-linecap="round"/>' : ''}
    </g>
  `;

  let body = '';
  if (isStorm) {
    body = `
      <ellipse cx="32" cy="45" rx="18" ry="9" fill="url(#${uid}_stormGlow)"/>
      ${cloudLayer(`${uid}_cloudMid`, 6, -7, 0.78, 0.72, false)}
      ${cloudLayer(`${uid}_cloudStorm`, -1, -3, 1.0, 0.98, true)}
      <line x1="19.5" y1="44.5" x2="16.8" y2="52.5" stroke="url(#${uid}_rain)" stroke-width="1.65" stroke-linecap="round"/>
      <line x1="44.5" y1="44.5" x2="41.8" y2="52.5" stroke="url(#${uid}_rain)" stroke-width="1.65" stroke-linecap="round"/>
      <polygon points="34.2,37.5 27.6,48.6 32.8,48.6 29.6,58.5 39.8,46.0 34.4,46.0" fill="url(#${uid}_bolt)" stroke="rgba(254,249,195,0.75)" stroke-width="0.45" stroke-linejoin="round"/>
    `;
  } else if (isSnow) {
    body = `
      ${cloudLayer(`${uid}_cloudMid`, 6, -7, 0.76, 0.65, false)}
      ${cloudLayer(`${uid}_cloudLight`, -1, -4, 0.98, 0.95, true)}
      <g fill="#e0f2fe">
        <circle cx="22.5" cy="48.5" r="1.8" opacity="0.95"/>
        <circle cx="32.5" cy="52.5" r="2.1" opacity="0.98"/>
        <circle cx="42.5" cy="48.5" r="1.7" opacity="0.9"/>
        <circle cx="27.5" cy="44.5" r="1.25" fill="#ffffff" opacity="0.78"/>
        <circle cx="37.8" cy="44.8" r="1.35" fill="#bae6fd" opacity="0.82"/>
        <circle cx="26.2" cy="55.5" r="1.2" fill="#bae6fd" opacity="0.65"/>
        <circle cx="38.5" cy="55.2" r="1.1" fill="#ffffff" opacity="0.6"/>
      </g>
    `;
  } else if (isRain) {
    body = `
      ${cloudLayer(`${uid}_cloudMid`, 6, -7, 0.78, 0.68, false)}
      ${cloudLayer(`${uid}_cloudLight`, -1, -4, 0.98, 0.92, true)}
      <line x1="21.5" y1="43.5" x2="18.2" y2="53.5" stroke="url(#${uid}_rain)" stroke-width="1.75" stroke-linecap="round"/>
      <line x1="30.5" y1="44.5" x2="27.0" y2="55.8" stroke="url(#${uid}_rain)" stroke-width="1.85" stroke-linecap="round"/>
      <line x1="39.5" y1="43.5" x2="36.2" y2="53.5" stroke="url(#${uid}_rain)" stroke-width="1.75" stroke-linecap="round"/>
      <line x1="46.5" y1="44.0" x2="44.0" y2="51.2" stroke="url(#${uid}_rain)" stroke-width="1.45" stroke-linecap="round" opacity="0.72"/>
    `;
  } else if (isFog) {
    body = `
      ${cloudLayer(`${uid}_cloudMid`, 0, -6, 0.94, 0.86, true)}
      <line x1="12" y1="43.5" x2="52" y2="43.5" stroke="url(#${uid}_mist)" stroke-width="2.2" stroke-linecap="round"/>
      <line x1="16" y1="49" x2="48" y2="49" stroke="url(#${uid}_mist)" stroke-width="2.0" stroke-linecap="round" opacity="0.82"/>
      <line x1="20" y1="54" x2="44" y2="54" stroke="url(#${uid}_mist)" stroke-width="1.8" stroke-linecap="round" opacity="0.58"/>
    `;
  } else if (isPartly) {
    body = isNight
      ? `${moonOrb(9, -6, 0.76)}${cloudLayer(`${uid}_cloudLight`, -3, 4, 0.94, 0.94, true)}`
      : `${sunOrb(40, 22, 10.5, 22)}${cloudLayer(`${uid}_cloudLight`, -3, 4, 0.95, 0.96, true)}`;
  } else if (isOvercast) {
    body = `
      ${cloudLayer(`${uid}_cloudMid`, 7, -6, 0.82, 0.76, false)}
      ${cloudLayer(`${uid}_cloudLight`, -2, 2, 0.98, 0.95, true)}
    `;
  } else {
    body = isNight
      ? moonOrb(0, 0, 1)
      : sunOrb(32, 32, 14, 29);
  }

  return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true">${defs}${body}</svg>`;
}

function renderWindCompassSvg(windDirDeg, size = 24) {
  const deg = windDirDeg != null && !Number.isNaN(Number(windDirDeg)) ? Number(windDirDeg) : 0;
  return `
    <svg viewBox="0 0 40 40" width="${size}" height="${size}" aria-hidden="true" style="flex-shrink:0;">
      <circle cx="20" cy="20" r="17.5" fill="rgba(255,255,255,0.02)" stroke="rgba(255,255,255,0.16)" stroke-width="1.1"/>
      <line x1="20" y1="3" x2="20" y2="6.2" stroke="#7dd3fc" stroke-width="1.3" stroke-linecap="round"/>
      <line x1="20" y1="33.8" x2="20" y2="37" stroke="rgba(255,255,255,0.2)" stroke-width="1" stroke-linecap="round"/>
      <line x1="3" y1="20" x2="6.2" y2="20" stroke="rgba(255,255,255,0.2)" stroke-width="1" stroke-linecap="round"/>
      <line x1="33.8" y1="20" x2="37" y2="20" stroke="rgba(255,255,255,0.2)" stroke-width="1" stroke-linecap="round"/>
      <g transform="rotate(${deg} 20 20)">
        <polygon points="20,8 23.8,20.4 20,17.8 16.2,20.4" fill="#38bdf8"/>
        <polygon points="20,31.5 22.1,20.4 20,22.2 17.9,20.4" fill="rgba(148,163,184,0.38)"/>
      </g>
      <circle cx="20" cy="20" r="1.9" fill="#f8fafc"/>
    </svg>
  `;
}

function renderPressureArcSvg(pressureHpa, trend3h, width = 32, height = 20) {
  const hpa = pressureHpa != null ? Number(pressureHpa) : 1013;
  const pct = Math.max(0.04, Math.min(0.96, (hpa - 980) / 60));
  const angleRad = Math.PI - pct * Math.PI;
  const dx = 24 + 17 * Math.cos(angleRad);
  const dy = 25 - 17 * Math.sin(angleRad);
  const arrow = trend3h > 0.4 ? '▲' : trend3h < -0.4 ? '▼' : '—';
  const arrowCol = trend3h > 0.4 ? '#34d399' : trend3h < -0.4 ? '#fb7185' : '#94a3b8';
  const uid = `pa${++_svgUid}`;
  return `
    <svg viewBox="0 0 48 30" width="${width}" height="${height}" aria-hidden="true" style="flex-shrink:0;">
      <defs>
        <linearGradient id="${uid}_g" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.55"/>
          <stop offset="60%" stop-color="#7dd3fc"/>
          <stop offset="100%" stop-color="#e0f2fe"/>
        </linearGradient>
      </defs>
      <path d="M 7 25 A 17 17 0 0 1 41 25" fill="none" stroke="rgba(255,255,255,0.13)" stroke-width="2.8" stroke-linecap="round"/>
      <path d="M 7 25 A 17 17 0 0 1 ${dx.toFixed(1)} ${dy.toFixed(1)}" fill="none" stroke="url(#${uid}_g)" stroke-width="2.8" stroke-linecap="round"/>
      <circle cx="${dx.toFixed(1)}" cy="${dy.toFixed(1)}" r="2.9" fill="#f8fafc" stroke="#0b1324" stroke-width="1"/>
      <text x="24" y="25.5" text-anchor="middle" fill="${arrowCol}" font-size="7.5" font-weight="700">${arrow}</text>
    </svg>
  `;
}

function sectionIcon(name, tone = '') {
  const icons = {
    sounding: `<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/>`,
    spc: `<path d="M12 2 4 5v6c0 5.2 3.4 10 8 11 4.6-1 8-5.8 8-11V5l-8-3z"/>`,
    afd: `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>`,
    winter: `<line x1="12" y1="2" x2="12" y2="22"/><line x1="4.9" y1="6.5" x2="19.1" y2="17.5"/><line x1="19.1" y1="6.5" x2="4.9" y2="17.5"/>`,
    hourly: `<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>`,
    daily: `<rect x="3" y="4" width="18" height="18" rx="3"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>`,
    ota: `<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/>`,
    shield: `<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>`,
    sim: `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>`,
    phone: `<rect x="5" y="2" width="14" height="20" rx="2.5"/><line x1="12" y1="18" x2="12.01" y2="18"/>`
  };
  return `<span class="section-icon ${tone}"><svg viewBox="0 0 24 24" width="13.5" height="13.5" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round">${icons[name] || ''}</svg></span>`;
}

function severityMeter(pct, color) {
  const clamped = Math.max(4, Math.min(100, Math.round(Number.isFinite(pct) ? pct : 0)));
  return `<div class="metric-meter"><div class="metric-meter-fill" style="width:${clamped}%;background:${color};"></div></div>`;
}

function wssiPillColor(label) {
  const s = String(label || 'NONE').toUpperCase();
  if (s.includes('EXTREME')) return '#d946ef';
  if (s.includes('MAJOR')) return '#ef4444';
  if (s.includes('MODERATE')) return '#f97316';
  if (s.includes('MINOR')) return '#facc15';
  if (s.includes('LIMITED')) return '#60a5fa';
  if (s.includes('WINTER')) return '#38bdf8';
  return '#64748b';
}

function renderProWinterCardHtml(win) {
  const safeWin = win || {
    hazardLevel: 'CLEAR',
    statusLabel: 'Clear / Above Freezing',
    roadBridgeRiskLabel: 'Dry / Safe Road Surfaces',
    ground0cmF: null,
    ground6cmF: null,
    freezingLevelFt: null,
    hoursBelowFreezingNext24h: 0,
    minTemp24h: null
  };
  const pw = safeWin.proWinter;
  if (!pw) {
    return `
      <div class="card">
        <div class="card-header">
          <div class="card-title">${sectionIcon('winter', 'blue')}Winter, Ground Temp &amp; Fog Suite</div>
          <span class="badge-${safeWin.hazardLevel === 'CRITICAL' ? 'red' : safeWin.hazardLevel === 'CLEAR' ? 'green' : 'blue'}">${escapeHtml(safeWin.statusLabel)}</span>
        </div>
        <div class="regime-banner ${safeWin.hazardLevel === 'CRITICAL' ? 'high' : safeWin.hazardLevel === 'CLEAR' ? 'low' : 'winter'}">
          <strong>Road / Bridge Surface:</strong> ${escapeHtml(safeWin.roadBridgeRiskLabel)}
        </div>
        <div class="metrics-grid cols-2">
          <div class="metric-box">
            <div class="metric-label">Ground Temp (0cm / 6cm)</div>
            <div class="metric-value">${safeWin.ground0cmF ?? '--'}°F / ${safeWin.ground6cmF ?? '--'}°F</div>
            <div class="metric-sub">Freeze trigger ≤ ${state.settings.groundFreezeThresholdF}°F</div>
          </div>
          <div class="metric-box">
            <div class="metric-label">Freezing Level / 24h Low</div>
            <div class="metric-value">${safeWin.freezingLevelFt != null ? `${safeWin.freezingLevelFt.toLocaleString()} ft` : '--'}</div>
            <div class="metric-sub">${safeWin.hoursBelowFreezingNext24h ?? 0}h ≤ 32°F • Low ${safeWin.minTemp24h ?? '--'}°F</div>
          </div>
        </div>
      </div>
    `;
  }

  const tp = pw.thermalProfile || {};
  const wssi = pw.wssi || {};
  const spread = pw.modelSpread || { estimates: [], agreementLabel: 'N/A' };
  const slots = Array.isArray(pw.hourlySlots) ? pw.hourlySlots : [];
  const segs24 = [];
  for (let i = 0; i < 24; i++) {
    const sA = slots[i * 2];
    const sB = slots[i * 2 + 1];
    const rankA = PTYPE_SEVERITY_ORDER[sA?.pType] || 0;
    const rankB = PTYPE_SEVERITY_ORDER[sB?.pType] || 0;
    const s = rankB > rankA ? sB : (sA || sB);
    const col = s?.pTypeColor || '#334155';
    const title = s ? `${s.hourLabel}: ${s.pTypeLabel} (${s.airTempF}°F)` : 'No data';
    segs24.push(`<div class="ptype-seg" style="background:${col};" title="${escapeHtml(title)}"></div>`);
  }
  const ice72Val = Number.isFinite(Number(pw.ice72hIn)) ? Number(pw.ice72hIn) : 0;
  const icePct = Math.min(100, Math.round((Math.max(0, ice72Val) / 0.5) * 100));
  const badgeTone = safeWin.hazardLevel === 'CRITICAL' || pw.iceRiskTier === 'CATASTROPHIC' || pw.iceRiskTier === 'HIGH'
    ? 'red'
    : safeWin.hazardLevel === 'HIGH' || pw.iceRiskTier === 'MODERATE'
      ? 'amber'
      : safeWin.hazardLevel === 'CLEAR'
        ? 'green'
        : 'blue';

  const tVal = (v) => (v != null && Number.isFinite(Number(v)) ? `${Math.round(Number(v))}°F` : '--');
  const wssiItems = [
    { layer: 1, key: 'Day 1', val: wssi.day1 || 'NONE' },
    { layer: 2, key: 'Day 2', val: wssi.day2 || 'NONE' },
    { layer: 3, key: 'Day 3', val: wssi.day3 || 'NONE' },
    { layer: 4, key: 'Overall', val: wssi.overall || 'NONE' },
    { layer: 19, key: 'Ice', val: wssi.iceComponent || 'NONE' },
    { layer: 9, key: 'Snow', val: wssi.snowComponent || 'NONE' }
  ];

  const isWarmGroundMelts = pw.groundAccumStatus === 'WARM_GROUND_MELTS';
  const isGrassSlushOnly = pw.groundAccumStatus === 'GRASS_SLUSH_ONLY';
  const isMarginalSlushy = pw.groundAccumStatus === 'MARGINAL_SLUSHY';
  const aloftSnowIn = Number(pw.snow72hIn || 0) > 0 ? Number(pw.snow72hIn) : Number(spread.snowMaxIn || 0);
  const roadSnowIn = Number(pw.roadSnow72hIn ?? 0);
  const grassSnowIn = Number(pw.grassSnow72hIn ?? roadSnowIn);
  const hasWarmFlux = isWarmGroundMelts && aloftSnowIn > 0;
  const nwsSnowTag = pw.hasNwsGrid ? ` • NWS: ${fmtFixed(Number(pw.nwsSnow72hIn ?? 0), 1, '0.0')}"` : '';
  const snowHeroHtml = hasWarmFlux
    ? `0.0"<span class="winter-hero-tag">Roads &amp; Grass</span>`
    : isGrassSlushOnly
      ? `0.0"<span class="winter-hero-tag">Roads · ~${fmtFixed(grassSnowIn, 1, '0.0')}" Grass</span>`
      : isMarginalSlushy && aloftSnowIn > 0
        ? `${fmtFixed(roadSnowIn, 1, '0.0')}"<span class="winter-hero-tag">Roads · ${fmtFixed(grassSnowIn, 1, '0.0')}" Grass</span>`
        : `${fmtFixed(roadSnowIn > 0 ? roadSnowIn : Number(pw.snow72hIn ?? 0), 1, '0.0')}"`;
  const groundMeltsTemp = Math.round(pw.minSoil0cmWintryF ?? safeWin.ground0cmF ?? 45);
  const twMeltsStr = pw.minWetBulbWintryF != null ? ` (Tw ${Math.round(Number(pw.minWetBulbWintryF))}°F)` : '';
  const snowSubText = hasWarmFlux
    ? `${fmtFixed(aloftSnowIn, 1, '0.0')}" falling aloft • Melts on ${groundMeltsTemp}°F ground${twMeltsStr}${nwsSnowTag}`
    : isGrassSlushOnly
      ? `${fmtFixed(aloftSnowIn, 1, '0.0')}" falling aloft • Wet roads, slushy grass/decks${nwsSnowTag}`
      : isMarginalSlushy && aloftSnowIn > 0
        ? `${fmtFixed(aloftSnowIn, 1, '0.0')}" aloft • Slushy on ${groundMeltsTemp}°F ground${nwsSnowTag}`
        : `24h: ${fmtFixed(Number(pw.roadSnow24hIn ?? pw.snow24hIn ?? 0), 1, '0.0')}" • Depth: ${fmtFixed(Number(pw.maxSnowDepthIn ?? 0), 1, '0.0')}"${nwsSnowTag || ` • NWS: ${fmtFixed(Number(pw.nwsSnow72hIn ?? 0), 1, '0.0')}"`}`;
  const showAccumBannerNote = Boolean(
    pw.groundAccumNote &&
    safeWin.hazardLevel !== 'CRITICAL' &&
    (isWarmGroundMelts || isGrassSlushOnly || isMarginalSlushy || safeWin.hazardLevel === 'CLEAR') &&
    pw.groundAccumStatus !== 'NO_WINTRY_PRECIP'
  );
  const regimeBannerText = showAccumBannerNote ? pw.groundAccumNote : safeWin.roadBridgeRiskLabel;

  return `
    <div class="card pro-winter-card" id="pro-winter-card">
      <div class="card-header">
        <div class="card-title">${sectionIcon('winter', 'blue')}Pro Winter, Ice &amp; WSSI Suite</div>
        <span class="badge-${badgeTone}">${escapeHtml(pw.headline || safeWin.statusLabel)}</span>
      </div>
      <div class="regime-banner ${safeWin.hazardLevel === 'CRITICAL' ? 'high' : safeWin.hazardLevel === 'CLEAR' ? 'low' : 'winter'}">
        <strong>Road / Bridge Surface:</strong> ${escapeHtml(regimeBannerText)}
      </div>

      <div class="winter-hero-grid">
        <div class="winter-hero-tile">
          <div class="metric-label">72h Snow Est. (${escapeHtml(pw.slrLabel || '10:1')})</div>
          <div class="winter-hero-num" style="color:#e0f2fe;">${snowHeroHtml}</div>
          <div class="metric-sub">${escapeHtml(snowSubText)}</div>
        </div>
        <div class="winter-hero-tile">
          <div class="metric-label">72h Glaze Ice (${escapeHtml(pw.iceRiskTier || 'NONE')})</div>
          <div class="winter-hero-num" style="color:${pw.iceRiskColor || '#64748b'};">${fmtFixed(ice72Val, 2, '0.00')}"</div>
          <div class="metric-sub">${escapeHtml(pw.iceRiskDetail || 'No measurable glaze')}</div>
          ${severityMeter(icePct, pw.iceRiskColor || '#38bdf8')}
        </div>
      </div>

      <div class="winter-subsection-label">
        <span>5-Level Thermal Column &amp; Warm Nose</span>
        ${tp.hasWarmNose ? `<span class="warm-nose-pill">WARM NOSE ALOFT ${tVal(tp.warmNosePeakF)}</span>` : `<span class="metric-sub">Frz Lvl ${tp.freezingLevelFt != null && Number.isFinite(Number(tp.freezingLevelFt)) ? `${Number(tp.freezingLevelFt).toLocaleString()} ft` : '--'}</span>`}
      </div>
      <div class="thermal-column-grid">
        <div class="thermal-cell">
          <div class="thermal-lvl">2m Air</div>
          <div class="thermal-val">${tVal(tp.airTempF)}</div>
        </div>
        <div class="thermal-cell">
          <div class="thermal-lvl">Wet-Bulb Tw</div>
          <div class="thermal-val">${tVal(tp.wetBulbF)}</div>
        </div>
        <div class="thermal-cell ${tp.hasWarmNose && tp.temp925F != null && Number(tp.temp925F) > 33 ? 'warm-nose' : ''}">
          <div class="thermal-lvl">925 hPa</div>
          <div class="thermal-val">${tVal(tp.temp925F)}</div>
        </div>
        <div class="thermal-cell ${tp.hasWarmNose && tp.temp850F != null && Number(tp.temp850F) > 33 ? 'warm-nose' : ''}">
          <div class="thermal-lvl">850 hPa</div>
          <div class="thermal-val">${tVal(tp.temp850F)}</div>
        </div>
        <div class="thermal-cell">
          <div class="thermal-lvl">0cm / 6cm</div>
          <div class="thermal-val">${safeWin.ground0cmF ?? '--'}° / ${safeWin.ground6cmF ?? '--'}°</div>
        </div>
      </div>

      <div class="winter-subsection-label">
        <span>48h P-Type &amp; Refreeze Timeline</span>
        <span class="metric-sub">${pw.hoursSubFreeze72h ?? 0}h ≤32°F • Min ${pw.minTemp72hF ?? '--'}°F (WC ${pw.minWindChill72hF ?? '--'}°F)</span>
      </div>
      <div class="ptype-strip" aria-label="48 hour precipitation type timeline">
        ${segs24.join('')}
      </div>
      <div class="winter-timeline-legend">
        <span class="winter-timeline-dot"><i class="winter-timeline-swatch" style="background:#e0f2fe"></i>Snow</span>
        <span class="winter-timeline-dot"><i class="winter-timeline-swatch" style="background:#a78bfa"></i>Sleet</span>
        <span class="winter-timeline-dot"><i class="winter-timeline-swatch" style="background:#f472b6"></i>Fz Rain</span>
        <span class="winter-timeline-dot"><i class="winter-timeline-swatch" style="background:#22d3ee"></i>Mix</span>
        <span class="winter-timeline-dot"><i class="winter-timeline-swatch" style="background:#818cf8"></i>Refreeze</span>
      </div>

      <div class="winter-milestones-grid">
        <div class="winter-milestone-item">
          <div class="winter-milestone-k">Changeover</div>
          <div class="winter-milestone-v">${escapeHtml(pw.changeoverLabel || '--')}</div>
        </div>
        <div class="winter-milestone-item">
          <div class="winter-milestone-k">Peak 6h Window</div>
          <div class="winter-milestone-v">${escapeHtml(pw.peakWindowLabel || '--')}</div>
        </div>
        <div class="winter-milestone-item">
          <div class="winter-milestone-k">Black-Ice Refreeze</div>
          <div class="winter-milestone-v">${escapeHtml(pw.refreezeLabel || '--')}</div>
        </div>
        <div class="winter-milestone-item">
          <div class="winter-milestone-k">Thaw-Out (&ge;34°F)</div>
          <div class="winter-milestone-v">${escapeHtml(pw.thawLabel || '--')}</div>
        </div>
      </div>

      <div class="winter-subsection-label">
        <span>NOAA WPC WSSI Days 1–3 (Tap to Map)</span>
        <span class="metric-sub" style="color:${wssi.highestColor || '#64748b'};font-weight:700;">Peak: ${escapeHtml(wssi.highestImpact || 'NONE')}</span>
      </div>
      <div class="wssi-pills-grid">
        ${wssiItems.map((it) => `
          <button type="button" class="wssi-pill-btn" data-jump-wssi="${it.layer}">
            <span class="wssi-pill-k">${escapeHtml(it.key)}</span>
            <span class="wssi-pill-v" style="color:${wssiPillColor(it.val)};">${escapeHtml(it.val)}</span>
          </button>
        `).join('')}
      </div>

      <div class="winter-subsection-label">
        <span>3-Model + NWS Ensemble Spread</span>
        <span class="badge-${spread.agreementLabel === 'HIGH' ? 'green' : spread.agreementLabel === 'MODERATE' ? 'amber' : 'muted'}">Agreement: ${escapeHtml(spread.agreementLabel || 'N/A')} (${spread.tempSpreadF ?? 0}°F)</span>
      </div>
      ${(isWarmGroundMelts || isGrassSlushOnly) && Number(spread.snowMaxIn || 0) > 0 ? `<div class="metric-sub winter-spread-note">Model column shows raw falling snow aloft (NWS reflects actual expected sticking snow)</div>` : ''}
      ${spread.estimates?.length ? `
        <div class="model-spread-grid">
          ${spread.estimates.map((m) => `
            <div class="model-spread-cell">
              <div class="winter-milestone-k">${escapeHtml(m.modelName)}</div>
              <div class="winter-milestone-v">${fmtFixed(Number(m.snow72hIn), 1, '0.0')}" sn • ${fmtFixed(Number(m.ice72hIn), 2, '0.00')}" ice</div>
              <div class="metric-sub">Min ${Number.isFinite(Number(m.minTemp72hF)) ? `${Math.round(Number(m.minTemp72hF))}°F` : '--'}</div>
            </div>
          `).join('')}
        </div>
      ` : `<div class="metric-sub">HRRR / GFS / ECMWF comparison syncing...</div>`}
    </div>
  `;
}

/* ==================== RENDER: DASHBOARD ==================== */
function renderDashboard() {
  const container = document.getElementById('dashboard-content');
  const strip = document.getElementById('dashboard-alert-strip');
  updateDataStalenessBanner();
  if (!container || !state.current) return;

  const c = state.current;
  const env = state.environment || analyzeEnvironment(state.openMeteo, c, 0, { multiDaySpc: state.multiDaySpc });
  const win = state.winter || analyzeWinterSuite(
    state.openMeteo,
    c,
    state.settings.groundFreezeThresholdF,
    Date.now(),
    {
      gridData: state.nwsBundle?.gridData || null,
      winterModels: state.winterModels,
      wssiBundle: state.wssiBundle,
      lat: state.activeLocation?.lat,
      lon: state.activeLocation?.lon
    }
  );

  const topAlert = state.localAlerts[0];
  const topThreatCell = state.stormCells.find((sc) => sc.threatScore >= 2 && (sc.intercept.verdict === 'DIRECT_INTERCEPT' || sc.tvs));

  if (strip && topAlert) {
    strip.className = `alert-strip ${topAlert.tier === 'CRITICAL' ? 'critical' : topAlert.tier === 'WINTER' ? 'winter' : 'severe'}`;
    const label = topAlert.isTornadoEmergency
      ? 'TORNADO EMERGENCY'
      : topAlert.insidePolygon === true
        ? `INSIDE ${topAlert.tier} POLYGON`
        : `ACTIVE NWS ${topAlert.tier}`;
    strip.innerHTML = `
      <div>
        <div style="font-size:11px;font-weight:800;letter-spacing:.06em;opacity:.92;">${escapeHtml(label)}</div>
        <div style="font-size:15px;font-weight:800;margin-top:2px;">${escapeHtml(topAlert.event)}</div>
        <div style="font-size:12px;opacity:.88;margin-top:2px;">${state.localAlerts.length} active local alert${state.localAlerts.length > 1 ? 's' : ''} — tap to inspect</div>
      </div>
      <span style="font-size:18px;font-weight:800;">›</span>
    `;
    strip.onclick = () => switchTab('alerts');
  } else if (strip && topThreatCell) {
    strip.className = 'alert-strip critical';
    strip.innerHTML = `
      <div>
        <div style="font-size:11px;font-weight:800;letter-spacing:.06em;">STORM CELL INTERCEPT • ${escapeHtml(topThreatCell.threatLevel.replace('_', ' '))}</div>
        <div style="font-size:15px;font-weight:800;margin-top:2px;">Cell ${escapeHtml(topThreatCell.stormId)} • ${topThreatCell.intercept.etaMinutes != null ? `TOT ~${topThreatCell.intercept.etaMinutes} min` : topThreatCell.intercept.verdictLabel}</div>
        <div style="font-size:12px;opacity:.9;margin-top:2px;">${fmtFixed(topThreatCell.intercept.distanceMi, 1)} mi ${topThreatCell.intercept.compassFromUser} • ${escapeHtml(topThreatCell.motionSummary)}</div>
      </div>
      <span style="font-size:18px;font-weight:800;">›</span>
    `;
    strip.onclick = () => {
      switchTab('radar');
      radarMap.flyTo(topThreatCell.lat, topThreatCell.lon, 9.2, false);
    };
  } else if (strip) {
    strip.className = 'alert-strip hidden';
  }

  const hourlyItems = buildHourlyItems();
  const dailyItems = (state.nwsBundle?.forecastPeriods || []).slice(0, 10);
  const dailyTemps = dailyItems.map((p) => Number(p.temperature)).filter((t) => Number.isFinite(t));
  const dailyMinT = dailyTemps.length ? Math.min(...dailyTemps) : 30;
  const dailySpan = Math.max(12, (dailyTemps.length ? Math.max(...dailyTemps) : 80) - dailyMinT);

  const pTrendSign = c.pressureTrend3h > 0 ? '+' : '';
  const nearestRadar = findNearestNexradStation(state.activeLocation.lat, state.activeLocation.lon);
  const firstHourDay = state.nwsBundle?.hourlyPeriods?.[0]?.isDaytime;
  const hrNow = getCentralHour24(Date.now()) ?? new Date().getUTCHours();
  const isNightNow = firstHourDay != null ? !firstHourDay : (hrNow < 6 || hrNow >= 18);
  const atmClass = skyAtmosphereClass(c.conditionText, isNightNow);

  container.innerHTML = `
    <!-- HERO CURRENT CONDITIONS -->
    <div class="card hero-card ${atmClass}">
      <div class="hero-top">
        <div class="hero-temp-wrap">
          <div class="hero-temp">${c.tempF != null ? `${c.tempF}<span class="hero-deg">°</span>` : '--'}</div>
          <div class="hero-cond">${escapeHtml(c.conditionText)}</div>
          <div class="hero-feels">Feels like ${c.feelsLikeF ?? '--'}° · Dewpoint ${c.dewpointF ?? '--'}°F</div>
        </div>
        <div class="hero-right">
          <div class="hero-graphic-stage">
            ${renderWeatherGraphicSvg(c.conditionText, isNightNow, 88)}
          </div>
        </div>
      </div>

      <div class="hero-status-strip">
        <span class="hero-meta-chip accent">${c.confidence} Consensus</span>
        <span class="hero-meta-chip">±${c.spreadF}°F spread</span>
        <span class="hero-meta-chip">${nearestRadar.id} · ${nearestRadar.distanceMi.toFixed(0)} mi</span>
      </div>

      <div class="hero-telemetry-strip">
        <div class="hero-telem-cell">
          <div class="metric-head-row">
            <span class="metric-label">Wind</span>
            ${renderWindCompassSvg(c.windDirDeg, 22)}
          </div>
          <div class="metric-value">${c.windCompass} ${c.windMph} mph</div>
          <div class="metric-sub">${c.gustMph ? `Gusts ${c.gustMph} mph` : 'Steady flow'}</div>
        </div>
        <div class="hero-telem-cell">
          <div class="metric-head-row">
            <span class="metric-label">Humidity</span>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="rgba(56,189,248,0.18)" stroke="#7dd3fc" stroke-width="1.75" aria-hidden="true"><path d="M12 2.7C12 2.7 6 9.8 6 14.3a6 6 0 0 0 12 0C18 9.8 12 2.7 12 2.7z"/></svg>
          </div>
          <div class="metric-value">${c.humidity ?? '--'}%</div>
          <div class="metric-sub">Td ${c.dewpointF ?? '--'}° · ${c.visibilityMi} mi</div>
          ${severityMeter(c.humidity ?? 0, '#38bdf8')}
        </div>
        <div class="hero-telem-cell">
          <div class="metric-head-row">
            <span class="metric-label">Pressure</span>
            ${renderPressureArcSvg(c.pressureHpa, c.pressureTrend3h, 30, 19)}
          </div>
          <div class="metric-value">${c.pressureInHg}"</div>
          <div class="metric-sub">${pTrendSign}${c.pressureTrend3h} hPa/3h</div>
        </div>
      </div>

      <div class="consensus-meta">
        <span>${escapeHtml(c.sourceLabel)}</span>
        <span>${c.pressureHpa ? `${c.pressureHpa} hPa` : ''}</span>
      </div>
    </div>

    <!-- CONVECTIVE & SUPERCELL ENVIRONMENT (PRO 5-LEVEL SOUNDING + STP/SCP/SHIP/QLCS + LIVE HODOGRAPH) -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">${sectionIcon('sounding', env.level === 'high' ? 'amber' : '')}Pro Severe Sounding &amp; HSLC</div>
        <span class="badge-${env.level === 'high' ? 'red' : env.level === 'mod' ? 'amber' : 'green'}">${escapeHtml(env.regime)}</span>
      </div>
      <div class="regime-banner ${env.level}">
        ${escapeHtml(env.nocturnalRisk)}
      </div>
      <div class="severe-hazards-strip">
        <div class="hazard-chip" style="border-color:${env.hazards?.tornado?.color || '#64748b'}44;">
          <span class="hazard-k">TORNADO</span>
          <span class="hazard-v" style="color:${env.hazards?.tornado?.color || '#94a3b8'};">${escapeHtml(env.hazards?.tornado?.label || 'None')}</span>
          <span class="hazard-d">${escapeHtml(env.hazards?.tornado?.detail || 'Low risk')}</span>
        </div>
        <div class="hazard-chip" style="border-color:${env.hazards?.hail?.color || '#64748b'}44;">
          <span class="hazard-k">LARGE HAIL</span>
          <span class="hazard-v" style="color:${env.hazards?.hail?.color || '#94a3b8'};">${escapeHtml(env.hazards?.hail?.label || 'None')}</span>
          <span class="hazard-d">${escapeHtml(env.hazards?.hail?.detail || 'Low risk')}</span>
        </div>
        <div class="hazard-chip" style="border-color:${env.hazards?.wind?.color || '#64748b'}44;">
          <span class="hazard-k">DMG WIND</span>
          <span class="hazard-v" style="color:${env.hazards?.wind?.color || '#94a3b8'};">${escapeHtml(env.hazards?.wind?.label || 'None')}</span>
          <span class="hazard-d">${escapeHtml(env.hazards?.wind?.detail || 'Low risk')}</span>
        </div>
      </div>
      <div class="metrics-grid">
        <div class="metric-box">
          <div class="metric-label">Sig Tor · STP</div>
          <div class="metric-value">${(env.peakStp12h ?? env.stp ?? 0).toFixed(1)}</div>
          <div class="metric-sub">Now ${(env.stp ?? 0).toFixed(1)} · 12h Peak</div>
          ${severityMeter((((env.peakStp12h ?? env.stp ?? 0)) / 3) * 100, (env.peakStp12h ?? env.stp ?? 0) >= 1 ? '#f43f5e' : '#10b981')}
        </div>
        <div class="metric-box">
          <div class="metric-label">Supercell · SCP</div>
          <div class="metric-value">${(env.peakScp12h ?? env.scp ?? 0).toFixed(1)}</div>
          <div class="metric-sub">0–3km SRH ${env.peakSrh0to3_12h ?? env.srh0to3Km ?? 0}</div>
          ${severityMeter((((env.peakScp12h ?? env.scp ?? 0)) / 5) * 100, (env.peakScp12h ?? env.scp ?? 0) >= 1 ? '#d946ef' : '#38bdf8')}
        </div>
        <div class="metric-box">
          <div class="metric-label">Sig Hail · SHIP</div>
          <div class="metric-value">${(env.peakShip12h ?? env.ship ?? 0).toFixed(1)}</div>
          <div class="metric-sub">Now ${(env.ship ?? 0).toFixed(1)} · ≥1.0 = 2"+</div>
          ${severityMeter((((env.peakShip12h ?? env.ship ?? 0)) / 2) * 100, (env.peakShip12h ?? env.ship ?? 0) >= 1 ? '#f59e0b' : '#38bdf8')}
        </div>
      </div>
      <div class="metrics-grid" style="margin-top:8px;">
        <div class="metric-box">
          <div class="metric-label">CAPE / CIN</div>
          <div class="metric-value">${env.peakCape12h}</div>
          <div class="metric-sub">Now ${env.capeNow} · CIN ${env.cinNow}</div>
          ${severityMeter(((env.peakCape12h ?? 0) / 3000) * 100, Math.abs(env.cinNow ?? 0) >= 200 ? '#facc15' : (env.peakCape12h ?? 0) >= 1500 ? '#f59e0b' : '#38bdf8')}
        </div>
        <div class="metric-box">
          <div class="metric-label">0–6 / 0–3 Shear</div>
          <div class="metric-value">${env.bulkShear0to6KmKt} / ${env.shear0to3KmKt ?? 0} kt</div>
          <div class="metric-sub">0–1 SRH ${env.srh0to1Km ?? 0} · Gust ${env.peakWindGust12hMph ?? 0} mph</div>
          ${severityMeter(((env.bulkShear0to6KmKt ?? 0) / 60) * 100, (env.bulkShear0to6KmKt ?? 0) >= 40 ? '#d946ef' : '#38bdf8')}
        </div>
        <div class="metric-box">
          <div class="metric-label">LCL / Lapse</div>
          <div class="metric-value">${env.lclMeters ?? '--'} m</div>
          <div class="metric-sub">7–5mb: ${env.lapseRate700to500 ?? 5.8}°/km · Peak ${escapeHtml(env.peakThreatTimeLabel || '--')}</div>
          ${severityMeter((((env.lapseRate700to500 ?? 5.8) - 4) / 5) * 100, (env.lapseRate700to500 ?? 5.8) >= 7.0 ? '#f59e0b' : '#10b981')}
        </div>
      </div>
      <div class="hodograph-wrap">
        <div class="hodograph-head">
          <span class="hodo-title">LIVE 5-LEVEL HODOGRAPH (KT)</span>
          <span class="hodo-rm">RM ${escapeHtml(env.bunkersCompass || '--')} @ ${env.bunkersSpeedKt ?? 0} kt</span>
        </div>
        <canvas id="hodograph-canvas" class="hodograph-canvas"></canvas>
        <div class="hodograph-foot">
          <div class="hodo-legend">
            <span><i class="hodo-dot" style="background:#f43f5e"></i>0–1km</span>
            <span><i class="hodo-dot" style="background:#f59e0b"></i>1–3km</span>
            <span><i class="hodo-dot" style="background:#38bdf8"></i>3–6km</span>
          </div>
          <span>${env.veeringDeg >= 0 ? `+${env.veeringDeg}°` : `${env.veeringDeg}°`} veer · ${state.stormCells.length} verified cell${state.stormCells.length === 1 ? '' : 's'}</span>
        </div>
      </div>
    </div>

    <!-- 3-DAY SPC SEVERE & WPC FLASH FLOOD STRIP -->
    ${renderMultiDayOutlookCard(state.multiDaySpc)}

    <!-- LOCAL NWS METEOROLOGIST AREA FORECAST DISCUSSION (AFD) -->
    ${state.afd ? `
      <div class="card" id="afd-preview-card" style="cursor:pointer;">
        <div class="card-header">
          <div class="card-title">${sectionIcon('afd')}${escapeHtml(state.afd.office)} Meteorologist Discussion</div>
          <span class="badge-muted">${escapeHtml(state.afd.issuedLabel)}</span>
        </div>
        <div class="afd-excerpt">${escapeHtml(state.afd.synopsisExcerpt)}</div>
        <div class="afd-cta">Tap to read full NWS Area Forecast Discussion →</div>
      </div>
    ` : ''}

    <!-- PRO WINTER, THERMAL COLUMN, GLAZE ICE & WSSI SUITE -->
    ${renderProWinterCardHtml(win)}

    <!-- HOURLY FORECAST -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">${sectionIcon('hourly')}Next 18 Hours</div>
        <span class="badge-muted">NWS NDFD / HRRR-GFS</span>
      </div>
      <div class="hourly-strip">
        ${hourlyItems.map((h, i) => `
          <div class="hour-pill ${i === 0 ? 'now' : ''}">
            <div class="hour-time">${escapeHtml(h.time)}</div>
            <div class="hour-icon">${renderWeatherGraphicSvg(h.condText, h.isNight, 22)}</div>
            <div class="hour-temp">${h.temp}°</div>
            <div class="hour-pop">${h.pop > 0 ? `${h.pop}%` : '&nbsp;'}</div>
            <div class="hour-pop-bar"><div class="hour-pop-fill" style="width:${Math.min(100, h.pop || 0)}%"></div></div>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- 7-DAY NWS FORECAST -->
    ${dailyItems.length ? `
      <div class="card">
        <div class="card-header">
          <div class="card-title">${sectionIcon('daily')}NWS 7-Day Forecast (NBM + WFO)</div>
          <span class="badge-muted">${escapeHtml(state.nwsBundle?.cwa || 'NWS')}</span>
        </div>
        ${dailyItems.map((p) => {
          const tVal = Number(p.temperature);
          const posPct = Number.isFinite(tVal) ? Math.max(8, Math.min(92, ((tVal - dailyMinT) / dailySpan) * 100)) : 50;
          const isDay = p.isDaytime !== false;
          return `
            <div class="daily-row">
              <div class="daily-name">${escapeHtml(p.name)}</div>
              <div class="daily-icon">${renderWeatherGraphicSvg(p.shortForecast, !isDay, 20)}</div>
              <div class="daily-desc">${escapeHtml(p.shortForecast)}</div>
              <div class="daily-bar-track">
                <div class="daily-bar-fill" style="left:${Math.max(0, posPct - 18)}%;width:32%;"></div>
              </div>
              <div class="daily-temp">${p.temperature}°${p.temperatureUnit || 'F'}</div>
            </div>
          `;
        }).join('')}
      </div>
    ` : ''}
  `;

  // Draw live 5-level Hodograph canvas & wire SPC/Flood/AFD taps
  drawHodographCanvas(env);
  document.getElementById('afd-preview-card')?.addEventListener('click', () => {
    if (!state.afd) return;
    document.getElementById('afd-modal-title').textContent = `${state.afd.office} Forecast Discussion`;
    document.getElementById('afd-modal-sub').textContent = `Issued ${state.afd.issuedLabel}`;
    document.getElementById('afd-modal-text').textContent = state.afd.fullText;
    document.getElementById('afd-modal')?.classList.remove('hidden');
  });
  container.querySelectorAll('[data-jump-spc]').forEach((el) => {
    el.addEventListener('click', async () => {
      switchTab('radar');
      await selectSpcOverlayLayer(Number(el.dataset.jumpSpc));
    });
  });
  container.querySelectorAll('[data-jump-wssi]').forEach((el) => {
    el.addEventListener('click', async () => {
      switchTab('radar');
      await selectWssiOverlayLayer(Number(el.dataset.jumpWssi));
    });
  });
  container.querySelector('[data-jump-flood]')?.addEventListener('click', async () => {
    switchTab('radar');
    const chk = document.getElementById('layer-flood');
    if (chk) chk.checked = true;
    radarMap.setLayerVisibility('flood', true);
    if (!state.iemIntel?.wpcFloodGeoJson?.features?.length) {
      try {
        const wpcFloodGeoJson = await fetchWpcFloodOutlook();
        state.iemIntel = { ...(state.iemIntel || {}), wpcFloodGeoJson };
        radarMap.setOverlayData({ wpcFloodGeoJson });
      } catch {
        // non-fatal when offline
      }
    }
  });
}

function outlookColor(cat, isFlood = false) {
  const u = String(cat || 'NONE').toUpperCase();
  if (u.includes('HIGH')) return '#d500f9';
  if (u.includes('MDT')) return '#ef5350';
  if (u.includes('ENH')) return '#fb8c00';
  if (u.includes('SLGT')) return '#fdd835';
  if (u.includes('MRGL')) return isFlood ? '#26a69a' : '#66bb6a';
  if (u.includes('TSTM')) return '#81c784';
  return '#94a3b8';
}

function renderMultiDayOutlookCard(md) {
  const m = md || {
    day1Category: 'NONE', day1TornadoProb: 'NONE', day1HailProb: 'NONE',
    day1WindProb: 'NONE', day2Category: 'NONE', day3Category: 'NONE',
    wpcDay1FloodRisk: 'NONE', activeWatches: []
  };
  const pill = (title, val, attr, color) => `
    <div class="outlook-pill" ${attr} style="border-color:${val === 'NONE' ? 'rgba(148,163,184,0.16)' : color};">
      <div class="outlook-pill-title">${title}</div>
      <div class="outlook-pill-val" style="color:${color};">${escapeHtml(val)}</div>
    </div>
  `;
  return `
    <div class="card">
      <div class="card-header">
        <div class="card-title">${sectionIcon('spc', 'amber')}SPC 3-Day Severe &amp; WPC Flood</div>
        ${m.activeWatches?.length ? `<span class="badge-red">${m.activeWatches.length} ACTIVE WATCH</span>` : '<span class="badge-muted">Tap to View Layer</span>'}
      </div>
      <div class="outlook-grid">
        ${pill('Day 1', m.day1Category, 'data-jump-spc="1"', outlookColor(m.day1Category))}
        ${pill('Day 2', m.day2Category, 'data-jump-spc="9"', outlookColor(m.day2Category))}
        ${pill('Day 3', m.day3Category, 'data-jump-spc="17"', outlookColor(m.day3Category))}
        ${pill('Flood', m.wpcDay1FloodRisk, 'data-jump-flood="1"', outlookColor(m.wpcDay1FloodRisk, true))}
      </div>
      <div class="prob-grid">
        ${pill('Day 1 Tor', m.day1TornadoProb, 'data-jump-spc="3"', m.day1TornadoProb === 'NONE' ? '#94a3b8' : '#ff2b4a')}
        ${pill('Day 1 Hail', m.day1HailProb, 'data-jump-spc="5"', m.day1HailProb === 'NONE' ? '#94a3b8' : '#10b981')}
        ${pill('Day 1 Wind', m.day1WindProb, 'data-jump-spc="7"', m.day1WindProb === 'NONE' ? '#94a3b8' : '#facc15')}
      </div>
    </div>
  `;
}

function drawHodographCanvas(env) {
  const canvas = document.getElementById('hodograph-canvas');
  if (!canvas || !env?.hodographPoints?.length) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const size = 224;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, size, size);

  const pts = env.hodographPoints;
  const cx = size / 2;
  const cy = size / 2;
  const maxR = size / 2 - 16;
  const maxSpd = Math.max(...pts.map((p) => Math.hypot(p.uKt, p.vKt)), 20);
  const maxRing = maxSpd > 60 ? 80 : maxSpd > 42 ? 60 : maxSpd > 26 ? 40 : 30;
  const pxPerKt = maxR / maxRing;
  const toXY = (u, v) => [cx + u * pxPerKt, cy - v * pxPerKt];

  // Radar-scope radial gradient backdrop
  const scopeGrad = ctx.createRadialGradient(cx, cy, 4, cx, cy, maxR);
  scopeGrad.addColorStop(0, 'rgba(56, 189, 248, 0.06)');
  scopeGrad.addColorStop(0.65, 'rgba(13, 21, 36, 0.42)');
  scopeGrad.addColorStop(1, 'rgba(5, 9, 18, 0.84)');
  ctx.fillStyle = scopeGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, maxR, 0, Math.PI * 2);
  ctx.fill();

  // Dashed speed rings
  const step = maxRing <= 30 ? 10 : 20;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#64748b';
  ctx.font = '9.5px "JetBrains Mono", ui-monospace, monospace';
  for (let rk = step; rk <= maxRing; rk += step) {
    const r = rk * pxPerKt;
    ctx.setLineDash(rk === maxRing ? [] : [3, 3]);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillText(`${rk}`, cx + 3, cy - r + 10);
  }
  ctx.setLineDash([]);

  // Cardinal axes
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.beginPath();
  ctx.moveTo(cx - maxR, cy); ctx.lineTo(cx + maxR, cy);
  ctx.moveTo(cx, cy - maxR); ctx.lineTo(cx, cy + maxR);
  ctx.stroke();
  ctx.fillStyle = '#8da2bc';
  ctx.font = '600 9.5px "Inter", -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('N', cx, cy - maxR - 4);
  ctx.fillText('S', cx, cy + maxR + 11);
  ctx.fillText('E', cx + maxR + 8, cy + 3);
  ctx.fillText('W', cx - maxR - 8, cy + 3);
  ctx.textAlign = 'left';

  // Bunkers Right-Mover vector
  const rmRad = ((env.bunkersHeadingDeg || 60) * Math.PI) / 180;
  const rmU = Math.sin(rmRad) * (env.bunkersSpeedKt || 0);
  const rmV = Math.cos(rmRad) * (env.bunkersSpeedKt || 0);
  const [rmX, rmY] = toXY(rmU, rmV);

  // Shaded 0-3km SRH inflow wedge
  const lowPts = pts.filter((p) => p.heightKm <= 3.2);
  if (lowPts.length >= 2) {
    ctx.fillStyle = 'rgba(244, 63, 94, 0.16)';
    ctx.beginPath();
    ctx.moveTo(rmX, rmY);
    lowPts.forEach((p) => { const [x, y] = toXY(p.uKt, p.vKt); ctx.lineTo(x, y); });
    ctx.closePath();
    ctx.fill();
  }

  // Origin -> RM dashed motion vector
  ctx.strokeStyle = 'rgba(245, 158, 11, 0.52)';
  ctx.lineWidth = 1.3;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(rmX, rmY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Height-colored hodograph segments
  ctx.lineWidth = 2.8;
  ctx.lineCap = 'round';
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const [x1, y1] = toXY(a.uKt, a.vKt);
    const [x2, y2] = toXY(b.uKt, b.vKt);
    ctx.strokeStyle = b.heightKm <= 1.2 ? '#f43f5e' : b.heightKm <= 3.2 ? '#f59e0b' : '#38bdf8';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  // Points & de-crowded altitude labels
  const placedLabels = [];
  ctx.font = '600 9.5px "Inter", -apple-system, sans-serif';
  pts.forEach((p, idx) => {
    const [x, y] = toXY(p.uKt, p.vKt);
    ctx.fillStyle = '#050912';
    ctx.beginPath(); ctx.arc(x, y, 4.4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = p.heightKm <= 1.2 ? '#f43f5e' : p.heightKm <= 3.2 ? '#f59e0b' : '#38bdf8';
    ctx.beginPath(); ctx.arc(x, y, 2.8, 0, Math.PI * 2); ctx.fill();

    // Always prioritize Sfc, 850, 700, 500 labels; skip 925 if crowded
    if (p.label === '925') return;
    const dx = x - cx;
    const dy = y - cy;
    const norm = Math.max(1, Math.hypot(dx, dy));
    let lx = x + (dx / norm) * 11;
    let ly = y + (dy / norm) * 11 + (dy >= 0 ? 4 : 0);
    if (placedLabels.some((o) => Math.hypot(o[0] - lx, o[1] - ly) < 16)) {
      lx = x + (idx % 2 === 0 ? -18 : 10);
      ly = y + (idx % 2 === 0 ? -9 : 13);
    }
    placedLabels.push([lx, ly]);
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(p.label, Math.max(6, Math.min(size - 26, lx - 6)), Math.max(12, Math.min(size - 6, ly)));
  });

  // RM Crosshair reticle
  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.arc(rmX, rmY, 5.2, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(rmX - 7.5, rmY); ctx.lineTo(rmX + 7.5, rmY);
  ctx.moveTo(rmX, rmY - 7.5); ctx.lineTo(rmX, rmY + 7.5);
  ctx.stroke();
  ctx.fillStyle = '#fbbf24';
  ctx.font = '700 9.5px "Inter", -apple-system, sans-serif';
  ctx.fillText('RM', rmX + 7, rmY + 11);
}

function buildHourlyItems() {
  const nwsHourly = state.nwsBundle?.hourlyPeriods || [];
  if (nwsHourly.length >= 6) {
    return nwsHourly.slice(0, 18).map((p, i) => {
      const label = i === 0 ? 'Now' : formatCentralHour(p.startTime);
      const condText = p.shortForecast || '';
      return {
        time: label,
        condText,
        isNight: p.isDaytime === false,
        temp: p.temperature,
        pop: p.probabilityOfPrecipitation?.value || 0
      };
    });
  }

  const om = state.openMeteo?.hourly;
  if (!om?.time?.length) return [];
  const now = Date.now();
  const utcOffsetSeconds = Number.isFinite(state.openMeteo?.utc_offset_seconds) ? state.openMeteo.utc_offset_seconds : 0;
  let start = om.time.findIndex((t) => {
    const ms = parseUtcTimestampMs(t, { utcOffsetSeconds });
    return ms != null && ms >= now - 3600000;
  });
  if (start < 0) start = 0;
  return om.time.slice(start, start + 18).map((t, i) => {
    const ms = parseUtcTimestampMs(t, { utcOffsetSeconds });
    const [condText] = wmoInfo(om.weather_code?.[start + i]);
    const hr = getCentralHour24(ms) ?? 12;
    return {
      time: i === 0 ? 'Now' : formatCentralHour(ms),
      condText,
      isNight: hr < 6 || hr >= 18,
      temp: Math.round(om.temperature_2m?.[start + i] ?? 0),
      pop: Math.round(om.precipitation_probability?.[start + i] ?? 0)
    };
  });
}

/* ==================== RENDER: ALERTS ==================== */
function renderAlerts() {
  const el = document.getElementById('alerts-content');
  if (!el) return;

  const localAlerts = state.localAlerts || [];
  const convAlerts = state.environment?.proactiveAlerts || [];
  const winAlerts = state.winter?.winterAlerts || [];
  const cells = state.stormCells || [];
  const mcds = state.iemIntel?.mcdGeoJson?.features || [];

  const parts = [];

  if (localAlerts.length) {
    parts.push(`<div class="section-mini-label">Active Local NWS Alerts (${localAlerts.length})</div>`);
    for (const a of localAlerts) {
      const cls = a.tier === 'CRITICAL' ? 'tier-critical' : a.tier === 'WINTER' ? 'tier-winter' : '';
      parts.push(`
        <div class="card alert-card ${cls}">
          <div class="card-header" style="margin-bottom:4px;">
            <span class="badge-${a.tier === 'CRITICAL' ? 'red' : a.tier === 'WINTER' ? 'blue' : 'amber'}">${a.isTornadoEmergency ? 'TORNADO EMERGENCY' : a.isPdsOrObserved ? 'OBSERVED / PDS' : a.tier}</span>
            <span class="metric-sub">${(a.expiresMs ?? a.expires) ? `Exp ${formatCentralTime(a.expiresMs ?? a.expires)}` : ''}</span>
          </div>
          <div class="alert-title">${escapeHtml(a.event)}</div>
          <div class="alert-meta">${escapeHtml(a.headline)}</div>
          <div class="tag-row">
            ${a.insidePolygon === true ? `<span class="badge-red">INSIDE POLYGON</span>` : a.insidePolygon === false ? `<span class="badge-muted">Zone / Nearby</span>` : ''}
            ${a.tornadoDetection ? `<span class="badge-red">Tornado: ${escapeHtml(a.tornadoDetection)}</span>` : ''}
            ${a.tornadoDamageThreat ? `<span class="badge-red">Damage: ${escapeHtml(a.tornadoDamageThreat)}</span>` : ''}
            ${a.thunderstormDamageThreat ? `<span class="badge-red">Svr: ${escapeHtml(a.thunderstormDamageThreat)}</span>` : ''}
            ${a.maxWindGust ? `<span class="badge-amber">Wind: ${escapeHtml(a.maxWindGust)}</span>` : ''}
            ${a.maxHailSize ? `<span class="badge-amber">Hail: ${escapeHtml(a.maxHailSize)}"</span>` : ''}
          </div>
          ${a.stormMotion ? `<div class="cell-motion-banner"><span>${escapeHtml(a.stormMotion.summary)}</span><span>NWS CAP Vector</span></div>` : ''}
          ${a.instruction ? `<div class="alert-meta" style="margin-top:8px;color:var(--text-primary);">${escapeHtml(a.instruction.slice(0, 340))}</div>` : ''}
          <div class="card-action-row">
            <button class="btn-primary-sm" data-focus-alert="${escapeHtml(a.id)}">View on Radar</button>
          </div>
        </div>
      `);
    }
  }

  if (convAlerts.length || winAlerts.length) {
    parts.push(`<div class="section-mini-label">Tempest Proactive Intelligence</div>`);
    for (const ca of convAlerts) {
      parts.push(`
        <div class="card alert-card tier-convective">
          <span class="badge-cyan">CONVECTIVE ENVIRONMENT</span>
          <div class="alert-title">${escapeHtml(ca.title)}</div>
          <div class="alert-meta">${escapeHtml(ca.summary)}</div>
        </div>
      `);
    }
    for (const wa of winAlerts) {
      parts.push(`
        <div class="card alert-card tier-winter">
          <span class="badge-blue">WINTER / SURFACE HAZARD</span>
          <div class="alert-title">${escapeHtml(wa.title)}</div>
          <div class="alert-meta">${escapeHtml(wa.summary)}</div>
        </div>
      `);
    }
  }

  if (cells.length) {
    parts.push(`<div class="section-mini-label">Verified NEXRAD Storm Cells Within 120 mi (${cells.length})</div>`);
    for (const sc of cells.slice(0, 12)) {
      const cls = sc.tvs ? 'tier-critical' : sc.meso ? 'tier-supercell' : '';
      const confirmStr = sc.confirmingRadars?.length > 1
        ? `Confirmed by ${sc.confirmingRadars.length} radars: ${sc.confirmingRadars.join(' · ')}`
        : `Single-site radar: ${sc.nexrad}`;
      parts.push(`
        <div class="card alert-card ${cls}">
          <div class="card-header" style="margin-bottom:4px;">
            <span class="badge-${sc.tvs ? 'red' : sc.meso ? 'magenta' : sc.threatScore >= 2 ? 'amber' : 'muted'}">${sc.threatLevel.replace('_', ' ')} • ${escapeHtml(sc.stormId)}</span>
            <span class="metric-sub">${fmtFixed(sc.intercept?.distanceMi, 1)} mi ${sc.intercept?.compassFromUser || '--'}</span>
          </div>
          <div class="alert-title">
            ${sc.intercept?.etaMinutes != null ? `Time on Target: ~${sc.intercept.etaMinutes} min` : escapeHtml(sc.intercept?.verdictLabel || '--')}
          </div>
          <div class="cell-motion-banner">
            <span>${escapeHtml(sc.motionSummary)}</span>
          </div>
          <div class="cell-proof-grid">
            <div class="cell-proof-item">
              <div class="cell-proof-k">VIL</div>
              <div class="cell-proof-v">${sc.vil ?? 0}</div>
            </div>
            <div class="cell-proof-item">
              <div class="cell-proof-k">Top</div>
              <div class="cell-proof-v">${sc.topKft ? `${sc.topKft}k` : '--'}</div>
            </div>
            <div class="cell-proof-item">
              <div class="cell-proof-k">dBZ</div>
              <div class="cell-proof-v">${sc.maxDbz || '--'}</div>
            </div>
            <div class="cell-proof-item">
              <div class="cell-proof-k">Hail</div>
              <div class="cell-proof-v">${sc.maxHailIn > 0 ? `${sc.maxHailIn}"` : `${sc.posh ?? 0}%`}</div>
            </div>
          </div>
          <div class="tag-row">
            ${sc.tvs ? `<span class="badge-red">TVS</span>` : ''}
            ${sc.meso ? `<span class="badge-magenta">MESO RANK ${escapeHtml(sc.meso)}</span>` : ''}
            ${sc.maxHailIn > 0 ? `<span class="badge-amber">Hail ${sc.maxHailIn}" (POSH ${sc.posh}%)</span>` : ''}
          </div>
          <div class="radar-confirm-pill">
            <span>${escapeHtml(confirmStr)}</span>
            <span>${escapeHtml(sc.intercept.verdictLabel)}</span>
          </div>
          <div class="card-action-row">
            <button class="btn-primary-sm" data-focus-cell="${escapeHtml(sc.id)}">Track on Radar</button>
          </div>
        </div>
      `);
    }
  }

  if (mcds.length) {
    parts.push(`<div class="section-mini-label">Active SPC Mesoscale Discussions (${mcds.length})</div>`);
    for (const m of mcds.slice(0, 6)) {
      const mp = m.properties || {};
      parts.push(`
        <div class="card alert-card tier-supercell">
          <span class="badge-magenta">SPC MCD #${escapeHtml(mp.num || '')}</span>
          <div class="alert-title">${escapeHtml(mp.concerning || 'Mesoscale Discussion')}</div>
          <div class="alert-meta">${escapeHtml(mp.watch_confidence ? `Watch probability: ${mp.watch_confidence}` : 'Active SPC mesoscale analysis polygon shown on Radar.')}</div>
        </div>
      `);
    }
  }

  if (!parts.length) {
    const loc = state.activeLocation || getSavedHomeLocation();
    const site = state.selectedRadarSite || findNearestNexradStation(loc.lat, loc.lon).id;
    parts.push(`
      <div class="card alerts-clear-hero">
        <div class="alerts-clear-emblem" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>
        </div>
        <div class="alerts-clear-eyebrow">Active Watchdog · Standby</div>
        <div class="alerts-clear-title">All Quiet Across Your Area</div>
        <div class="alerts-clear-copy">
          No verified supercells, TVS signatures, or NWS warnings detected within 120 miles. Non-convective clutter is automatically suppressed.
        </div>
        <div class="alerts-clear-meta">
          <span>${escapeHtml(site)} NEXRAD</span>
          <span class="telem-sep">·</span>
          <span>120 mi Sweep</span>
          <span class="telem-sep">·</span>
          <span>${state.settings.adaptiveStormModeEnabled ? 'Adaptive 45s Armed' : '3m Polling'}</span>
        </div>
      </div>
    `);
  }

  el.innerHTML = parts.join('');

  el.querySelectorAll('[data-focus-alert]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const a = state.localAlerts.find((x) => x.id === btn.dataset.focusAlert);
      switchTab('radar');
      if (a?.geometry) {
        const ctr = geometryCentroid(a.geometry);
        if (ctr) radarMap.flyTo(ctr.lat, ctr.lon, 8.6);
      }
      if (a) openInspectSheet('alert', a);
    });
  });

  el.querySelectorAll('[data-focus-cell]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const c = state.stormCells.find((x) => x.id === btn.dataset.focusCell);
      switchTab('radar');
      if (c) {
        radarMap.flyTo(c.lat, c.lon, 9.2);
        openInspectSheet('cell', c);
      }
    });
  });
}

/* ==================== RENDER: SETTINGS & OTA UPDATER ==================== */
function renderSettings() {
  const el = document.getElementById('settings-content');
  if (!el) return;

  const s = state.settings;
  const upd = updater.remoteManifest;
  const hasUpd = updater.updateAvailable;

  el.innerHTML = `
    <!-- OTA AUTO-UPDATER -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">${sectionIcon('ota')}App Updates (OTA)</div>
        <span class="badge-${hasUpd ? 'cyan' : 'green'}">${hasUpd ? 'Update Ready' : `v${APP_LOCAL_VERSION.versionName} Current`}</span>
      </div>
      <div class="alert-meta" style="margin-bottom:10px;">
        <strong>Installed:</strong> Tempest v${APP_LOCAL_VERSION.versionName} (Build ${APP_LOCAL_VERSION.versionCode}) • Created by J. Borden<br/>
        <strong>Install Mode:</strong> ${updater.isStandalone() ? 'Installed Home Screen App ✓' : 'Safari Browser (Add to Home Screen for full-screen mode)'}
      </div>
      ${upd?.releaseNotes ? `<div class="alert-meta" style="margin-bottom:10px;padding:9px;border-radius:10px;background:rgba(255,255,255,0.03);border:1px solid var(--border-subtle);"><strong>Latest Release Notes (v${escapeHtml(upd.versionName)}):</strong><br/>${escapeHtml(upd.releaseNotes)}</div>` : ''}
      <div style="display:flex;gap:8px;">
        <button id="btn-check-updates" class="btn-secondary-sm" style="flex:1;">Check for Updates</button>
        ${hasUpd ? `<button id="btn-apply-update-settings" class="btn-primary-sm" style="flex:1;">Install Update Now</button>` : ''}
      </div>
    </div>

    <!-- SEVERE WEATHER ENGINE SETTINGS -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">${sectionIcon('shield')}Severe Protection Engine</div>
        <span class="badge-${state.isStormWatchActive ? 'red' : 'green'}">${state.isStormWatchActive ? 'Active 45s Watch' : 'Standby 3m'}</span>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <div class="setting-title">Adaptive Storm Watch Mode (45s Polling)</div>
          <div class="setting-desc">Automatically accelerates radar, storm-cell &amp; NWS alert checks from 3 min to 45 sec during severe weather.</div>
        </div>
        <input type="checkbox" id="set-adaptive" ${s.adaptiveStormModeEnabled ? 'checked' : ''} />
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <div class="setting-title">Keep iPhone Screen Awake During Storms</div>
          <div class="setting-desc">Prevents iPhone auto-lock during active severe weather so custom Tornado &amp; Supercell sirens fire immediately.</div>
        </div>
        <input type="checkbox" id="set-wakelock" ${s.keepScreenAwakeInStorm ? 'checked' : ''} />
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <div class="setting-title">Spoken NOAA Voice Announcer</div>
          <div class="setting-desc">Reads Tornado Warnings, Time-on-Target countdowns &amp; shelter instructions aloud when an emergency triggers.</div>
        </div>
        <input type="checkbox" id="set-voice" ${s.voiceAnnouncerEnabled !== false ? 'checked' : ''} />
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <div class="setting-title">Severe Thunderstorm &amp; Flash Flood Alarms</div>
          <div class="setting-desc">Sound Severe Alarm on local Severe Thunderstorm, Flash Flood &amp; Snow Squall Warnings (Tornado Warnings always sound).</div>
        </div>
        <input type="checkbox" id="set-severe" ${s.severeWarningAlertsEnabled ? 'checked' : ''} />
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <div class="setting-title">Proactive Storm Time-on-Target (TOT) Alerts</div>
          <div class="setting-desc">Pre-warn when a rotating supercell or severe radar cell tracks toward your location ahead of polygons.</div>
        </div>
        <input type="checkbox" id="set-tot" ${s.proactiveTotAlertsEnabled ? 'checked' : ''} />
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <div class="setting-title">Proactive TOT Lead Window (${s.proactiveTotLeadMinutes} min)</div>
          <div class="setting-desc">Alert when an intercepting storm cell is within ${s.proactiveTotLeadMinutes} minutes of arrival.</div>
        </div>
        <input type="range" id="set-tot-lead" class="luxury-range" min="15" max="60" step="5" value="${s.proactiveTotLeadMinutes}" style="--range-pct:${Math.round(((s.proactiveTotLeadMinutes - 15) / 45) * 100)}%;" />
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <div class="setting-title">Convective / HSLC Upper-Air Alerts</div>
          <div class="setting-desc">Monitor true 0–6km (500 hPa) &amp; 0–1.5km (850 hPa) shear, CAPE, pressure falls &amp; SPC MCDs.</div>
        </div>
        <input type="checkbox" id="set-convective" ${s.convectiveAlertsEnabled ? 'checked' : ''} />
      </div>

      <div class="setting-item" style="flex-direction:column;align-items:stretch;gap:8px;">
        <div class="setting-info">
          <div class="setting-title">Convective Alert Sensitivity</div>
          <div class="setting-desc">Controls when upper-air supercell / HSLC environment chimes trigger.</div>
        </div>
        <div class="segmented-row" style="grid-template-columns:repeat(3,1fr);">
          <button class="seg-btn ${s.convectiveAlertThreshold === 'SENSITIVE' ? 'active' : ''}" data-conv-thresh="SENSITIVE">Sensitive</button>
          <button class="seg-btn ${s.convectiveAlertThreshold === 'STANDARD' ? 'active' : ''}" data-conv-thresh="STANDARD">Standard</button>
          <button class="seg-btn ${s.convectiveAlertThreshold === 'HIGH_ONLY' ? 'active' : ''}" data-conv-thresh="HIGH_ONLY">High Only</button>
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <div class="setting-title">Dixie Alley Nocturnal Readiness</div>
          <div class="setting-desc">Escalate evening/overnight shear &amp; HSLC setups before you go to sleep.</div>
        </div>
        <input type="checkbox" id="set-nocturnal" ${s.nocturnalReadinessEnabled ? 'checked' : ''} />
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <div class="setting-title">Winter, Black Ice &amp; Freezing Fog Alerts</div>
          <div class="setting-desc">Track 0cm/6cm ground temperatures, bridge icing risk, and freezing fog visibility.</div>
        </div>
        <input type="checkbox" id="set-winter" ${s.winterAlertsEnabled ? 'checked' : ''} />
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <div class="setting-title">Ground Freeze Trigger (${s.groundFreezeThresholdF}°F)</div>
          <div class="setting-desc">Alert when 0cm surface ground temperature drops to or below threshold.</div>
        </div>
        <input type="range" id="set-freeze-slider" class="luxury-range" min="28" max="36" value="${s.groundFreezeThresholdF}" style="--range-pct:${Math.round(((s.groundFreezeThresholdF - 28) / 8) * 100)}%;" />
      </div>
    </div>

    <!-- CUSTOM SIREN SELECTOR & SOUND TESTER -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">${sectionIcon('sounding', 'amber')}Tornado &amp; Severe Alert Sirens</div>
        <span class="badge-muted">8 Custom WAVs</span>
      </div>
      <div class="alert-meta" style="margin-bottom:12px;">
        Tap any siren to preview on your iPhone. Tornado Emergencies &amp; Observed Tornadoes loop continuously until you tap Silence.
      </div>
      <div class="siren-list">
        ${SIREN_CATALOG.map((item) => {
          const isSelected = s.tornadoSoundId === item.id;
          const isPlaying = state.activePlayingSoundId === item.id;
          return `
            <div class="siren-row ${isSelected ? 'selected' : ''}">
              <label class="siren-radio-wrap">
                <input type="radio" name="tornado-siren" value="${item.id}" ${isSelected ? 'checked' : ''} />
                <div>
                  <div class="siren-name">${escapeHtml(item.name)}</div>
                  <div class="siren-sub">${escapeHtml(item.sub)}</div>
                </div>
              </label>
              <button class="btn-${isPlaying ? 'danger' : 'secondary'}-sm" data-preview-siren="${item.id}">
                ${isPlaying ? '⏹ Stop' : '▶ Test'}
              </button>
            </div>
          `;
        }).join('')}
      </div>
    </div>

    <!-- TEST ALERT SIMULATOR -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">${sectionIcon('sim')}Test Alert Simulator</div>
        <span class="badge-muted">Audio + Banner</span>
      </div>
      <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:9px;">
        <button id="btn-test-tornado" class="btn-glass-danger">Test Tornado Siren</button>
        <button id="btn-test-tot" class="btn-glass-cyan">Test Storm TOT</button>
        <button id="btn-test-convective" class="btn-glass-violet">Test Convective</button>
        <button id="btn-test-winter" class="btn-glass-blue">Test Black Ice</button>
      </div>
    </div>

    <!-- iPHONE HOME SCREEN GUIDE -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">${sectionIcon('phone')}iPhone Home Screen Setup</div>
      </div>
      <div class="alert-meta">
        1. Open this link in <strong>Safari</strong> on iPhone.<br/>
        2. Tap the <strong>Share</strong> button at the bottom of Safari.<br/>
        3. Scroll down and tap <strong>Add to Home Screen</strong>.<br/>
        4. Open <strong>Tempest</strong> from your Home Screen — free forever, never expires, and automatically receives OTA updates whenever new releases are published. Created by J. Borden.
      </div>
    </div>
  `;

  // Wire Settings actions
  document.getElementById('btn-check-updates')?.addEventListener('click', async () => {
    showToast('Checking for Borden Tempest updates...');
    try {
      const res = await updater.checkForUpdates(false);
      if (res.status === 'UPDATE_AVAILABLE') {
        showToast(`Update v${res.manifest.versionName} available!`);
      } else if (res.status === 'UP_TO_DATE') {
        document.getElementById('update-banner')?.classList.add('hidden');
        showToast(`You're on the latest version (v${APP_LOCAL_VERSION.versionName}).`);
      } else {
        showToast(`Update check failed: ${res.error}`);
      }
    } catch {
      showToast('Update check failed — offline');
    }
    renderSettings();
  });

  document.getElementById('btn-apply-update-settings')?.addEventListener('click', () => {
    void updater.applyUpdateNow().catch(() => {});
  });

  el.querySelectorAll('input[name="tornado-siren"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      state.settings.tornadoSoundId = e.target.value;
      saveSettings();
      renderSettings();
    });
  });

  el.querySelectorAll('[data-preview-siren]').forEach((btn) => {
    btn.addEventListener('click', () => {
      audioEngine.unlockForIOS();
      audioEngine.togglePreview(btn.dataset.previewSiren);
    });
  });

  document.getElementById('set-adaptive')?.addEventListener('change', (e) => {
    state.settings.adaptiveStormModeEnabled = e.target.checked;
    saveSettings();
    scheduleNextPoll();
    updateHeaderAndBadges();
  });
  document.getElementById('set-wakelock')?.addEventListener('change', (e) => {
    state.settings.keepScreenAwakeInStorm = e.target.checked;
    saveSettings();
    syncWakeLock();
  });
  document.getElementById('set-voice')?.addEventListener('change', (e) => {
    state.settings.voiceAnnouncerEnabled = e.target.checked;
    saveSettings();
  });
  document.getElementById('set-severe')?.addEventListener('change', (e) => {
    state.settings.severeWarningAlertsEnabled = e.target.checked;
    saveSettings();
  });
  document.getElementById('set-tot')?.addEventListener('change', (e) => {
    state.settings.proactiveTotAlertsEnabled = e.target.checked;
    saveSettings();
  });
  document.getElementById('set-tot-lead')?.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    state.settings.proactiveTotLeadMinutes = val;
    e.target.style.setProperty('--range-pct', `${Math.round(((val - 15) / 45) * 100)}%`);
    saveSettings();
    const row = e.target.closest('.setting-item');
    const titleEl = row?.querySelector('.setting-title');
    const descEl = row?.querySelector('.setting-desc');
    if (titleEl) titleEl.textContent = `Proactive TOT Lead Window (${val} min)`;
    if (descEl) descEl.textContent = `Alert when an intercepting storm cell is within ${val} minutes of arrival.`;
    updateHeaderAndBadges();
  });
  document.getElementById('set-convective')?.addEventListener('change', (e) => {
    state.settings.convectiveAlertsEnabled = e.target.checked;
    saveSettings();
  });
  el.querySelectorAll('[data-conv-thresh]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.settings.convectiveAlertThreshold = btn.dataset.convThresh;
      saveSettings();
      if (state.openMeteo?.hourly && state.current) {
        const mcdCount = state.iemIntel?.mcdGeoJson?.features?.length || 0;
        state.environment = analyzeEnvironment(state.openMeteo, state.current, mcdCount, {
          convectiveAlertThreshold: state.settings.convectiveAlertThreshold,
          nocturnalReadinessEnabled: state.settings.nocturnalReadinessEnabled
        });
        renderDashboard();
        renderAlerts();
      }
      renderSettings();
    });
  });
  document.getElementById('set-nocturnal')?.addEventListener('change', (e) => {
    state.settings.nocturnalReadinessEnabled = e.target.checked;
    saveSettings();
    if (state.openMeteo?.hourly && state.current) {
      const mcdCount = state.iemIntel?.mcdGeoJson?.features?.length || 0;
      state.environment = analyzeEnvironment(state.openMeteo, state.current, mcdCount, {
        convectiveAlertThreshold: state.settings.convectiveAlertThreshold,
        nocturnalReadinessEnabled: state.settings.nocturnalReadinessEnabled
      });
      renderDashboard();
    }
  });
  document.getElementById('set-winter')?.addEventListener('change', (e) => {
    state.settings.winterAlertsEnabled = e.target.checked;
    saveSettings();
  });
  document.getElementById('set-freeze-slider')?.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    state.settings.groundFreezeThresholdF = val;
    e.target.style.setProperty('--range-pct', `${Math.round(((val - 28) / 8) * 100)}%`);
    saveSettings();
    const row = e.target.closest('.setting-item');
    const titleEl = row?.querySelector('.setting-title');
    if (titleEl) titleEl.textContent = `Ground Freeze Trigger (${val}°F)`;
    if (state.openMeteo?.hourly && state.current) {
      state.winter = analyzeWinterSuite(
        state.openMeteo,
        state.current,
        state.settings.groundFreezeThresholdF,
        Date.now(),
        {
          gridData: state.nwsBundle?.gridData || null,
          winterModels: state.winterModels,
          wssiBundle: state.wssiBundle,
          lat: state.activeLocation?.lat,
          lon: state.activeLocation?.lon
        }
      );
      updateHeaderAndBadges();
      updateTelemetryRibbon();
      renderDashboard();
    }
  });

  document.getElementById('btn-test-tornado')?.addEventListener('click', () => {
    triggerAlertPopup({
      badge: 'TEST CRITICAL WARNING',
      title: 'Tornado Warning (Test)',
      body: 'THIS IS A TEST ALERT from Borden Tempest.\nTime on Target: ~14 min • 12.4 mi WSW moving ENE @ 52 mph (CPA 0.7 mi).\nTornado: OBSERVED • Max Hail: 1.75" • Open Radar to verify Velocity (N0G) & CC Debris (N0C).',
      soundId: state.settings.tornadoSoundId,
      loop: false
    });
  });

  document.getElementById('btn-test-tot')?.addEventListener('click', () => {
    triggerAlertPopup({
      badge: 'TEST STORM PRE-WARNING',
      title: 'Approaching Supercell (TOT)',
      body: 'THIS IS A TEST PRE-WARNING from Borden Tempest.\nTime on Target: ~26 min • 21.8 mi SW moving NE @ 50 mph • Direct Intercept (CPA 1.2 mi).\nProactive radar-cell tracking alerts you ahead of official polygon arrival.',
      soundId: 'supercell_alert_alarm',
      loop: false
    });
  });

  document.getElementById('btn-test-convective')?.addEventListener('click', () => {
    triggerAlertPopup({
      badge: 'TEST CONVECTIVE ALERT',
      title: 'HSLC Supercell Environment',
      body: '0–6km Shear 48 kt (500 hPa) • 0–1.5km Shear 34 kt (+42° veer) • CAPE 520 J/kg • Td 66°F • Pressure -3.6 hPa/3hr.\nDangerous low-CAPE, high-shear rotating storm potential.',
      soundId: 'convective_chime',
      loop: false
    });
  });

  document.getElementById('btn-test-winter')?.addEventListener('click', () => {
    triggerAlertPopup({
      badge: 'TEST WINTER HAZARD',
      title: 'Black Ice / Freezing Rain',
      body: 'Ground 30°F (6cm: 32°F) • Air 33°F • Vis 0.3 mi • Bridges icing rapidly.',
      soundId: 'winter_alert_chime',
      loop: false
    });
  });
}

function speakEmergencyBriefing(title, body) {
  if (state.settings.voiceAnnouncerEnabled === false) return;
  if (!('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const script = `Emergency weather alert from Tempest. ${title}. ${String(body || '').replace(/\n+/g, '. ').slice(0, 260)}`;
    const utter = new SpeechSynthesisUtterance(script);
    utter.lang = 'en-US';
    utter.rate = 0.96;
    window.speechSynthesis.speak(utter);
  } catch {
    // ignore speech errors on locked Safari contexts
  }
}

function stopVoiceBriefing() {
  if (state.voiceBriefingTimerId !== null) {
    clearTimeout(state.voiceBriefingTimerId);
    state.voiceBriefingTimerId = null;
  }
  if ('speechSynthesis' in window) {
    try { window.speechSynthesis.cancel(); } catch {}
  }
}

function triggerAlertPopup({ badge, title, body, soundId, loop = false, alertCanonicalId = null }) {
  stopVoiceBriefing();
  state.activePopupAlertId = alertCanonicalId;
  audioEngine.unlockForIOS();
  if (navigator.vibrate) {
    try { navigator.vibrate([300, 120, 300, 120, 500]); } catch {}
  }
  const badgeEl = document.getElementById('alert-popup-badge');
  const titleEl = document.getElementById('alert-popup-title');
  const bodyEl = document.getElementById('alert-popup-body');
  if (badgeEl) badgeEl.textContent = badge;
  if (titleEl) titleEl.textContent = title;
  if (bodyEl) bodyEl.textContent = body;
  document.getElementById('alert-popup-modal')?.classList.remove('hidden');
  void audioEngine.play(soundId, loop).catch(() => false);
  if (String(badge || '').toUpperCase().includes('TORNADO') || String(badge || '').toUpperCase().includes('CRITICAL')) {
    state.voiceBriefingTimerId = setTimeout(() => {
      state.voiceBriefingTimerId = null;
      speakEmergencyBriefing(title, body);
    }, 1200);
  }
}

/* ==================== LOCATION & SITE MODALS ==================== */
function openLocationModal() {
  document.getElementById('location-search-input').value = '';
  document.getElementById('location-search-results').innerHTML = '';
  renderSavedLocations();
  document.getElementById('location-modal')?.classList.remove('hidden');
}

function closeLocationModal() {
  document.getElementById('location-modal')?.classList.add('hidden');
}

function renderSavedLocations() {
  const list = document.getElementById('saved-locations-list');
  if (!list) return;
  list.innerHTML = state.savedLocations.map((loc) => {
    const active = state.activeLocation.id === loc.id;
    return `
      <div class="loc-item ${active ? 'active' : ''}" data-select-loc="${escapeHtml(loc.id)}">
        <div>
          <div class="loc-item-name">${escapeHtml(loc.name)}</div>
          <div class="loc-item-sub">${loc.lat.toFixed(3)}, ${loc.lon.toFixed(3)}</div>
        </div>
        ${state.savedLocations.length > 1 ? `<button class="icon-btn-sm" data-del-loc="${escapeHtml(loc.id)}" title="Remove">✕</button>` : ''}
      </div>
    `;
  }).join('');

  list.querySelectorAll('[data-select-loc]').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-del-loc]')) return;
      const found = state.savedLocations.find((l) => l.id === row.dataset.selectLoc);
      if (found) {
        closeLocationModal();
        switchActiveLocation(found, { fly: true });
      }
    });
  });

  list.querySelectorAll('[data-del-loc]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.savedLocations = state.savedLocations.filter((l) => l.id !== btn.dataset.delLoc);
      saveLocations();
      if (state.activeLocation.id === btn.dataset.delLoc && state.savedLocations.length) {
        switchActiveLocation(state.savedLocations[0], { fly: true });
      }
      renderSavedLocations();
    });
  });
}

async function runLocationSearch() {
  const q = document.getElementById('location-search-input')?.value || '';
  const resEl = document.getElementById('location-search-results');
  if (!q.trim() || !resEl) return;
  resEl.innerHTML = `<div class="alert-meta">Searching...</div>`;
  try {
    const hits = await searchLocations(q);
    if (!hits.length) {
      resEl.innerHTML = `<div class="alert-meta">No matching locations found.</div>`;
      return;
    }
    resEl.innerHTML = hits.map((h, i) => `
      <div class="loc-item" data-pick-hit="${i}">
        <div>
          <div class="loc-item-name">${escapeHtml(h.name)}</div>
          <div class="loc-item-sub">${escapeHtml(h.sub)}</div>
        </div>
        <span class="badge-cyan">Add</span>
      </div>
    `).join('');

    resEl.querySelectorAll('[data-pick-hit]').forEach((row) => {
      row.addEventListener('click', () => {
        const hit = hits[Number(row.dataset.pickHit)];
        const newLoc = {
          id: `loc_${Date.now()}`,
          name: hit.name,
          lat: hit.lat,
          lon: hit.lon
        };
        state.savedLocations.unshift(newLoc);
        saveLocations();
        closeLocationModal();
        switchActiveLocation(newLoc, { fly: true });
      });
    });
  } catch {
    resEl.innerHTML = `<div class="alert-meta">Search failed — check connection.</div>`;
  }
}

function openSiteModal() {
  document.getElementById('site-search-input').value = '';
  renderSiteList();
  document.getElementById('site-modal')?.classList.remove('hidden');
}

function renderSiteList() {
  const list = document.getElementById('site-list');
  const q = (document.getElementById('site-search-input')?.value || '').trim().toLowerCase();
  if (!list) return;
  const sorted = getStationsSortedByDistance(state.activeLocation.lat, state.activeLocation.lon);
  const filtered = q
    ? sorted.filter((s) => s.id.toLowerCase().includes(q) || s.name.toLowerCase().includes(q) || s.state.toLowerCase().includes(q))
    : sorted.slice(0, 30);

  list.innerHTML = filtered.map((st) => `
    <div class="loc-item ${st.id === state.selectedRadarSite ? 'active' : ''}" data-pick-site="${st.id}">
      <div>
        <div class="loc-item-name">${st.id} — ${escapeHtml(st.name)}, ${st.state}</div>
        <div class="loc-item-sub">${st.distanceMi.toFixed(0)} miles away</div>
      </div>
      ${st.id === state.selectedRadarSite ? '<span class="badge-cyan">Active</span>' : ''}
    </div>
  `).join('');

  list.querySelectorAll('[data-pick-site]').forEach((row) => {
    row.addEventListener('click', () => {
      state.selectedRadarSite = row.dataset.pickSite;
      document.getElementById('site-modal')?.classList.add('hidden');
      const st = sorted.find((x) => x.id === state.selectedRadarSite);
      if (st) radarMap.flyTo(st.lat, st.lon, 7.6);
      if (state.settings.radarProduct === 'CONUS_MOSAIC') {
        void selectRadarProduct('N0B');
      } else {
        void loadRadarFramesForCurrentProduct();
      }
      updateHeaderAndBadges();
    });
  });
}
