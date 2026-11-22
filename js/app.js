import {
  RADAR_PRODUCTS,
  buildRadarFrames,
  fetchIemStormIntel,
  fetchNwsAfd,
  fetchNwsAlerts,
  fetchNwsPointBundle,
  fetchOpenMeteo,
  fetchSpcOverlayLayer,
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
    }
  });

  audioEngine.onStateChange = (playingId) => {
    state.activePlayingSoundId = playingId;
    document.getElementById('btn-siren-stop')?.classList.toggle('hidden', !playingId);
    if (state.tab === 'settings') renderSettings();
  };

  wireEvents();
  checkIosInstallBanner();

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

  refreshAllData();
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
    radarMap.flyTo(state.activeLocation.lat, state.activeLocation.lon, 8.2);
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
    document.getElementById(`layer-${key}`)?.addEventListener('change', (e) => {
      radarMap.setLayerVisibility(key, e.target.checked);
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

/* ==================== DATA SYNC ==================== */
async function refreshAllData(silent = false) {
  if (state.isLoading) return;
  state.isLoading = true;
  const refBtn = document.getElementById('btn-refresh');
  if (!silent) refBtn?.classList.add('spinning');

  const { lat, lon } = state.activeLocation;
  const nearest = findNearestNexradStation(lat, lon);
  if (!state.selectedRadarSite) {
    state.selectedRadarSite = nearest.id;
  }

  document.getElementById('header-location-name').textContent = state.activeLocation.name;
  if (!silent) {
    document.getElementById('header-status-sub').textContent = 'Syncing NWS, HRRR/GFS & NEXRAD...';
  }

  try {
    const [nwsRes, omRes, iemRes] = await Promise.allSettled([
      fetchNwsPointBundle(lat, lon),
      fetchOpenMeteo(lat, lon),
      fetchIemStormIntel(state.settings.spcOverlayLayerId || 1)
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
      fetchNwsAfd(state.nwsBundle?.cwa).catch(() => null)
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
    renderDashboard();
    renderAlerts();
    if (state.tab === 'settings') renderSettings();

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
    c.tvs ||
    ((c.intercept.verdict === 'DIRECT_INTERCEPT' || c.intercept.verdict === 'NEAR_MISS') &&
      c.intercept.etaMinutes != null && c.intercept.etaMinutes <= leadMin)
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
      radarMap.flyTo(lat, lon, 8.2);
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
  radarMap.resize();
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
  document.getElementById('radar-frame-time').textContent = 'Loading radar scans...';
  const frames = await buildRadarFrames(prod, site);
  radarMap.setFrames(frames, prod);
  document.getElementById('btn-radar-play').textContent = '▶';
}

function openInspectSheet(type, item) {
  document.getElementById('radar-layers-sheet')?.classList.add('hidden');
  const sheet = document.getElementById('radar-inspect-sheet');
  const titleEl = document.getElementById('inspect-title');
  const bodyEl = document.getElementById('inspect-body');
  if (!sheet || !titleEl || !bodyEl) return;

  if (type === 'cell') {
    titleEl.textContent = `Storm Cell ${item.stormId} (${item.nexrad})`;
    bodyEl.innerHTML = `
      <div class="tag-row">
        <span class="badge-${item.tvs ? 'red' : item.meso ? 'magenta' : 'amber'}">${item.threatLevel.replace('_', ' ')}</span>
        ${item.tvs ? `<span class="badge-red">TVS: ${escapeHtml(item.tvs)}</span>` : ''}
        ${item.meso ? `<span class="badge-magenta">MESO: ${escapeHtml(item.meso)}</span>` : ''}
        ${item.maxHailIn > 0 ? `<span class="badge-amber">Hail ${item.maxHailIn}"</span>` : ''}
        ${item.maxDbz ? `<span class="badge-muted">${item.maxDbz} dBZ</span>` : ''}
      </div>
      <div class="alert-meta">
        <strong>Position:</strong> ${item.intercept.distanceMi.toFixed(1)} mi ${item.intercept.compassFromUser} moving ${item.moveToCompass} @ ${item.speedMph} mph<br/>
        <strong>Intercept:</strong> ${escapeHtml(item.intercept.verdictLabel)}${item.intercept.etaMinutes ? ` • <strong>TOT ~${item.intercept.etaMinutes} min</strong>` : ''}<br/>
        <strong>Storm Top:</strong> ${item.topKft ? `${item.topKft} kft` : '--'} • <strong>Hail Prob:</strong> ${item.poh}% (Severe ${item.posh}%)
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
      <div class="alert-meta">
        <strong>${escapeHtml(item.headline)}</strong><br/><br/>
        ${escapeHtml((item.instruction || item.description || '').slice(0, 520))}
      </div>
    `;
  }
  sheet.classList.remove('hidden');
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
  const topThreatCell = state.stormCells.find((sc) => sc.intercept.verdict === 'DIRECT_INTERCEPT' || sc.tvs);

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
        <div style="font-size:11px;font-weight:800;letter-spacing:.06em;">STORM CELL INTERCEPT</div>
        <div style="font-size:15px;font-weight:800;margin-top:2px;">Cell ${escapeHtml(topThreatCell.stormId)} • ${topThreatCell.intercept.etaMinutes ? `TOT ~${topThreatCell.intercept.etaMinutes} min` : topThreatCell.intercept.verdictLabel}</div>
        <div style="font-size:12px;opacity:.9;margin-top:2px;">${topThreatCell.intercept.distanceMi.toFixed(1)} mi ${topThreatCell.intercept.compassFromUser} moving ${topThreatCell.moveToCompass} @ ${topThreatCell.speedMph} mph</div>
      </div>
      <span style="font-size:18px;font-weight:800;">›</span>
    `;
    strip.onclick = () => {
      switchTab('radar');
      radarMap.flyTo(topThreatCell.lat, topThreatCell.lon, 9.2);
    };
  } else {
    strip.className = 'alert-strip hidden';
  }

  const hourlyItems = buildHourlyItems();
  const dailyItems = (state.nwsBundle?.forecastPeriods || []).slice(0, 10);
  const pTrendSign = c.pressureTrend3h > 0 ? '+' : '';
  const nearestRadar = findNearestNexradStation(state.activeLocation.lat, state.activeLocation.lon);

  container.innerHTML = `
    <!-- HERO CURRENT CONDITIONS -->
    <div class="card hero-card">
      <div class="hero-top">
        <div>
          <div class="hero-temp">${c.tempF != null ? `${c.tempF}°` : '--'}</div>
          <div class="hero-cond">${c.icon} ${escapeHtml(c.conditionText)}</div>
          <div class="hero-feels">Feels like ${c.feelsLikeF ?? '--'}° • Dewpoint ${c.dewpointF ?? '--'}°F</div>
        </div>
        <div class="hero-right">
          <span class="badge-cyan">${c.confidence} Consensus</span>
          <span class="badge-muted">±${c.spreadF}°F spread</span>
          <span class="badge-muted">${nearestRadar.id} (${nearestRadar.distanceMi.toFixed(0)} mi)</span>
        </div>
      </div>

      <div class="metrics-grid">
        <div class="metric-box">
          <div class="metric-label">Wind</div>
          <div class="metric-value">${c.windCompass} ${c.windMph} mph</div>
          <div class="metric-sub">${c.gustMph ? `Gusts ${c.gustMph} mph` : 'Steady'}</div>
        </div>
        <div class="metric-box">
          <div class="metric-label">Humidity</div>
          <div class="metric-value">${c.humidity ?? '--'}%</div>
          <div class="metric-sub">Td ${c.dewpointF ?? '--'}°F</div>
        </div>
        <div class="metric-box">
          <div class="metric-label">Pressure</div>
          <div class="metric-value">${c.pressureInHg}"</div>
          <div class="metric-sub">${pTrendSign}${c.pressureTrend3h} hPa / 3h</div>
        </div>
      </div>

      <div class="consensus-meta">
        <span>${escapeHtml(c.sourceLabel)}</span>
        <span>Vis ${c.visibilityMi} mi</span>
      </div>
    </div>

    <!-- CONVECTIVE & SUPERCELL ENVIRONMENT (PRO 5-LEVEL SOUNDING + STP/SCP/SRH + LIVE HODOGRAPH) -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">⚡ Pro Severe Sounding &amp; HSLC</div>
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
        </div>
        <div class="metric-box">
          <div class="metric-label">Supercell (SCP)</div>
          <div class="metric-value">${(env.scp ?? 0).toFixed(1)}</div>
          <div class="metric-sub">0–3km SRH ${env.srh0to3Km ?? 0}</div>
        </div>
        <div class="metric-box">
          <div class="metric-label">0–1km SRH</div>
          <div class="metric-value">${env.srh0to1Km ?? 0}</div>
          <div class="metric-sub">m²/s² Helicity</div>
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
            <span><i class="hodo-dot" style="background:#ff3d00"></i>0–1km</span>
            <span><i class="hodo-dot" style="background:#00e676"></i>1–3km</span>
            <span><i class="hodo-dot" style="background:#00e5ff"></i>3–6km</span>
          </div>
          <span>${env.veeringDeg >= 0 ? `+${env.veeringDeg}°` : `${env.veeringDeg}°`} veer • ${state.stormCells.length} cells</span>
        </div>
      </div>
    </div>

    <!-- 3-DAY SPC SEVERE & WPC FLASH FLOOD STRIP -->
    ${renderMultiDayOutlookCard(state.multiDaySpc)}

    <!-- LOCAL NWS METEOROLOGIST AREA FORECAST DISCUSSION (AFD) -->
    ${state.afd ? `
      <div class="card" id="afd-preview-card" style="cursor:pointer;">
        <div class="card-header">
          <div class="card-title">📋 ${escapeHtml(state.afd.office)} Meteorologist Discussion</div>
          <span class="badge-muted">${escapeHtml(state.afd.issuedLabel)}</span>
        </div>
        <div class="afd-excerpt">${escapeHtml(state.afd.synopsisExcerpt)}</div>
        <div class="afd-cta">Tap to read full NWS Area Forecast Discussion →</div>
      </div>
    ` : ''}

    <!-- FULL WINTER / GROUND TEMP / FOG SUITE -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">❄️ Winter, Ground Temp &amp; Fog Suite</div>
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
        <div class="card-title">🕒 Next 18 Hours</div>
        <span class="badge-muted">NWS NDFD / HRRR-GFS</span>
      </div>
      <div class="hourly-strip">
        ${hourlyItems.map((h) => `
          <div class="hour-pill">
            <div class="hour-time">${escapeHtml(h.time)}</div>
            <div class="hour-icon">${h.icon}</div>
            <div class="hour-temp">${h.temp}°</div>
            <div class="hour-pop">${h.pop > 0 ? `${h.pop}%` : '&nbsp;'}</div>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- 7-DAY NWS FORECAST -->
    ${dailyItems.length ? `
      <div class="card">
        <div class="card-header">
          <div class="card-title">📅 NWS 7-Day Forecast (NBM + WFO)</div>
          <span class="badge-muted">${escapeHtml(state.nwsBundle?.cwa || 'NWS')}</span>
        </div>
        ${dailyItems.map((p) => `
          <div class="daily-row">
            <div class="daily-name">${escapeHtml(p.name)}</div>
            <div class="daily-desc">${escapeHtml(p.shortForecast)}</div>
            <div class="daily-temp">${p.temperature}°${p.temperatureUnit || 'F'}</div>
          </div>
        `).join('')}
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
  container.querySelector('[data-jump-flood]')?.addEventListener('click', () => {
    switchTab('radar');
    const chk = document.getElementById('layer-flood');
    if (chk) chk.checked = true;
    radarMap.setLayerVisibility('flood', true);
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
        <div class="card-title">⛈️ SPC 3-Day Severe &amp; WPC Flood</div>
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
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(240, rect.width || 300);
  const h = 190;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const pts = env.hodographPoints;
  const cx = w / 2;
  const cy = h / 2;
  const maxR = Math.min(w, h) / 2 - 14;
  const maxSpd = Math.max(...pts.map((p) => Math.hypot(p.uKt, p.vKt)), 20);
  const maxRing = maxSpd > 60 ? 80 : maxSpd > 42 ? 60 : maxSpd > 26 ? 40 : 30;
  const pxPerKt = maxR / maxRing;
  const toXY = (u, v) => [cx + u * pxPerKt, cy - v * pxPerKt];

  // Speed rings
  const step = maxRing <= 30 ? 10 : 20;
  ctx.strokeStyle = '#253549';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#7c8ea6';
  ctx.font = '10px ui-monospace, monospace';
  for (let rk = step; rk <= maxRing; rk += step) {
    const r = rk * pxPerKt;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillText(`${rk}`, cx + r - 14, cy - 3);
  }

  // Axes
  ctx.strokeStyle = '#33445c';
  ctx.beginPath();
  ctx.moveTo(cx - maxR, cy); ctx.lineTo(cx + maxR, cy);
  ctx.moveTo(cx, cy - maxR); ctx.lineTo(cx, cy + maxR);
  ctx.stroke();
  ctx.fillStyle = '#94a3b8';
  ctx.font = 'bold 10px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('N', cx, cy - maxR + 10);
  ctx.fillText('S', cx, cy + maxR - 2);
  ctx.fillText('E', cx + maxR - 7, cy + 4);
  ctx.fillText('W', cx - maxR + 7, cy + 4);
  ctx.textAlign = 'left';

  // Bunkers Right-Mover vector
  const rmRad = ((env.bunkersHeadingDeg || 60) * Math.PI) / 180;
  const rmU = Math.sin(rmRad) * (env.bunkersSpeedKt || 0);
  const rmV = Math.cos(rmRad) * (env.bunkersSpeedKt || 0);
  const [rmX, rmY] = toXY(rmU, rmV);

  // Shaded 0-3km SRH polygon
  const lowPts = pts.filter((p) => p.heightKm <= 3.2);
  if (lowPts.length >= 2) {
    ctx.fillStyle = 'rgba(255, 61, 0, 0.16)';
    ctx.beginPath();
    ctx.moveTo(rmX, rmY);
    lowPts.forEach((p) => { const [x, y] = toXY(p.uKt, p.vKt); ctx.lineTo(x, y); });
    ctx.closePath();
    ctx.fill();
  }

  // Height-colored hodograph segments
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const [x1, y1] = toXY(a.uKt, a.vKt);
    const [x2, y2] = toXY(b.uKt, b.vKt);
    ctx.strokeStyle = b.heightKm <= 1.2 ? '#ff3d00' : b.heightKm <= 3.2 ? '#00e676' : '#00e5ff';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  // Points & altitude labels
  ctx.font = 'bold 9.5px -apple-system, sans-serif';
  pts.forEach((p, idx) => {
    const [x, y] = toXY(p.uKt, p.vKt);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = p.heightKm <= 1.2 ? '#ff5252' : p.heightKm <= 3.2 ? '#00e676' : '#00e5ff';
    ctx.beginPath(); ctx.arc(x, y, 2.7, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#f8fafc';
    const yOff = idx % 2 === 0 ? -6 : 11;
    ctx.fillText(p.label, x + 5, y + yOff);
  });

  // RM Crosshair
  ctx.strokeStyle = '#ffd600';
  ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.arc(rmX, rmY, 5.5, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(rmX - 8, rmY); ctx.lineTo(rmX + 8, rmY);
  ctx.moveTo(rmX, rmY - 8); ctx.lineTo(rmX, rmY + 8);
  ctx.stroke();
  ctx.fillStyle = '#ffd600';
  ctx.font = 'bold 10px -apple-system, sans-serif';
  ctx.fillText('RM', rmX + 7, rmY + 11);
}

function buildHourlyItems() {
  const nwsHourly = state.nwsBundle?.hourlyPeriods || [];
  if (nwsHourly.length >= 6) {
    return nwsHourly.slice(0, 18).map((p, i) => {
      const d = new Date(p.startTime);
      const label = i === 0 ? 'Now' : d.toLocaleTimeString([], { hour: 'numeric' });
      const txt = (p.shortForecast || '').toLowerCase();
      let icon = p.isDaytime ? '🌤️' : '🌙';
      if (txt.includes('thunder')) icon = '⛈️';
      else if (txt.includes('snow') || txt.includes('sleet')) icon = '❄️';
      else if (txt.includes('rain') || txt.includes('shower')) icon = '🌧️';
      else if (txt.includes('fog')) icon = '🌫️';
      else if (txt.includes('cloud')) icon = '☁️';
      else if (txt.includes('sun') || txt.includes('clear')) icon = p.isDaytime ? '☀️' : '🌙';
      return {
        time: label,
        icon,
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
    const [, icon] = wmoInfo(om.weather_code?.[start + i]);
    return {
      time: i === 0 ? 'Now' : d.toLocaleTimeString([], { hour: 'numeric' }),
      icon,
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
    parts.push(`<div class="section-mini-label">Tracked NEXRAD Storm Cells Within 120 mi (${cells.length})</div>`);
    for (const sc of cells.slice(0, 12)) {
      const cls = sc.tvs ? 'tier-critical' : sc.meso ? 'tier-supercell' : '';
      parts.push(`
        <div class="card alert-card ${cls}">
          <div class="card-header" style="margin-bottom:4px;">
            <span class="badge-${sc.tvs ? 'red' : sc.meso ? 'magenta' : 'amber'}">${sc.threatLevel.replace('_', ' ')} • ${escapeHtml(sc.stormId)}</span>
            <span class="metric-sub">${sc.intercept.distanceMi.toFixed(1)} mi ${sc.intercept.compassFromUser}</span>
          </div>
          <div class="alert-title">
            ${sc.intercept.etaMinutes ? `Time on Target: ~${sc.intercept.etaMinutes} min` : escapeHtml(sc.intercept.verdictLabel)}
          </div>
          <div class="alert-meta">
            Moving ${sc.moveToCompass} @ ${sc.speedMph} mph • ${escapeHtml(sc.intercept.verdictLabel)} • Radar ${escapeHtml(sc.nexrad)}
          </div>
          <div class="tag-row">
            ${sc.tvs ? `<span class="badge-red">TVS</span>` : ''}
            ${sc.meso ? `<span class="badge-magenta">MESO ${escapeHtml(sc.meso)}</span>` : ''}
            ${sc.maxHailIn > 0 ? `<span class="badge-amber">Hail ${sc.maxHailIn}"</span>` : ''}
            ${sc.maxDbz ? `<span class="badge-muted">${sc.maxDbz} dBZ</span>` : ''}
            ${sc.topKft ? `<span class="badge-muted">Top ${sc.topKft} kft</span>` : ''}
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
      <div class="card" style="text-align:center;padding:28px 18px;">
        <div style="font-size:34px;margin-bottom:8px;">🛡️</div>
        <div class="alert-title">All Quiet Across Your Area</div>
        <div class="alert-meta" style="margin-top:6px;">
          Active TVS/Mesocyclone detections, approaching storm Time-on-Target vectors, black ice / freezing fog alerts, NWS warnings, and SPC Mesoscale Discussions will appear here automatically.
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
        <div class="card-title">🔄 App Updates (OTA)</div>
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
        <div class="card-title">🌪️ Severe Weather Protection Engine</div>
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
        <div class="card-title">🚨 Tornado &amp; Severe Alert Sirens</div>
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
        <button id="btn-test-tornado" class="btn-danger-sm">Test Tornado Siren</button>
        <button id="btn-test-tot" class="btn-primary-sm">Test Storm TOT</button>
        <button id="btn-test-convective" class="btn-secondary-sm">Test Convective</button>
        <button id="btn-test-winter" class="btn-secondary-sm">Test Black Ice</button>
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
        radarMap.flyTo(found.lat, found.lon, 8.2);
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
        radarMap.flyTo(hit.lat, hit.lon, 8.2);
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
