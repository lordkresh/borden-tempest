import {
  RADAR_PRODUCTS,
  buildRadarFrames,
  fetchIemStormIntel,
  fetchNwsAfd,
  fetchNwsAlerts,
  fetchNwsPointBundle,
  fetchOpenMeteo,
  fetchSpcOverlayLayer,
  fetchWpcFloodOutlook,
  searchLocations
} from './weatherApi.js';
import {
  analyzeEnvironment,
  analyzeStormCells,
  analyzeWinterSuite,
  classifyNwsAlert,
  evaluateMultiDayOutlooks,
  resolveCurrentConditions,
  wmoInfo
} from './analyzers.js';
import { findNearestNexradStation, getStationsSortedByDistance } from './nexradStations.js';
import { degToCompass, geometryCentroid, haversineMiles, initialBearingDeg } from './geoMath.js';
import { RadarMapController } from './radarMap.js';
import { SIREN_CATALOG, audioEngine } from './audio.js';
import { APP_LOCAL_VERSION, updater } from './updater.js';

const STORAGE_KEY_SETTINGS = 'borden_tempest_ios_settings_v2';
const STORAGE_KEY_LOCATIONS = 'borden_tempest_ios_locations_v1';
const STORAGE_KEY_NOTIFIED = 'borden_tempest_ios_notified_v2';
const STORAGE_KEY_SNAPSHOT = 'borden_tempest_ios_snapshot_v1';

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
  radarOpacity: 0.78,
  basemap: 'dark'
};

const DEFAULT_LOCATION = {
  id: 'default_booneville',
  name: 'Booneville, MS',
  lat: 34.6581,
  lon: -88.5667
};

const state = {
  tab: 'dashboard',
  settings: loadJson(STORAGE_KEY_SETTINGS, DEFAULT_SETTINGS),
  savedLocations: loadJson(STORAGE_KEY_LOCATIONS, [DEFAULT_LOCATION]),
  activeLocation: null,
  selectedRadarSite: null,
  isLoading: false,
  lastUpdated: null,
  nwsBundle: null,
  openMeteo: null,
  current: null,
  environment: null,
  winter: null,
  localAlerts: [],
  regionalAlerts: [],
  stormCells: [],
  iemIntel: null,
  multiDaySpc: null,
  afd: null,
  activePlayingSoundId: null,
  isStormWatchActive: false,
  pollTimerId: null,
  wakeLockSentinel: null,
  notifiedMap: loadNotifiedMap()
};

state.activeLocation = state.savedLocations[0] || DEFAULT_LOCATION;

const radarMap = new RadarMapController('radar-map-container', {
  onFrameChange: (fr, idx, total) => {
    const timeEl = document.getElementById('radar-frame-time');
    const feedEl = document.getElementById('radar-feed-tag');
    const scrub = document.getElementById('radar-scrubber');
    if (scrub) {
      scrub.max = Math.max(0, total - 1);
      scrub.value = idx;
    }
    if (timeEl) timeEl.textContent = fr ? fr.label : 'No radar frames';
    if (feedEl) feedEl.textContent = fr ? fr.feedLabel : 'IEM';
  },
  onInspectCell: (cell) => openInspectSheet('cell', cell),
  onInspectAlert: (alert) => openInspectSheet('alert', alert),
  onInspectLsr: (lsr) => openInspectSheet('lsr', lsr)
});

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return Array.isArray(fallback) ? [...fallback] : { ...fallback };
    const parsed = JSON.parse(raw);
    return Array.isArray(fallback) ? parsed : { ...fallback, ...parsed };
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

function saveSettings() {
  localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(state.settings));
}

function saveLocations() {
  localStorage.setItem(STORAGE_KEY_LOCATIONS, JSON.stringify(state.savedLocations));
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

/* ==================== ADAPTIVE POLLING ==================== */
function evaluateStormWatchState() {
  const hasCriticalOrSevere = state.localAlerts.some((a) => a.tier === 'CRITICAL' || a.tier === 'SEVERE' || a.tier === 'WATCH');
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
  if (state.pollTimerId) clearTimeout(state.pollTimerId);
  const intervalMs = (state.settings.adaptiveStormModeEnabled && state.isStormWatchActive)
    ? 45000   // 45 seconds in Active Storm Watch
    : 180000; // 3 minutes in normal weather

  state.pollTimerId = setTimeout(() => {
    if (!document.hidden) {
      refreshAllData(true);
    } else {
      scheduleNextPoll();
    }
  }, intervalMs);
}

/* ==================== BOOTSTRAP ==================== */
document.addEventListener('DOMContentLoaded', () => {
  const unlockOnce = () => {
    audioEngine.unlockForIOS();
    syncWakeLock();
    window.removeEventListener('touchstart', unlockOnce);
    window.removeEventListener('click', unlockOnce);
  };
  window.addEventListener('touchstart', unlockOnce, { passive: true });
  window.addEventListener('click', unlockOnce, { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      syncWakeLock();
      // Refresh immediately if returning after > 60s
      if (!state.lastUpdated || Date.now() - state.lastUpdated.getTime() > 60000) {
        refreshAllData(true);
      }
    } else {
      radarMap.stopPlayback();
      const playBtn = document.getElementById('btn-radar-play');
      if (playBtn) playBtn.textContent = '▶';
    }
  });

  audioEngine.onStateChange = (playingId) => {
    state.activePlayingSoundId = playingId;
    document.getElementById('btn-siren-stop')?.classList.toggle('hidden', !playingId);
    if (state.tab === 'settings') renderSettings();
  };

  wireEvents();
  checkIosInstallBanner();
  const hydrated = hydrateFromSnapshot();

  updater.init((manifest) => {
    const banner = document.getElementById('update-banner');
    if (banner) {
      document.getElementById('update-banner-title').textContent =
        `Tempest v${manifest?.versionName || 'New'} Ready`;
      document.getElementById('update-banner-sub').textContent =
        manifest?.releaseNotes ? manifest.releaseNotes.slice(0, 88) + '…' : 'Tap Update to install instantly.';
      banner.classList.remove('hidden');
    }
    if (state.tab === 'settings') renderSettings();
  });

  refreshAllData(hydrated);
});

function checkIosInstallBanner() {
  const el = document.getElementById('ios-install-banner');
  if (!el) return;
  const hiddenThisSession = sessionStorage.getItem('tempest_hide_ios_tip') === '1';
  if (!updater.isStandalone() && !hiddenThisSession) {
    el.classList.remove('hidden');
  }
}

function wireEvents() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.getElementById('btn-refresh')?.addEventListener('click', () => refreshAllData(false));
  document.getElementById('btn-gps')?.addEventListener('click', requestGpsLocation);
  document.getElementById('btn-siren-stop')?.addEventListener('click', () => {
    audioEngine.stop();
    stopVoiceBriefing();
  });
  document.getElementById('location-picker-trigger')?.addEventListener('click', openLocationModal);
  document.getElementById('telemetry-ribbon')?.addEventListener('click', () => {
    switchTab(state.localAlerts.length ? 'alerts' : 'radar');
  });

  // Session-only hide so users never permanently lose the Safari Home Screen tip before installing
  document.getElementById('btn-dismiss-ios-banner')?.addEventListener('click', () => {
    sessionStorage.setItem('tempest_hide_ios_tip', '1');
    document.getElementById('ios-install-banner')?.classList.add('hidden');
  });

  document.getElementById('btn-install-update')?.addEventListener('click', () => {
    showToast('Installing latest Tempest update...');
    updater.applyUpdateNow();
  });

  document.querySelectorAll('#radar-product-chips .radar-chip').forEach((chip) => {
    chip.addEventListener('click', () => selectRadarProduct(chip.dataset.product));
  });

  document.querySelectorAll('#radar-quick-flip .qflip-btn').forEach((btn) => {
    btn.addEventListener('click', () => selectRadarProduct(btn.dataset.qflip));
  });

  document.querySelectorAll('#spc-mode-row .spc-mode-btn').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.spcLayer) === (state.settings.spcOverlayLayerId || 1));
    btn.addEventListener('click', () => selectSpcOverlayLayer(Number(btn.dataset.spcLayer)));
  });

  document.getElementById('btn-close-afd-modal')?.addEventListener('click', () => {
    document.getElementById('afd-modal')?.classList.add('hidden');
  });
  document.getElementById('afd-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'afd-modal') document.getElementById('afd-modal').classList.add('hidden');
  });

  document.getElementById('btn-radar-play')?.addEventListener('click', () => {
    const playing = radarMap.togglePlayback();
    document.getElementById('btn-radar-play').textContent = playing ? '⏸' : '▶';
  });
  document.getElementById('btn-radar-speed')?.addEventListener('click', () => {
    const sp = radarMap.toggleSpeed();
    document.getElementById('btn-radar-speed').textContent = `${sp}x`;
  });
  document.getElementById('radar-scrubber')?.addEventListener('input', (e) => {
    radarMap.stopPlayback();
    document.getElementById('btn-radar-play').textContent = '▶';
    radarMap.scrubTo(Number(e.target.value));
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

  ['alerts', 'cells', 'watches', 'spc', 'flood', 'mcd', 'lsr'].forEach((key) => {
    document.getElementById(`layer-${key}`)?.addEventListener('change', async (e) => {
      radarMap.setLayerVisibility(key, e.target.checked);
      if (key === 'flood' && e.target.checked && !state.iemIntel?.wpcFloodGeoJson?.features?.length) {
        const wpcFloodGeoJson = await fetchWpcFloodOutlook();
        state.iemIntel = { ...(state.iemIntel || {}), wpcFloodGeoJson };
        radarMap.setOverlayData({ wpcFloodGeoJson });
      }
    });
  });

  const opSlider = document.getElementById('radar-opacity-slider');
  if (opSlider) {
    opSlider.value = Math.round(state.settings.radarOpacity * 100);
    document.getElementById('radar-opacity-val').textContent = `${opSlider.value}%`;
    opSlider.addEventListener('input', (e) => {
      const pct = Number(e.target.value);
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
    audioEngine.stop();
    stopVoiceBriefing();
    document.getElementById('alert-popup-modal')?.classList.add('hidden');
  });
  document.getElementById('btn-alert-popup-radar')?.addEventListener('click', () => {
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
    ensureRadarReady();
  } else if (tabName === 'alerts') {
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

    state.nwsBundle = snap.nwsBundle || null;
    state.openMeteo = snap.openMeteo || null;
    state.current = snap.current || null;
    state.environment = snap.environment || null;
    state.winter = snap.winter || null;
    state.localAlerts = snap.localAlerts || [];
    state.regionalAlerts = snap.regionalAlerts || [];
    state.stormCells = snap.stormCells || [];
    state.multiDaySpc = snap.multiDaySpc || null;
    state.afd = snap.afd || null;
    if (snap.selectedRadarSite) state.selectedRadarSite = snap.selectedRadarSite;
    state.lastUpdated = snap.savedAt ? new Date(snap.savedAt) : null;

    evaluateStormWatchState();
    updateHeaderAndBadges();
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
      observations: (state.nwsBundle.observations || []).slice(0, 2)
    } : null;
    const compactSnap = {
      locId: state.activeLocation.id,
      savedAt: Date.now(),
      selectedRadarSite: state.selectedRadarSite,
      nwsBundle: compactBundle,
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

/* ==================== DATA SYNC ==================== */
async function refreshAllData(silent = false) {
  if (state.isLoading) return;
  state.isLoading = true;
  const force = !silent;
  const refBtn = document.getElementById('btn-refresh');
  if (!silent) refBtn?.classList.add('spinning');

  const { lat, lon } = state.activeLocation;
  const nearest = findNearestNexradStation(lat, lon);
  if (!state.selectedRadarSite) {
    state.selectedRadarSite = nearest.id;
  }

  document.getElementById('header-location-name').textContent = state.activeLocation.name;
  if (!silent && !state.current) {
    document.getElementById('header-status-sub').textContent = 'Syncing NWS, HRRR/GFS & NEXRAD...';
  }

  const includeFlood = Boolean(document.getElementById('layer-flood')?.checked);

  try {
    const [nwsRes, omRes, iemRes] = await Promise.allSettled([
      fetchNwsPointBundle(lat, lon, force),
      fetchOpenMeteo(lat, lon),
      fetchIemStormIntel(state.settings.spcOverlayLayerId || 1, { includeFlood, force })
    ]);

    state.nwsBundle = nwsRes.status === 'fulfilled' ? nwsRes.value : state.nwsBundle;
    state.openMeteo = omRes.status === 'fulfilled' ? omRes.value : state.openMeteo;
    state.iemIntel = iemRes.status === 'fulfilled' ? iemRes.value : state.iemIntel;

    if (state.nwsBundle?.cityLabel && state.activeLocation.id === 'gps_current') {
      state.activeLocation.name = `${state.nwsBundle.cityLabel} (GPS)`;
    }

    const [alertsRes, afdRes] = await Promise.all([
      fetchNwsAlerts(lat, lon, state.nwsBundle?.stateCode).catch(() => ({
        localFeatures: [],
        regionalFeatures: []
      })),
      fetchNwsAfd(state.nwsBundle?.cwa, force).catch(() => null)
    ]);
    state.afd = afdRes || state.afd;
    state.multiDaySpc = evaluateMultiDayOutlooks(lat, lon, state.iemIntel);

    const sortAlerts = (a, b) => {
      if (b.rank !== a.rank) return b.rank - a.rank;
      const aIn = a.insidePolygon === true ? 1 : 0;
      const bIn = b.insidePolygon === true ? 1 : 0;
      return bIn - aIn;
    };

    state.localAlerts = (alertsRes.localFeatures || [])
      .map((f) => classifyNwsAlert(f, lat, lon))
      .filter((a) => !a.isExpired)
      .sort(sortAlerts);

    state.regionalAlerts = (alertsRes.regionalFeatures || [])
      .map((f) => classifyNwsAlert(f, lat, lon))
      .filter((a) => !a.isExpired)
      .sort(sortAlerts);

    state.current = resolveCurrentConditions(state.nwsBundle, state.openMeteo);
    const mcdCount = state.iemIntel?.mcdGeoJson?.features?.length || 0;
    state.environment = analyzeEnvironment(state.openMeteo, state.current, mcdCount, {
      convectiveAlertThreshold: state.settings.convectiveAlertThreshold,
      nocturnalReadinessEnabled: state.settings.nocturnalReadinessEnabled
    });
    state.winter = analyzeWinterSuite(state.openMeteo, state.current, state.settings.groundFreezeThresholdF);
    state.stormCells = analyzeStormCells(state.iemIntel?.stormCellsGeoJson, lat, lon, 120);
    state.lastUpdated = new Date();

    evaluateStormWatchState();
    updateHeaderAndBadges();
    updateTelemetryRibbon();
    updateRadarStormHud();
    renderDashboard();
    renderAlerts();
    saveSnapshot();
    if (state.tab === 'settings') renderSettings();

    radarMap.setUserLocation(lat, lon);
    radarMap.setOverlayData({
      alerts: state.regionalAlerts,
      stormCells: state.stormCells,
      lsrGeoJson: state.iemIntel?.lsrGeoJson,
      mcdGeoJson: state.iemIntel?.mcdGeoJson,
      spcWatchesGeoJson: state.iemIntel?.spcWatchesGeoJson,
      wpcFloodGeoJson: state.iemIntel?.wpcFloodGeoJson,
      spcDay1GeoJson: state.iemIntel?.spcOverlayGeoJson || state.iemIntel?.spcDay1GeoJson
    });

    if (state.tab === 'radar') {
      loadRadarFramesForCurrentProduct();
    }

    checkAllLiveAlertTriggers();
    if (!silent) showToast('Weather, radar & severe intel updated');
  } catch (err) {
    document.getElementById('header-status-sub').textContent = 'Offline or partial feed — tap refresh';
    if (!silent) showToast(`Sync error: ${err.message || 'Check connection'}`);
    scheduleNextPoll();
  } finally {
    state.isLoading = false;
    refBtn?.classList.remove('spinning');
  }
}

function updateHeaderAndBadges() {
  document.getElementById('header-location-name').textContent = state.activeLocation.name;
  const clock = state.lastUpdated ? state.lastUpdated.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '--';
  const site = state.selectedRadarSite || findNearestNexradStation(state.activeLocation.lat, state.activeLocation.lon).id;
  const watchTag = (state.settings.adaptiveStormModeEnabled && state.isStormWatchActive) ? '⚡ STORM WATCH (45s) • ' : '';
  document.getElementById('header-status-sub').textContent = `${watchTag}Updated ${clock} • Radar ${site} • v${APP_LOCAL_VERSION.versionName}`;

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
    txt.textContent = `TVS ${tvsCells.length} · ${tvsCells[0].intercept.distanceMi.toFixed(0)} mi`;
  } else if (supCells.length) {
    pill.classList.add('hud-supercell');
    txt.textContent = `${supCells.length} Sup · ${supCells[0].intercept.distanceMi.toFixed(0)} mi ${supCells[0].moveToCompass}`;
  } else if (svrCells.length) {
    pill.classList.add('hud-severe');
    txt.textContent = `${svrCells.length} Svr · ${svrCells[0].intercept.distanceMi.toFixed(0)} mi`;
  } else if (cells.length) {
    txt.textContent = `${cells.length} Cell${cells.length > 1 ? 's' : ''} · ${cells[0].intercept.distanceMi.toFixed(0)} mi`;
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

  // 1. CRITICAL NWS Alerts (Tornado Warning, Tornado Emergency, Flash Flood Emergency) — ALWAYS active
  const topCritical = state.localAlerts.find((a) => a.tier === 'CRITICAL');
  if (topCritical && !hasBeenNotified(`nws_${topCritical.id}`, topCritical.escalationFingerprint)) {
    markNotified(`nws_${topCritical.id}`, topCritical.escalationFingerprint);
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
      loop: topCritical.isTornadoEmergency || topCritical.isPdsOrObserved
    });
    return;
  }

  // 2. SEVERE NWS Alerts (Severe Thunderstorm Warning, Flash Flood Warning, Snow Squall Warning)
  if (s.severeWarningAlertsEnabled) {
    const topSevere = state.localAlerts.find((a) => a.tier === 'SEVERE');
    if (topSevere && !hasBeenNotified(`nws_${topSevere.id}`, topSevere.escalationFingerprint)) {
      markNotified(`nws_${topSevere.id}`, topSevere.escalationFingerprint);
      const badge = topSevere.isDestructiveSevere ? 'DESTRUCTIVE SEVERE WARNING' : 'SEVERE WARNING';
      triggerAlertPopup({
        badge,
        title: topSevere.event,
        body: `${topSevere.insidePolygon === true ? 'INSIDE WARNING POLYGON\n' : ''}${topSevere.headline}\n\n${topSevere.instruction || topSevere.areaDesc}`,
        soundId: 'svr_tstorm_alarm',
        loop: false
      });
      return;
    }
  }

  // 3. Proactive NEXRAD Storm Cell Time-on-Target (TOT) Intercept
  if (s.proactiveTotAlertsEnabled) {
    const leadMin = s.proactiveTotLeadMinutes || 35;
    const incoming = state.stormCells.find((c) =>
      c.threatScore >= 2 &&
      (c.intercept.verdict === 'DIRECT_INTERCEPT' || c.intercept.verdict === 'NEAR_MISS') &&
      c.intercept.etaMinutes != null &&
      c.intercept.etaMinutes <= leadMin
    );
    if (incoming) {
      const fp = `${incoming.threatLevel}_${incoming.intercept.verdict}`;
      if (!hasBeenNotified(`cell_${incoming.id}`, fp)) {
        markNotified(`cell_${incoming.id}`, fp);
        const isRot = incoming.threatLevel === 'TORNADO_TVS' || incoming.threatLevel === 'SUPERCELL';
        triggerAlertPopup({
          badge: incoming.tvs ? 'TVS STORM INTERCEPT' : isRot ? 'ROTATING SUPERCELL TOT' : 'APPROACHING SEVERE CELL',
          title: `Cell ${incoming.stormId} • ETA ~${incoming.intercept.etaMinutes} min`,
          body: `${incoming.intercept.distanceMi.toFixed(1)} mi ${incoming.intercept.compassFromUser} moving ${incoming.moveToCompass} @ ${incoming.speedMph} mph\n${incoming.intercept.verdictLabel}${incoming.maxHailIn ? ` • Hail ${incoming.maxHailIn}"` : ''}\n\nProactive Borden Tempest radar-cell tracking — open Radar to verify Velocity (N0G) & CC Debris (N0C).`,
          soundId: isRot ? 'supercell_alert_alarm' : 'storm_tot_ping',
          loop: false
        });
        return;
      }
    }
  }

  // 4. Convective / HSLC / Nocturnal Environment Alerts
  if (s.convectiveAlertsEnabled && state.environment?.proactiveAlerts?.length) {
    const ca = state.environment.proactiveAlerts[0];
    const hourBucket = new Date().toISOString().slice(0, 13); // dedupe per 1-hour window per regime
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

  // 5. Winter / Black Ice / Freezing Fog Alerts
  if (s.winterAlertsEnabled && state.winter?.winterAlerts?.length) {
    const wa = state.winter.winterAlerts.find((w) => w.severity === 'high') || state.winter.winterAlerts[0];
    if (wa && wa.severity === 'high') {
      const hourBucket = new Date().toISOString().slice(0, 13);
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

function requestGpsLocation() {
  if (!navigator.geolocation) {
    showToast('GPS is unavailable on this browser.');
    return;
  }
  showToast('Requesting GPS location...');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      const nearest = findNearestNexradStation(lat, lon);
      state.activeLocation = { id: 'gps_current', name: 'Current Location (GPS)', lat, lon };
      state.selectedRadarSite = nearest.id;
      radarMap.flyTo(lat, lon, 8.2, true);
      refreshAllData();
    },
    () => showToast('Location permission denied — tap the city name to search manually.'),
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

/* ==================== RADAR ==================== */
async function ensureRadarReady() {
  const { lat, lon } = state.activeLocation;
  const nearest = findNearestNexradStation(lat, lon);
  if (!state.selectedRadarSite) state.selectedRadarSite = nearest.id;
  document.getElementById('radar-site-label').textContent = `Site: ${state.selectedRadarSite}`;

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
  radarMap.setOverlayData({
    alerts: state.regionalAlerts,
    stormCells: state.stormCells,
    lsrGeoJson: state.iemIntel?.lsrGeoJson,
    mcdGeoJson: state.iemIntel?.mcdGeoJson,
    spcWatchesGeoJson: state.iemIntel?.spcWatchesGeoJson,
    wpcFloodGeoJson: state.iemIntel?.wpcFloodGeoJson,
    spcDay1GeoJson: state.iemIntel?.spcOverlayGeoJson || state.iemIntel?.spcDay1GeoJson
  });
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
  const geo = await fetchSpcOverlayLayer(layerId);
  if (state.iemIntel) state.iemIntel.spcOverlayGeoJson = geo;
  radarMap.setOverlayData({ spcDay1GeoJson: geo });
}

async function loadRadarFramesForCurrentProduct() {
  const prod = state.settings.radarProduct || 'CONUS_MOSAIC';
  const site = state.selectedRadarSite || findNearestNexradStation(state.activeLocation.lat, state.activeLocation.lon).id;
  document.getElementById('radar-site-label').textContent = `Site: ${site}`;
  if (!radarMap.frames?.length || radarMap.productCode !== prod) {
    document.getElementById('radar-frame-time').textContent = 'Loading radar scans...';
  }
  const frames = await buildRadarFrames(prod, site);
  radarMap.setFrames(frames, prod);
  const playBtn = document.getElementById('btn-radar-play');
  if (playBtn) playBtn.textContent = radarMap.playing ? '⏸' : '▶';
}

function openInspectSheet(type, item) {
  document.getElementById('radar-layers-sheet')?.classList.add('hidden');
  const sheet = document.getElementById('radar-inspect-sheet');
  const titleEl = document.getElementById('inspect-title');
  const bodyEl = document.getElementById('inspect-body');
  if (!sheet || !titleEl || !bodyEl) return;

  if (type === 'cell') {
    titleEl.textContent = `Storm Cell ${item.stormId} (${item.nexrad})`;
    const radarConfirmText = item.confirmingRadars?.length > 1
      ? `Confirmed by ${item.confirmingRadars.length} radars: ${item.confirmingRadars.join(' · ')}`
      : `Single-site radar: ${item.nexrad}`;
    bodyEl.innerHTML = `
      <div class="tag-row">
        <span class="badge-${item.tvs ? 'red' : item.meso ? 'magenta' : item.threatScore >= 2 ? 'amber' : 'muted'}">${item.threatLevel.replace('_', ' ')}</span>
        ${item.tvs ? `<span class="badge-red">TVS: ${escapeHtml(item.tvs)}</span>` : ''}
        ${item.meso ? `<span class="badge-magenta">MESO RANK ${escapeHtml(item.meso)}</span>` : ''}
        ${item.maxHailIn > 0 ? `<span class="badge-amber">Hail ${item.maxHailIn}"</span>` : ''}
      </div>
      <div class="cell-motion-banner">
        <span>${escapeHtml(item.motionSummary || `Moving ${item.moveToCompass} @ ${item.speedMph} mph`)}</span>
        <span>${item.intercept.distanceMi.toFixed(1)} mi ${item.intercept.compassFromUser}</span>
      </div>
      <div class="cell-proof-grid">
        <div class="cell-proof-item">
          <div class="cell-proof-k">VIL</div>
          <div class="cell-proof-v">${item.vil ?? 0}</div>
        </div>
        <div class="cell-proof-item">
          <div class="cell-proof-k">Echo Top</div>
          <div class="cell-proof-v">${item.topKft ? `${item.topKft}k` : '--'}</div>
        </div>
        <div class="cell-proof-item">
          <div class="cell-proof-k">Max dBZ</div>
          <div class="cell-proof-v">${item.maxDbz || '--'}</div>
        </div>
        <div class="cell-proof-item">
          <div class="cell-proof-k">Hail Prob</div>
          <div class="cell-proof-v">${item.posh ?? 0}%</div>
        </div>
      </div>
      <div class="alert-meta" style="margin-top:8px;">
        <strong>Intercept:</strong> ${escapeHtml(item.intercept.verdictLabel)}${item.intercept.etaMinutes ? ` • <strong>TOT ~${item.intercept.etaMinutes} min</strong>` : ''}<br/>
        <strong>Radar Verification:</strong> ${escapeHtml(radarConfirmText)}${item.radarRangeMi ? ` • ${item.radarRangeMi} mi from ${escapeHtml(item.nexrad)}` : ''}
      </div>
    `;
  } else if (type === 'lsr') {
    const p = item.properties || {};
    const [lon, lat] = item.coords || [state.activeLocation.lon, state.activeLocation.lat];
    const distMi = haversineMiles(state.activeLocation.lat, state.activeLocation.lon, lat, lon);
    const brg = degToCompass(initialBearingDeg(state.activeLocation.lat, state.activeLocation.lon, lat, lon));
    const evType = p.typetext || p.type || 'Storm Report';
    const mag = p.magnitude ? ` • ${p.magnitude}${p.unit ? ' ' + p.unit : ''}` : '';
    const isTor = String(evType).toUpperCase().includes('TORNADO') || String(evType).toUpperCase().includes('FUNNEL');
    titleEl.textContent = `${evType}${mag}`;
    bodyEl.innerHTML = `
      <div class="tag-row">
        <span class="badge-${isTor ? 'red' : 'amber'}">CONFIRMED SPOTTER REPORT (LSR)</span>
        <span class="badge-cyan">${distMi.toFixed(1)} mi ${brg}</span>
      </div>
      <div class="alert-meta">
        <strong>Location:</strong> ${escapeHtml(p.city || 'Nearby')}, ${escapeHtml(p.state || p.st || '')}<br/>
        <strong>Reported:</strong> ${escapeHtml(p.valid || p.utcvalid || 'Recent')}<br/><br/>
        ${escapeHtml(p.remark || 'Verified NWS Local Storm Report.')}
      </div>
    `;
  } else {
    const ctr = item.geometry ? geometryCentroid(item.geometry) : null;
    const rangeTag = ctr
      ? `${haversineMiles(state.activeLocation.lat, state.activeLocation.lon, ctr.lat, ctr.lon).toFixed(1)} mi ${degToCompass(initialBearingDeg(state.activeLocation.lat, state.activeLocation.lon, ctr.lat, ctr.lon))}`
      : null;
    titleEl.textContent = item.event;
    bodyEl.innerHTML = `
      <div class="tag-row">
        <span class="badge-${item.tier === 'CRITICAL' ? 'red' : item.tier === 'WINTER' ? 'blue' : 'amber'}">${item.isTornadoEmergency ? 'TORNADO EMERGENCY' : item.tier}</span>
        ${rangeTag ? `<span class="badge-cyan">${rangeTag}</span>` : ''}
        ${item.insidePolygon === true ? `<span class="badge-red">INSIDE POLYGON</span>` : ''}
        ${item.tornadoDetection ? `<span class="badge-red">Tornado: ${escapeHtml(item.tornadoDetection)}</span>` : ''}
        ${item.tornadoDamageThreat ? `<span class="badge-red">Damage: ${escapeHtml(item.tornadoDamageThreat)}</span>` : ''}
        ${item.maxWindGust ? `<span class="badge-amber">Wind: ${escapeHtml(item.maxWindGust)}</span>` : ''}
        ${item.maxHailSize ? `<span class="badge-amber">Hail: ${escapeHtml(item.maxHailSize)}"</span>` : ''}
      </div>
      ${item.stormMotion ? `<div class="cell-motion-banner"><span>${escapeHtml(item.stormMotion.summary)}</span><span>NWS Vector</span></div>` : ''}
      <div class="alert-meta" style="margin-top:8px;">
        <strong>${escapeHtml(item.headline)}</strong><br/><br/>
        ${escapeHtml((item.instruction || item.description || '').slice(0, 520))}
      </div>
    `;
  }
  sheet.classList.remove('hidden');
}

/* ==================== GRAPHICS & TELEMETRY HELPERS ==================== */
let _svgUid = 0;

function skyAtmosphereClass(condText, isNight) {
  const s = String(condText || '').toLowerCase();
  if (s.includes('thunder') || s.includes('storm') || s.includes('tornado')) return 'cond-storm';
  if (s.includes('snow') || s.includes('sleet') || s.includes('ice') || s.includes('blizzard') || s.includes('freezing')) return 'cond-winter';
  if (s.includes('rain') || s.includes('shower') || s.includes('drizzle')) return 'cond-rain';
  if (s.includes('overcast') || s.includes('mostly cloudy') || s.includes('fog') || s.includes('haze') || s.includes('mist')) return 'cond-cloud';
  return isNight ? 'cond-night' : 'cond-clear';
}

function renderWeatherGraphicSvg(conditionText, isNight = false, size = 76) {
  const s = String(conditionText || '').toLowerCase();
  const uid = `wg${++_svgUid}`;
  const isStorm = s.includes('thunder') || s.includes('t-storm') || s.includes('storm');
  const isSnow = s.includes('snow') || s.includes('sleet') || s.includes('ice') || s.includes('flur');
  const isRain = !isStorm && (s.includes('rain') || s.includes('shower') || s.includes('drizzle'));
  const isFog = s.includes('fog') || s.includes('mist') || s.includes('haze');
  const isPartly = s.includes('partly') || s.includes('mostly clear') || s.includes('few') || s.includes('scattered') || s.includes('mostly sunny');
  const isOvercast = s.includes('overcast') || s.includes('cloudy');

  const sunOrb = `
    <defs>
      <radialGradient id="${uid}_sun" cx="42%" cy="38%" r="58%">
        <stop offset="0%" stop-color="#fef08a"/>
        <stop offset="55%" stop-color="#facc15"/>
        <stop offset="100%" stop-color="#f97316"/>
      </radialGradient>
    </defs>
    <circle cx="32" cy="32" r="22" fill="#facc15" opacity="0.18"/>
    <circle cx="32" cy="32" r="14.5" fill="url(#${uid}_sun)"/>
  `;

  const moonOrb = `
    <circle cx="33" cy="30" r="19" fill="#818cf8" opacity="0.16"/>
    <path d="M36 16a14 14 0 1 0 13 18.5A11.5 11.5 0 0 1 36 16Z" fill="#e2e8f0" stroke="#93c5fd" stroke-width="1"/>
    <circle cx="46" cy="20" r="1.4" fill="#fde68a"/>
    <circle cx="20" cy="22" r="1.1" fill="#bae6fd"/>
  `;

  const cloudShape = (fill = '#cbd5e1', yOff = 0) => `
    <path d="M22 ${44 + yOff}h23a9 9 0 0 0 1.4-17.9A12.5 12.5 0 0 0 22.8 29a8.2 8.2 0 0 0-.8 15Z" fill="${fill}" opacity="0.96"/>
  `;

  let body = '';
  if (isStorm) {
    body = `
      ${cloudShape('#64748b', -4)}
      ${cloudShape('#94a3b8', 0)}
      <polygon points="34,40 27,51 33,51 29,60 40,48 34,48" fill="#facc15" stroke="#fef08a" stroke-width="0.6" stroke-linejoin="round"/>
      <line x1="21" y1="47" x2="18" y2="55" stroke="#38bdf8" stroke-width="2.4" stroke-linecap="round"/>
      <line x1="45" y1="47" x2="42" y2="55" stroke="#38bdf8" stroke-width="2.4" stroke-linecap="round"/>
    `;
  } else if (isSnow) {
    body = `
      ${cloudShape('#cbd5e1', -4)}
      <circle cx="24" cy="50" r="2.2" fill="#e0f2fe"/>
      <circle cx="33" cy="53" r="2.4" fill="#bae6fd"/>
      <circle cx="42" cy="50" r="2.2" fill="#e0f2fe"/>
      <circle cx="29" cy="46" r="1.8" fill="#ffffff"/>
      <circle cx="38" cy="46" r="1.8" fill="#ffffff"/>
    `;
  } else if (isRain) {
    body = `
      ${cloudShape('#94a3b8', -4)}
      <line x1="23" y1="44" x2="19.5" y2="54" stroke="#38bdf8" stroke-width="2.5" stroke-linecap="round"/>
      <line x1="33" y1="45" x2="29.5" y2="56" stroke="#00d4ff" stroke-width="2.5" stroke-linecap="round"/>
      <line x1="43" y1="44" x2="39.5" y2="54" stroke="#38bdf8" stroke-width="2.5" stroke-linecap="round"/>
    `;
  } else if (isFog) {
    body = `
      ${cloudShape('#94a3b8', -6)}
      <line x1="16" y1="44" x2="48" y2="44" stroke="#94a3b8" stroke-width="2.6" stroke-linecap="round"/>
      <line x1="20" y1="50" x2="44" y2="50" stroke="#64748b" stroke-width="2.6" stroke-linecap="round"/>
    `;
  } else if (isPartly) {
    body = isNight
      ? `<g transform="translate(8,-4) scale(0.78)">${moonOrb}</g>${cloudShape('#e2e8f0', 2)}`
      : `<g transform="translate(9,-4) scale(0.76)">${sunOrb}</g>${cloudShape('#e2e8f0', 2)}`;
  } else if (isOvercast) {
    body = `${cloudShape('#94a3b8', -5)}${cloudShape('#cbd5e1', 2)}`;
  } else {
    body = isNight
      ? moonOrb
      : `${sunOrb}
         <g stroke="#fde047" stroke-width="2.4" stroke-linecap="round" opacity="0.85">
           <line x1="32" y1="9" x2="32" y2="13"/>
           <line x1="32" y1="51" x2="32" y2="55"/>
           <line x1="9" y1="32" x2="13" y2="32"/>
           <line x1="51" y1="32" x2="55" y2="32"/>
           <line x1="16" y1="16" x2="19" y2="19"/>
           <line x1="45" y1="45" x2="48" y2="48"/>
           <line x1="48" y1="16" x2="45" y2="19"/>
           <line x1="19" y1="45" x2="16" y2="48"/>
         </g>`;
  }

  return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true">${body}</svg>`;
}

function renderWindCompassSvg(windDirDeg, size = 24) {
  const deg = windDirDeg != null && !Number.isNaN(Number(windDirDeg)) ? Number(windDirDeg) : 0;
  return `
    <svg viewBox="0 0 44 44" width="${size}" height="${size}" aria-hidden="true" style="flex-shrink:0;">
      <circle cx="22" cy="22" r="19" fill="rgba(7,13,24,0.65)" stroke="rgba(148,163,184,0.32)" stroke-width="1.4"/>
      <text x="22" y="9" text-anchor="middle" fill="#94a3b8" font-size="7" font-weight="800">N</text>
      <g transform="rotate(${deg} 22 22)">
        <polygon points="22,9 26.5,22 22,19 17.5,22" fill="#00d4ff"/>
        <polygon points="22,35 24.5,22 22,24 19.5,22" fill="#475569"/>
      </g>
      <circle cx="22" cy="22" r="2.3" fill="#f8fafc"/>
    </svg>
  `;
}

function renderPressureArcSvg(pressureHpa, trend3h, width = 30, height = 20) {
  const hpa = pressureHpa != null ? Number(pressureHpa) : 1013;
  const pct = Math.max(0, Math.min(1, (hpa - 980) / 60));
  const angleRad = Math.PI - pct * Math.PI;
  const dx = 24 + 17 * Math.cos(angleRad);
  const dy = 26 - 17 * Math.sin(angleRad);
  const arrow = trend3h > 0.4 ? '▲' : trend3h < -0.4 ? '▼' : '●';
  const arrowCol = trend3h > 0.4 ? '#34d399' : trend3h < -0.4 ? '#ff6b81' : '#94a3b8';
  return `
    <svg viewBox="0 0 48 32" width="${width}" height="${height}" aria-hidden="true" style="flex-shrink:0;">
      <path d="M 7 26 A 17 17 0 0 1 41 26" fill="none" stroke="rgba(148,163,184,0.28)" stroke-width="4" stroke-linecap="round"/>
      <path d="M 7 26 A 17 17 0 0 1 ${dx.toFixed(1)} ${dy.toFixed(1)}" fill="none" stroke="#38bdf8" stroke-width="4" stroke-linecap="round"/>
      <circle cx="${dx.toFixed(1)}" cy="${dy.toFixed(1)}" r="3.4" fill="#f8fafc" stroke="#00d4ff" stroke-width="1.5"/>
      <text x="24" y="27" text-anchor="middle" fill="${arrowCol}" font-size="10" font-weight="800">${arrow}</text>
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
    shield: `<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>`
  };
  return `<span class="section-icon ${tone}"><svg viewBox="0 0 24 24" width="13.5" height="13.5" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">${icons[name] || ''}</svg></span>`;
}

function severityMeter(pct, color) {
  const clamped = Math.max(4, Math.min(100, Math.round(pct)));
  return `<div class="metric-meter"><div class="metric-meter-fill" style="width:${clamped}%;background:${color};"></div></div>`;
}

/* ==================== RENDER: DASHBOARD ==================== */
function renderDashboard() {
  const container = document.getElementById('dashboard-content');
  const strip = document.getElementById('dashboard-alert-strip');
  if (!container || !state.current) return;

  const c = state.current;
  const env = state.environment;
  const win = state.winter;

  const topAlert = state.localAlerts[0];
  const topThreatCell = state.stormCells.find((sc) => sc.threatScore >= 2 && (sc.intercept.verdict === 'DIRECT_INTERCEPT' || sc.tvs));

  if (topAlert) {
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
  } else if (topThreatCell) {
    strip.className = 'alert-strip critical';
    strip.innerHTML = `
      <div>
        <div style="font-size:11px;font-weight:800;letter-spacing:.06em;">STORM CELL INTERCEPT • ${escapeHtml(topThreatCell.threatLevel.replace('_', ' '))}</div>
        <div style="font-size:15px;font-weight:800;margin-top:2px;">Cell ${escapeHtml(topThreatCell.stormId)} • ${topThreatCell.intercept.etaMinutes ? `TOT ~${topThreatCell.intercept.etaMinutes} min` : topThreatCell.intercept.verdictLabel}</div>
        <div style="font-size:12px;opacity:.9;margin-top:2px;">${topThreatCell.intercept.distanceMi.toFixed(1)} mi ${topThreatCell.intercept.compassFromUser} • ${escapeHtml(topThreatCell.motionSummary)}</div>
      </div>
      <span style="font-size:18px;font-weight:800;">›</span>
    `;
    strip.onclick = () => {
      switchTab('radar');
      radarMap.flyTo(topThreatCell.lat, topThreatCell.lon, 9.2, false);
    };
  } else {
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
  const hrNow = new Date().getHours();
  const isNightNow = firstHourDay != null ? !firstHourDay : (hrNow < 6 || hrNow >= 18);
  const atmClass = skyAtmosphereClass(c.conditionText, isNightNow);

  container.innerHTML = `
    <!-- HERO CURRENT CONDITIONS -->
    <div class="card hero-card ${atmClass}">
      <div class="hero-top">
        <div class="hero-temp-wrap">
          <div class="hero-temp">${c.tempF != null ? `${c.tempF}<span class="hero-deg">°</span>` : '--'}</div>
          <div class="hero-cond">${escapeHtml(c.conditionText)}</div>
          <div class="hero-feels">Feels like ${c.feelsLikeF ?? '--'}° • Dewpoint ${c.dewpointF ?? '--'}°F</div>
        </div>
        <div class="hero-right">
          <div class="hero-graphic-stage">
            ${renderWeatherGraphicSvg(c.conditionText, isNightNow, 76)}
          </div>
        </div>
      </div>

      <div class="hero-status-strip">
        <span class="badge-cyan">${c.confidence} Consensus</span>
        <span class="badge-muted">±${c.spreadF}°F spread</span>
        <span class="badge-muted">${nearestRadar.id} · ${nearestRadar.distanceMi.toFixed(0)} mi</span>
      </div>

      <div class="metrics-grid">
        <div class="metric-box">
          <div class="metric-head-row">
            <span class="metric-label">Wind</span>
            ${renderWindCompassSvg(c.windDirDeg, 24)}
          </div>
          <div class="metric-value">${c.windCompass} ${c.windMph} mph</div>
          <div class="metric-sub">${c.gustMph ? `Gusts ${c.gustMph} mph` : 'Steady flow'}</div>
        </div>
        <div class="metric-box">
          <div class="metric-head-row">
            <span class="metric-label">Humidity</span>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="rgba(56,189,248,0.28)" stroke="#38bdf8" stroke-width="2" aria-hidden="true"><path d="M12 2.7C12 2.7 6 9.8 6 14.3a6 6 0 0 0 12 0C18 9.8 12 2.7 12 2.7z"/></svg>
          </div>
          <div class="metric-value">${c.humidity ?? '--'}%</div>
          <div class="metric-sub">Td ${c.dewpointF ?? '--'}° • ${c.visibilityMi} mi</div>
          ${severityMeter(c.humidity ?? 0, '#38bdf8')}
        </div>
        <div class="metric-box">
          <div class="metric-head-row">
            <span class="metric-label">Pressure</span>
            ${renderPressureArcSvg(c.pressureHpa, c.pressureTrend3h, 30, 20)}
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

    <!-- CONVECTIVE & SUPERCELL ENVIRONMENT (PRO 5-LEVEL SOUNDING + STP/SCP/SRH + LIVE HODOGRAPH) -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">${sectionIcon('sounding', env.level === 'high' ? 'amber' : '')}Pro Severe Sounding &amp; HSLC</div>
        <span class="badge-${env.level === 'high' ? 'red' : env.level === 'mod' ? 'amber' : 'green'}">${escapeHtml(env.regime)}</span>
      </div>
      <div class="regime-banner ${env.level}">
        ${escapeHtml(env.nocturnalRisk)}
      </div>
      <div class="metrics-grid">
        <div class="metric-box">
          <div class="metric-label">Sig Tor (STP)</div>
          <div class="metric-value">${(env.stp ?? 0).toFixed(1)}</div>
          <div class="metric-sub">SPC Fixed-Lyr</div>
          ${severityMeter(((env.stp ?? 0) / 3) * 100, (env.stp ?? 0) >= 1 ? '#ff2b4a' : '#10b981')}
        </div>
        <div class="metric-box">
          <div class="metric-label">Supercell (SCP)</div>
          <div class="metric-value">${(env.scp ?? 0).toFixed(1)}</div>
          <div class="metric-sub">0–3km SRH ${env.srh0to3Km ?? 0}</div>
          ${severityMeter(((env.scp ?? 0) / 5) * 100, (env.scp ?? 0) >= 1 ? '#d946ef' : '#38bdf8')}
        </div>
        <div class="metric-box">
          <div class="metric-label">0–1km SRH</div>
          <div class="metric-value">${env.srh0to1Km ?? 0}</div>
          <div class="metric-sub">m²/s² Helicity</div>
          ${severityMeter(((env.srh0to1Km ?? 0) / 300) * 100, (env.srh0to1Km ?? 0) >= 150 ? '#ff9800' : '#00d4ff')}
        </div>
      </div>
      <div class="metrics-grid" style="margin-top:8px;">
        <div class="metric-box">
          <div class="metric-label">CAPE / CIN</div>
          <div class="metric-value">${env.peakCape12h}</div>
          <div class="metric-sub">Now ${env.capeNow} • CIN ${env.cinNow}</div>
        </div>
        <div class="metric-box">
          <div class="metric-label">0–6km Shear</div>
          <div class="metric-value">${env.bulkShear0to6KmKt} kt</div>
          <div class="metric-sub">0–1.5km: ${env.lowLevelShearKt} kt</div>
        </div>
        <div class="metric-box">
          <div class="metric-label">LCL / Lapse</div>
          <div class="metric-value">${env.lclMeters ?? '--'} m</div>
          <div class="metric-sub">7–5mb: ${env.lapseRate700to500 ?? 5.8}°/km</div>
        </div>
      </div>
      <div class="hodograph-wrap">
        <div class="hodograph-head">
          <span style="color:var(--cyan);">LIVE 5-LEVEL HODOGRAPH (KT)</span>
          <span style="color:var(--watch-yellow);">RM ${escapeHtml(env.bunkersCompass || '--')} @ ${env.bunkersSpeedKt ?? 0} kt</span>
        </div>
        <canvas id="hodograph-canvas" class="hodograph-canvas"></canvas>
        <div class="hodograph-foot">
          <div class="hodo-legend">
            <span><i class="hodo-dot" style="background:#ff3d5a"></i>0–1km</span>
            <span><i class="hodo-dot" style="background:#facc15"></i>1–3km</span>
            <span><i class="hodo-dot" style="background:#00d4ff"></i>3–6km</span>
          </div>
          <span>${env.veeringDeg >= 0 ? `+${env.veeringDeg}°` : `${env.veeringDeg}°`} veer • ${state.stormCells.length} verified cell${state.stormCells.length === 1 ? '' : 's'}</span>
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

    <!-- FULL WINTER / GROUND TEMP / FOG SUITE -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">${sectionIcon('winter', 'blue')}Winter, Ground Temp &amp; Fog Suite</div>
        <span class="badge-${win.hazardLevel === 'CRITICAL' ? 'red' : win.hazardLevel === 'CLEAR' ? 'green' : 'blue'}">${escapeHtml(win.statusLabel)}</span>
      </div>
      <div class="regime-banner ${win.hazardLevel === 'CRITICAL' ? 'high' : win.hazardLevel === 'CLEAR' ? 'low' : 'winter'}">
        <strong>Road / Bridge Surface:</strong> ${escapeHtml(win.roadBridgeRiskLabel)}
      </div>
      <div class="metrics-grid cols-2">
        <div class="metric-box">
          <div class="metric-label">Ground Temp (0cm / 6cm)</div>
          <div class="metric-value">${win.ground0cmF ?? '--'}°F / ${win.ground6cmF ?? '--'}°F</div>
          <div class="metric-sub">Freeze trigger ≤ ${state.settings.groundFreezeThresholdF}°F</div>
        </div>
        <div class="metric-box">
          <div class="metric-label">Freezing Level / 24h Low</div>
          <div class="metric-value">${win.freezingLevelFt != null ? `${win.freezingLevelFt.toLocaleString()} ft` : '--'}</div>
          <div class="metric-sub">${win.hoursBelowFreezingNext24h}h ≤ 32°F • Low ${win.minTemp24h ?? '--'}°F</div>
        </div>
      </div>
    </div>

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
  container.querySelector('[data-jump-flood]')?.addEventListener('click', async () => {
    switchTab('radar');
    const chk = document.getElementById('layer-flood');
    if (chk) chk.checked = true;
    radarMap.setLayerVisibility('flood', true);
    if (!state.iemIntel?.wpcFloodGeoJson?.features?.length) {
      const wpcFloodGeoJson = await fetchWpcFloodOutlook();
      state.iemIntel = { ...(state.iemIntel || {}), wpcFloodGeoJson };
      radarMap.setOverlayData({ wpcFloodGeoJson });
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
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const size = 224;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  const ctx = canvas.getContext('2d');
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
  scopeGrad.addColorStop(0, 'rgba(0, 212, 255, 0.09)');
  scopeGrad.addColorStop(0.65, 'rgba(13, 24, 44, 0.45)');
  scopeGrad.addColorStop(1, 'rgba(6, 11, 20, 0.88)');
  ctx.fillStyle = scopeGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, maxR, 0, Math.PI * 2);
  ctx.fill();

  // Dashed speed rings
  const step = maxRing <= 30 ? 10 : 20;
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.24)';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#7c8ea6';
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
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.26)';
  ctx.beginPath();
  ctx.moveTo(cx - maxR, cy); ctx.lineTo(cx + maxR, cy);
  ctx.moveTo(cx, cy - maxR); ctx.lineTo(cx, cy + maxR);
  ctx.stroke();
  ctx.fillStyle = '#94a3b8';
  ctx.font = '700 10px "Inter", -apple-system, sans-serif';
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
    ctx.fillStyle = 'rgba(255, 61, 90, 0.20)';
    ctx.beginPath();
    ctx.moveTo(rmX, rmY);
    lowPts.forEach((p) => { const [x, y] = toXY(p.uKt, p.vKt); ctx.lineTo(x, y); });
    ctx.closePath();
    ctx.fill();
  }

  // Origin -> RM dashed motion vector
  ctx.strokeStyle = 'rgba(250, 204, 21, 0.58)';
  ctx.lineWidth = 1.4;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(rmX, rmY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Height-colored hodograph segments
  ctx.lineWidth = 3.2;
  ctx.lineCap = 'round';
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const [x1, y1] = toXY(a.uKt, a.vKt);
    const [x2, y2] = toXY(b.uKt, b.vKt);
    ctx.strokeStyle = b.heightKm <= 1.2 ? '#ff3d5a' : b.heightKm <= 3.2 ? '#facc15' : '#00d4ff';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  // Points & de-crowded altitude labels
  const placedLabels = [];
  ctx.font = '700 9.5px "Inter", -apple-system, sans-serif';
  pts.forEach((p, idx) => {
    const [x, y] = toXY(p.uKt, p.vKt);
    ctx.fillStyle = '#090d16';
    ctx.beginPath(); ctx.arc(x, y, 4.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = p.heightKm <= 1.2 ? '#ff3d5a' : p.heightKm <= 3.2 ? '#facc15' : '#00d4ff';
    ctx.beginPath(); ctx.arc(x, y, 3.0, 0, Math.PI * 2); ctx.fill();

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
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(p.label, Math.max(6, Math.min(size - 26, lx - 6)), Math.max(12, Math.min(size - 6, ly)));
  });

  // RM Crosshair reticle
  ctx.strokeStyle = '#facc15';
  ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.arc(rmX, rmY, 5.5, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(rmX - 8, rmY); ctx.lineTo(rmX + 8, rmY);
  ctx.moveTo(rmX, rmY - 8); ctx.lineTo(rmX, rmY + 8);
  ctx.stroke();
  ctx.fillStyle = '#facc15';
  ctx.font = '800 10px "Inter", -apple-system, sans-serif';
  ctx.fillText('RM', rmX + 7, rmY + 11);
}

function buildHourlyItems() {
  const nwsHourly = state.nwsBundle?.hourlyPeriods || [];
  if (nwsHourly.length >= 6) {
    return nwsHourly.slice(0, 18).map((p, i) => {
      const d = new Date(p.startTime);
      const label = i === 0 ? 'Now' : d.toLocaleTimeString([], { hour: 'numeric' });
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
  let start = om.time.findIndex((t) => new Date(t).getTime() >= now - 3600000);
  if (start < 0) start = 0;
  return om.time.slice(start, start + 18).map((t, i) => {
    const d = new Date(t);
    const [condText] = wmoInfo(om.weather_code?.[start + i]);
    const hr = d.getHours();
    return {
      time: i === 0 ? 'Now' : d.toLocaleTimeString([], { hour: 'numeric' }),
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
            <span class="metric-sub">${a.expires ? `Exp ${new Date(a.expires).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}</span>
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
            <span class="metric-sub">${sc.intercept.distanceMi.toFixed(1)} mi ${sc.intercept.compassFromUser}</span>
          </div>
          <div class="alert-title">
            ${sc.intercept.etaMinutes ? `Time on Target: ~${sc.intercept.etaMinutes} min` : escapeHtml(sc.intercept.verdictLabel)}
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
    parts.push(`
      <div class="card" style="text-align:center;padding:30px 18px;">
        <div style="display:inline-flex;align-items:center;justify-content:center;width:54px;height:54px;border-radius:16px;background:rgba(16,185,129,0.14);border:1px solid rgba(16,185,129,0.34);color:#34d399;margin-bottom:10px;">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>
        </div>
        <div class="alert-title">All Quiet Across Your Area</div>
        <div class="alert-meta" style="margin-top:6px;">
          No verified supercells, TVS signatures, or NWS warnings detected within 120 miles. Non-convective rain clutter is automatically filtered.
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
        <div class="card-title">${sectionIcon('shield')}Severe Weather Protection Engine</div>
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
        <input type="range" id="set-tot-lead" min="15" max="60" step="5" value="${s.proactiveTotLeadMinutes}" style="width:96px;accent-color:var(--cyan);" />
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
        <input type="range" id="set-freeze-slider" min="28" max="36" value="${s.groundFreezeThresholdF}" style="width:96px;accent-color:var(--cyan);" />
      </div>
    </div>

    <!-- CUSTOM SIREN SELECTOR & SOUND TESTER -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">${sectionIcon('sounding', 'amber')}Tornado &amp; Severe Alert Sirens</div>
        <span class="badge-red">8 Custom WAVs</span>
      </div>
      <div class="alert-meta" style="margin-bottom:10px;">
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
        <div class="card-title">🧪 Test Alert Simulator</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <button id="btn-test-tornado" class="btn-glass-danger">Test Tornado Siren</button>
        <button id="btn-test-tot" class="btn-glass-cyan">Test Storm TOT</button>
        <button id="btn-test-convective" class="btn-glass-violet">Test Convective</button>
        <button id="btn-test-winter" class="btn-glass-blue">Test Black Ice</button>
      </div>
    </div>

    <!-- iPHONE HOME SCREEN GUIDE -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">📱 iPhone Home Screen Setup</div>
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
    const res = await updater.checkForUpdates(false);
    if (res.status === 'UPDATE_AVAILABLE') {
      showToast(`Update v${res.manifest.versionName} available!`);
    } else if (res.status === 'UP_TO_DATE') {
      showToast(`You're on the latest version (v${APP_LOCAL_VERSION.versionName}).`);
    } else {
      showToast(`Update check failed: ${res.error}`);
    }
    renderSettings();
  });

  document.getElementById('btn-apply-update-settings')?.addEventListener('click', () => {
    updater.applyUpdateNow();
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
    state.settings.proactiveTotLeadMinutes = Number(e.target.value);
    saveSettings();
    renderSettings();
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
      if (state.openMeteo && state.current) {
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
    if (state.openMeteo && state.current) {
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
    state.settings.groundFreezeThresholdF = Number(e.target.value);
    saveSettings();
    renderSettings();
    if (state.openMeteo && state.current) {
      state.winter = analyzeWinterSuite(state.openMeteo, state.current, state.settings.groundFreezeThresholdF);
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
  if ('speechSynthesis' in window) {
    try { window.speechSynthesis.cancel(); } catch {}
  }
}

function triggerAlertPopup({ badge, title, body, soundId, loop = false }) {
  audioEngine.unlockForIOS();
  if (navigator.vibrate) {
    try { navigator.vibrate([300, 120, 300, 120, 500]); } catch {}
  }
  document.getElementById('alert-popup-badge').textContent = badge;
  document.getElementById('alert-popup-title').textContent = title;
  document.getElementById('alert-popup-body').textContent = body;
  document.getElementById('alert-popup-modal')?.classList.remove('hidden');
  audioEngine.play(soundId, loop);
  if (String(badge || '').toUpperCase().includes('TORNADO') || String(badge || '').toUpperCase().includes('CRITICAL')) {
    setTimeout(() => speakEmergencyBriefing(title, body), 1200);
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
        state.activeLocation = found;
        state.selectedRadarSite = findNearestNexradStation(found.lat, found.lon).id;
        closeLocationModal();
        radarMap.flyTo(found.lat, found.lon, 8.2, true);
        refreshAllData();
      }
    });
  });

  list.querySelectorAll('[data-del-loc]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.savedLocations = state.savedLocations.filter((l) => l.id !== btn.dataset.delLoc);
      saveLocations();
      if (state.activeLocation.id === btn.dataset.delLoc && state.savedLocations.length) {
        state.activeLocation = state.savedLocations[0];
        refreshAllData();
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
        state.activeLocation = newLoc;
        state.selectedRadarSite = findNearestNexradStation(hit.lat, hit.lon).id;
        closeLocationModal();
        radarMap.flyTo(hit.lat, hit.lon, 8.2, true);
        refreshAllData();
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
        selectRadarProduct('N0B');
      } else {
        loadRadarFramesForCurrentProduct();
      }
      updateHeaderAndBadges();
    });
  });
}
